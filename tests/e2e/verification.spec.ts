import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { z } from "zod";
import { syntheticPdf, syntheticRichDocx } from "../fixtures/document-files";

const fixture = z.object({
  baseURL: z.literal("http://127.0.0.1:3000"),
  password: z.string(),
  admin: z.object({ email: z.email() }),
  staff: z.object({ email: z.email() }),
}).parse(JSON.parse(readFileSync(".local-secrets/browser-fixtures/s02-browser-fixture.json", "utf8")));

async function signIn(page: Page, role: "admin" | "staff" = "admin") {
  const response = await page.request.post("/api/auth/sign-in/email", {
    headers: { Origin: fixture.baseURL },
    data: { email: fixture[role].email, password: fixture.password },
  });
  expect(response.status()).toBe(200);
}

async function uploadAndWaitForReview(
  page: Page,
  title: string,
  name: string,
  mimeType: string,
  buffer: Buffer,
) {
  await page.goto("/documents");
  await expect(page.getByRole("heading", { name: "Upload SOP", exact: true })).toBeVisible();
  await page.getByLabel("SOP title", { exact: true }).fill(title);
  await page.getByLabel("SOP file", { exact: true }).setInputFiles({ name, mimeType, buffer });
  await page.getByRole("button", { name: "Upload SOP", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Upload saved", exact: true })).toBeVisible({ timeout: 30_000 });

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

  await page.getByRole("button", { name: "Refresh status", exact: true }).click();
  await expect(page.getByRole("link", { name: "Review and verify", exact: true })).toBeVisible();
  await page.getByRole("link", { name: "Review and verify", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/documents/${documentId}/verify$`));
  return documentId!;
}

test("S06 Admin assisted verification workspace: PDF zoom/reject/reprocess/approve, DOCX derivative/issues, 320px reflow and Staff denial", async ({ page }) => {
  test.setTimeout(210_000);
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.name));

  await signIn(page, "admin");
  const pdfId = await uploadAndWaitForReview(
    page,
    "Synthetic S06 Verification PDF",
    "s06-verify-flow.pdf",
    "application/pdf",
    syntheticPdf(),
  );

  await expect(page.getByTestId("document-status-badge")).toHaveText("PENDING_VERIFICATION");

  const canvas = page.locator("canvas[aria-label^='PDF preview canvas']");
  await expect(canvas).toBeVisible({ timeout: 30_000 });
  await expect
    .poll(async () => canvas.evaluate((element: HTMLCanvasElement) => element.width > 0 && element.height > 0))
    .toBe(true);
  await expect(page.getByText("Page 1 of 1", { exact: true })).toBeVisible();

  const initialWidth = (await canvas.boundingBox())?.width ?? 0;
  expect(initialWidth).toBeGreaterThan(0);
  await page.getByRole("button", { name: "Zoom in", exact: true }).click();
  await expect(page.getByText("125%", { exact: true })).toBeVisible();
  await expect
    .poll(async () => (await canvas.boundingBox())?.width ?? 0)
    .toBeGreaterThan(initialWidth);
  await page.getByRole("button", { name: "Reset zoom", exact: true }).click();
  await expect(page.getByText("100%", { exact: true })).toBeVisible();

  await page.getByLabel("Search extracted text", { exact: true }).fill("Synthetic SOP");
  await expect(page.getByText(/1 match/, { exact: false })).toBeVisible();
  await page.getByRole("tab", { name: /^Chunks/ }).click();
  await expect(page.getByText("Synthetic SOP upload fixture", { exact: false })).toBeVisible();
  await page.getByLabel("Search extracted text", { exact: true }).fill("");

  await page.setViewportSize({ width: 320, height: 720 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await page.setViewportSize({ width: 1280, height: 800 });

  await page.getByLabel(/I compared the original preview/).check();
  await page.getByLabel("Verification notes (required to reject)", { exact: true }).fill("Rejecting first pass to test controlled reprocessing.");
  await page.getByRole("button", { name: "Reject extraction", exact: true }).click();
  await expect(page.getByTestId("document-status-badge")).toHaveText("REJECTED", { timeout: 15_000 });

  await page.getByRole("tab", { name: /^Audit history/ }).click();
  await expect(page.getByText("REJECTED (PENDING_VERIFICATION → REJECTED)", { exact: true })).toBeVisible();
  await expect(page.getByText("Rejecting first pass to test controlled reprocessing.", { exact: true }).first()).toBeVisible();

  await page.getByRole("button", { name: "Reprocess document", exact: true }).click();
  await expect(page.getByTestId("document-status-badge")).toHaveText("PENDING_VERIFICATION", { timeout: 120_000 });

  await page.getByLabel(/I compared the original preview/).check();
  await page.getByLabel("Verification notes (required to reject)", { exact: true }).fill("Approved after renewed extraction check.");
  await page.getByRole("button", { name: "Approve and activate SOP", exact: true }).click();
  await expect(page.getByTestId("document-status-badge")).toHaveText("ACTIVE", { timeout: 15_000 });
  await expect(page.getByRole("button", { name: "Reprocess document", exact: true })).toHaveCount(0);

  await page.getByRole("tab", { name: /^Audit history/ }).click();
  await expect(page.getByText("APPROVED (PENDING_VERIFICATION → ACTIVE)", { exact: true })).toBeVisible();
  await expect(page.getByText("REJECTED (PENDING_VERIFICATION → REJECTED)", { exact: true })).toBeVisible();

  await page.setViewportSize({ width: 320, height: 720 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await page.setViewportSize({ width: 1280, height: 800 });

  const docxId = await uploadAndWaitForReview(
    page,
    "Synthetic S06 Verification DOCX",
    "s06-verify-rich.docx",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    syntheticRichDocx(),
  );
  await expect(page.getByText(/DOCX derivative PDF preview: page breaks are approximate/i)).toBeVisible();
  const docxCanvas = page.locator("canvas[aria-label^='PDF preview canvas']");
  await expect(docxCanvas).toBeVisible({ timeout: 30_000 });
  await expect
    .poll(async () => docxCanvas.evaluate((element: HTMLCanvasElement) => element.width > 0 && element.height > 0))
    .toBe(true);

  const issueCheckboxes = page.locator("input[id^='issue-']");
  expect(await issueCheckboxes.count()).toBeGreaterThanOrEqual(2);
  await issueCheckboxes.first().check();
  await page.getByRole("button", { name: "Page 1", exact: true }).first().click();

  await page.getByLabel(/I compared the original preview/).check();
  await page.getByRole("button", { name: "Approve and activate SOP", exact: true }).click();
  await expect(page.getByTestId("document-status-badge")).toHaveText("ACTIVE", { timeout: 15_000 });

  await signIn(page, "staff");
  for (const id of [pdfId, docxId]) {
    expect((await page.request.get(`/api/documents/${id}/review`)).status()).toBe(403);
    expect((await page.request.get(`/api/documents/${id}/preview`)).status()).toBe(403);
    expect(
      (
        await page.request.post(`/api/documents/${id}/verify`, {
          headers: { Origin: fixture.baseURL },
          data: {},
        })
      ).status(),
    ).toBe(403);
    expect(
      (
        await page.request.post(`/api/documents/${id}/reprocess`, {
          headers: { Origin: fixture.baseURL },
          data: {},
        })
      ).status(),
    ).toBe(403);
  }

  await page.goto(`/documents/${pdfId}/verify`);
  await expect(page.getByText("Only Admins can verify SOPs.", { exact: true })).toBeVisible();
  expect(pageErrors).toEqual([]);
});
