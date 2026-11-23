import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { z } from "zod";
import { syntheticPdf } from "../fixtures/document-files";

const fixture = z
  .object({
    baseURL: z.literal("http://127.0.0.1:3000"),
    password: z.string(),
    admin: z.object({ email: z.email() }),
    staff: z.object({ email: z.email() }),
  })
  .parse(JSON.parse(readFileSync(".local-secrets/browser-fixtures/s02-browser-fixture.json", "utf8")));

async function signIn(page: Page, role: "admin" | "staff" = "admin") {
  const response = await page.request.post("/api/auth/sign-in/email", {
    headers: { Origin: fixture.baseURL },
    data: { email: fixture[role].email, password: fixture.password },
  });
  expect(response.status()).toBe(200);
}

async function uploadToPendingVerification(
  page: Page,
  title: string,
  fileName: string,
  bytes: Buffer,
): Promise<string> {
  await page.goto("/documents");
  await expect(page.getByRole("heading", { name: "Upload SOP", exact: true })).toBeVisible();
  await page.getByLabel("SOP title", { exact: true }).fill(title);
  await page.getByLabel("SOP file", { exact: true }).setInputFiles({
    name: fileName,
    mimeType: "application/pdf",
    buffer: bytes,
  });
  await page.getByRole("button", { name: "Upload SOP", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Upload saved", exact: true })).toBeVisible({
    timeout: 30_000,
  });

  const documentId = new URL(page.url()).searchParams.get("document");
  expect(z.uuid().safeParse(documentId).success).toBe(true);

  await expect
    .poll(
      async () => {
        const res = await page.request.get(`/api/documents/${documentId}`);
        if (!res.ok()) return null;
        return (await res.json()).document?.status ?? null;
      },
      { timeout: 120_000, intervals: [500, 1000, 2000] },
    )
    .toBe("PENDING_VERIFICATION");

  return documentId!;
}

test("S07 Admin library diagnostics and Staff ACTIVE-only search, keyboard operation, signed original access and 320px reflow", async ({
  page,
}) => {
  test.setTimeout(210_000);
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.name));

  const tag = `S07-${randomUUID().slice(0, 8)}`;
  const activeTitle = `${tag} Verified Valve Lockout`;
  const pendingTitle = `${tag} Unverified Draft Procedure`;
  const activeBytes = syntheticPdf();
  const activeSha256 = createHash("sha256").update(activeBytes).digest("hex");
  const pendingBytes = syntheticPdf();

  // 1. Admin uploads two SOPs and activates only the first one.
  await signIn(page, "admin");
  const activeId = await uploadToPendingVerification(
    page,
    activeTitle,
    "s07-active-lockout.pdf",
    activeBytes,
  );

  await page.goto(`/documents/${activeId}/verify`);
  await expect(page.getByTestId("document-status-badge")).toHaveText("PENDING_VERIFICATION");
  await page.getByLabel(/I compared the original preview/).check();
  await page.getByRole("button", { name: "Approve and activate SOP", exact: true }).click();
  await expect(page.getByTestId("document-status-badge")).toHaveText("ACTIVE", { timeout: 15_000 });

  const pendingId = await uploadToPendingVerification(
    page,
    pendingTitle,
    "s07-pending-draft.pdf",
    pendingBytes,
  );

  // 2. Admin visits List Document SOP library, filters by tag and sees both ACTIVE and PENDING_VERIFICATION with diagnostics.
  await page.goto("/documents");
  const libraryRegion = page.getByRole("region", { name: "SOP library" });
  await expect(libraryRegion).toBeVisible();

  const searchInput = page.getByLabel("Search SOP title", { exact: true });
  await searchInput.fill(tag);
  await page.getByRole("button", { name: "Search", exact: true }).click();

  await expect(page.getByTestId(`library-row-${activeId}`)).toBeVisible();
  await expect(page.getByTestId(`library-row-${pendingId}`)).toBeVisible();
  await expect(page.getByTestId(`library-status-${activeId}`)).toHaveText("ACTIVE");
  await expect(page.getByTestId(`library-status-${pendingId}`)).toHaveText("PENDING_VERIFICATION");
  await expect(page.getByTestId(`library-diagnostics-${activeId}`)).toContainText("Job: COMPLETED");
  await expect(page.getByTestId(`library-diagnostics-${pendingId}`)).toContainText("Job: COMPLETED");
  await expect(
    page.getByRole("link", { name: `Review and verify ${pendingTitle}`, exact: true }),
  ).toHaveAttribute("href", `/documents/${pendingId}/verify`);

  // Capture an Admin-issued source URL to verify Staff cannot replay it.
  const adminSourceRes = await page.request.get(`/api/documents/${activeId}/source?disposition=inline`);
  expect(adminSourceRes.status()).toBe(200);
  const adminSourceUrl = (await adminSourceRes.json()).source.url as string;

  // 3. Staff signs in, navigates to /documents with genuine section/page context, and searches by keyboard (Enter).
  await signIn(page, "staff");
  await page.goto(`/documents?page=1&section=${encodeURIComponent("Section 1 Lockout")}`);
  await expect(page.getByText("Only Admins can upload SOPs.", { exact: true })).toBeVisible();
  await expect(page.getByTestId("library-source-context")).toHaveText(
    "Source context: Section: Section 1 Lockout · Page 1",
  );

  const staffSearchInput = page.getByLabel("Search SOP title", { exact: true });
  await staffSearchInput.focus();
  expect(
    await staffSearchInput.evaluate((element) => getComputedStyle(element).outlineStyle !== "none"),
  ).toBe(true);
  await page.keyboard.type(tag);
  await page.keyboard.press("Enter");

  await expect(page.getByTestId("library-count-status")).toHaveText(
    `1 SOP document shown for "${tag}".`,
  );
  await expect(page.getByTestId(`library-row-${activeId}`)).toBeVisible();
  await expect(page.getByTestId(`library-row-${pendingId}`)).toHaveCount(0);
  await expect(page.getByTestId(`library-diagnostics-${activeId}`)).toHaveCount(0);
  await expect(page.getByText(pendingTitle)).toHaveCount(0);

  // 4. Staff clicks "Open original" (inline) and "Download original" (attachment) and receives exact original bytes and security headers.
  const activeRow = page.getByTestId(`library-row-${activeId}`);
  const inlineContentPromise = page.waitForResponse(
    (response) =>
      response.url().includes(`/api/documents/${activeId}/source/content?token=`) &&
      response.request().method() === "GET",
  );
  await activeRow.getByRole("button", { name: "Open original", exact: true }).click();
  const inlineContentResponse = await inlineContentPromise;
  expect(inlineContentResponse.status()).toBe(200);
  expect(inlineContentResponse.headers()["content-type"]).toBe("application/pdf");
  expect(inlineContentResponse.headers()["content-disposition"]).toContain("inline;");
  expect(inlineContentResponse.headers()["content-disposition"]).toContain("s07-active-lockout.pdf");
  expect(inlineContentResponse.headers()["cache-control"]).toBe("private, no-store");
  expect(inlineContentResponse.headers()["x-content-type-options"]).toBe("nosniff");
  expect(inlineContentResponse.headers()["x-frame-options"]).toBe("DENY");
  expect(inlineContentResponse.headers()["cross-origin-resource-policy"]).toBe("same-origin");
  expect(inlineContentResponse.headers()["referrer-policy"]).toBe("no-referrer");
  const inlineBytes = await inlineContentResponse.body();
  expect(createHash("sha256").update(inlineBytes).digest("hex")).toBe(activeSha256);

  await expect(page.getByTestId("source-access-status")).toContainText(
    `Opened original s07-active-lockout.pdf (${activeBytes.length} bytes) — Section: Section 1 Lockout · Page 1. Signed access expires in 60s.`,
  );

  const attachmentContentPromise = page.waitForResponse(
    (response) =>
      response.url().includes(`/api/documents/${activeId}/source/content?token=`) &&
      response.request().method() === "GET",
  );
  await activeRow.getByRole("button", { name: "Download original", exact: true }).click();
  const attachmentContentResponse = await attachmentContentPromise;
  expect(attachmentContentResponse.status()).toBe(200);
  expect(attachmentContentResponse.headers()["content-disposition"]).toContain("attachment;");
  expect(createHash("sha256").update(await attachmentContentResponse.body()).digest("hex")).toBe(
    activeSha256,
  );
  await expect(page.getByTestId("source-access-status")).toContainText(
    `Downloaded original s07-active-lockout.pdf (${activeBytes.length} bytes)`,
  );

  // 5. Staff cannot access non-ACTIVE source (404), guessed source (404), Admin preview (403) or replay Admin's source token (403).
  expect((await page.request.get(`/api/documents/${pendingId}/source`)).status()).toBe(404);
  expect((await page.request.get(`/api/documents/${randomUUID()}/source`)).status()).toBe(404);
  expect((await page.request.get(`/api/documents/${activeId}/preview`)).status()).toBe(403);
  expect((await page.request.get(adminSourceUrl)).status()).toBe(403);

  // 6. Mobile 320px check: zero horizontal overflow, min-h-11 interactive controls, and no fourth menu.
  await page.setViewportSize({ width: 320, height: 720 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
    ),
  ).toBe(true);
  for (const button of await page.getByRole("button").all()) {
    expect((await button.boundingBox())?.height).toBeGreaterThanOrEqual(44);
  }
  const navLinks = await page.getByRole("link").allTextContents();
  expect(navLinks.length).toBeLessThanOrEqual(3);
  expect(pageErrors).toEqual([]);
});
