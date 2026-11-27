import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { z } from "zod";
import { syntheticPdf } from "../fixtures/document-files";

const rawFixture = z
  .object({
    baseURL: z.literal("http://127.0.0.1:3000"),
    password: z.string(),
    admin: z.object({ email: z.email() }),
    staff: z.object({ email: z.email() }),
    deletionAdmin: z.object({ email: z.email() }).optional(),
    deletionStaff: z.object({ email: z.email() }).optional(),
  })
  .parse(JSON.parse(readFileSync(".local-secrets/browser-fixtures/s02-browser-fixture.json", "utf8")));
const fixture = {
  ...rawFixture,
  admin: rawFixture.deletionAdmin ?? rawFixture.admin,
  staff: rawFixture.deletionStaff ?? rawFixture.staff,
};

async function signIn(page: Page, role: "admin" | "staff" = "admin") {
  const response = await page.request.post("/api/auth/sign-in/email", {
    headers: { Origin: fixture.baseURL },
    data: { email: fixture[role].email, password: fixture.password },
  });
  expect(response.status()).toBe(200);
}

async function uploadAndActivatePdf(
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

  await page.goto(`/documents/${documentId}/verify`);
  await expect(page.getByTestId("document-status-badge")).toHaveText("PENDING_VERIFICATION");
  await page.getByLabel(/I compared the original preview/).check();
  await page.getByRole("button", { name: "Approve and activate SOP", exact: true }).click();
  await expect(page.getByTestId("document-status-badge")).toHaveText("ACTIVE", { timeout: 15_000 });

  return documentId!;
}

test("S08 Admin SOP deletion commits DELETED tombstone, converges cleanup, revokes Staff access and preserves 320px/3-menu layout", async ({
  page,
}) => {
  test.setTimeout(210_000);
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.name));

  const tag = `S08-${randomUUID().slice(0, 8)}`;
  const title = `${tag} Boiler Purge SOP`;
  const pdfBytes = syntheticPdf();

  // 1. Admin uploads and activates a synthetic PDF SOP.
  await signIn(page, "admin");
  const documentId = await uploadAndActivatePdf(page, title, "s08-boiler-purge.pdf", pdfBytes);

  // 2. Staff sees it in List Document SOP, opens original, captures a signed source URL, and is denied DELETE (403).
  await signIn(page, "staff");
  await page.goto("/documents");
  await page.getByLabel("Search SOP title", { exact: true }).fill(tag);
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(page.getByTestId("library-count-status")).toHaveText(
    `1 SOP document shown for "${tag}".`,
  );

  const staffRow = page.getByTestId(`library-row-${documentId}`);
  await expect(staffRow).toBeVisible();
  await expect(staffRow.getByRole("button", { name: /Delete SOP/i })).toHaveCount(0);

  const preDeleteSourceRes = await page.request.get(`/api/documents/${documentId}/source?disposition=inline`);
  expect(preDeleteSourceRes.status()).toBe(200);
  const preDeleteSourceUrl = (await preDeleteSourceRes.json()).source.url as string;
  expect((await page.request.get(preDeleteSourceUrl)).status()).toBe(200);

  const staffDeleteRes = await page.request.delete(`/api/documents/${documentId}`, {
    headers: { Origin: fixture.baseURL },
  });
  expect(staffDeleteRes.status()).toBe(403);

  // 3. Admin deletes the SOP from List Document SOP with inline backup-retention confirmation.
  await signIn(page, "admin");
  await page.goto("/documents");
  await page.getByLabel("Search SOP title", { exact: true }).fill(tag);
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(page.getByTestId("library-count-status")).toHaveText(
    `1 SOP document shown for "${tag}".`,
  );

  const adminRow = page.getByTestId(`library-row-${documentId}`);
  await expect(adminRow).toBeVisible();
  await adminRow.getByRole("button", { name: `Delete SOP ${title}`, exact: true }).click();

  const confirmBox = page.getByTestId(`delete-confirm-${documentId}`);
  await expect(confirmBox).toBeVisible();
  await expect(confirmBox).toContainText(
    "Deleting removes retrieval and source access immediately. Approved backup retention may outlast live deletion.",
  );

  await confirmBox.getByRole("button", { name: "Confirm delete", exact: true }).click();
  await expect(page.getByTestId(`library-status-${documentId}`)).toHaveText("DELETED", {
    timeout: 15_000,
  });
  await expect(adminRow.getByRole("button", { name: "Open original", exact: true })).toHaveCount(0);
  await expect(adminRow.getByRole("button", { name: "Download original", exact: true })).toHaveCount(0);
  await expect(adminRow.getByRole("link", { name: /Review and verify/i })).toHaveCount(0);

  // Wait for background cleanup reconciliation to converge to Cleanup: COMPLETED.
  await expect(page.getByTestId(`library-cleanup-${documentId}`)).toHaveText("Cleanup: COMPLETED", {
    timeout: 30_000,
  });

  // Admin source and preview access are now unavailable (404).
  expect((await page.request.get(`/api/documents/${documentId}/source`)).status()).toBe(404);
  expect((await page.request.get(`/api/documents/${documentId}/preview`)).status()).toBe(404);

  // 4. Staff search no longer shows the deleted SOP and both previously issued and fresh source URLs fail (404).
  await signIn(page, "staff");
  await page.goto("/documents");
  await page.getByLabel("Search SOP title", { exact: true }).fill(tag);
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(page.getByTestId("library-count-status")).toHaveText(
    `0 SOP documents shown for "${tag}".`,
  );

  await expect(page.getByTestId(`library-row-${documentId}`)).toHaveCount(0);
  await expect(page.getByTestId("library-empty-state")).toBeVisible();
  expect((await page.request.get(preDeleteSourceUrl)).status()).toBe(404);
  expect((await page.request.get(`/api/documents/${documentId}/source`)).status()).toBe(404);

  // 5. Mobile 320px zero horizontal overflow, min-h-11 buttons, and <= 3 nav links.
  await signIn(page, "admin");
  await page.goto("/documents");
  await page.getByLabel("Search SOP title", { exact: true }).fill(tag);
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(page.getByTestId("library-count-status")).toHaveText(
    `1 SOP document shown for "${tag}".`,
  );
  await expect(page.getByTestId(`library-row-${documentId}`)).toBeVisible();

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
