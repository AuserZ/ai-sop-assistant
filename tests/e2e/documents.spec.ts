import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { z } from "zod";
import { syntheticDocx, syntheticPdf } from "../fixtures/document-files";

const fixture = z.object({
  baseURL: z.literal("http://127.0.0.1:3000"), password: z.string(),
  admin: z.object({ email: z.email() }), staff: z.object({ email: z.email() }),
}).parse(JSON.parse(readFileSync(".local-secrets/browser-fixtures/s02-browser-fixture.json", "utf8")));

async function signIn(page: Page, role: "admin" | "staff" = "admin") {
  const response = await page.request.post("/api/auth/sign-in/email", {
    headers: { Origin: fixture.baseURL }, data: { email: fixture[role].email, password: fixture.password },
  });
  expect(response.status()).toBe(200);
}
async function openUpload(page: Page) {
  await signIn(page);
  await page.goto("/");
  await page.getByRole("link", { name: "List Document SOP" }).click();
  await expect(page.getByRole("heading", { name: "Upload SOP", exact: true })).toBeVisible();
}
async function noOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
}

test("D2 Admin direct PDF upload seals one private original and a parked ingestion intent", async ({ page }) => {
  await openUpload(page);
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.name));
  const directTransfers: Array<Promise<{ origin: string; hasCookie: boolean }>> = [];
  page.on("request", (request) => {
    if (request.method() === "PUT") directTransfers.push(request.allHeaders().then((headers) => ({ origin: new URL(request.url()).origin, hasCookie: Boolean(headers.cookie) })));
  });
  const bytes = syntheticPdf();
  await page.getByLabel("SOP title", { exact: true }).fill("Synthetic PDF upload");
  await page.getByLabel("SOP file", { exact: true }).setInputFiles({ name: "synthetic-upload.pdf", mimeType: "application/pdf", buffer: bytes });
  await page.getByRole("button", { name: "Upload SOP", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Upload saved", exact: true })).toBeVisible();
  await expect(page.getByText("Queued for processing.", { exact: true })).toBeVisible();
  const observedTransfers = await Promise.all(directTransfers);
  expect(observedTransfers.length).toBe(1);
  expect(observedTransfers.every((transfer) => transfer.origin === "http://127.0.0.1:8787" && !transfer.hasCookie)).toBe(true);
  const id = new URL(page.url()).searchParams.get("document");
  expect(z.uuid().safeParse(id).success).toBe(true);
  const response = await page.request.get(`/api/documents/${id}`);
  expect(response.status()).toBe(200);
  const result = await response.json();
  expect(result.document).toMatchObject({ uploadStatus: "ACCEPTED", status: "UPLOADED", sizeBytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"), job: { state: "WAITING_FOR_PIPELINE" } });
  expect(["objectKey", "url", "accessKeyId", "secretAccessKey"].some((key) => key in result.document)).toBe(false);
  expect((await page.request.get(`/api/jobs/${result.document.job.id}/events`)).status()).toBe(404);
  await page.reload();
  await expect(page.getByRole("heading", { name: "Upload saved", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Choose another file", exact: true }).click();
  await expect(page.getByLabel("SOP title", { exact: true })).toHaveValue("");
  expect(new URL(page.url()).searchParams.has("document")).toBe(false);
  await page.getByRole("link", { name: "Back to account" }).click();
  await expect(page.getByRole("region", { name: "Your account" })).toBeVisible();
  expect(pageErrors).toEqual([]);
});

test("D2 DOCX upload reflows at320px and exposes keyboard focus and status", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 720 });
  await openUpload(page);
  await page.getByLabel("SOP title", { exact: true }).focus();
  expect(await page.getByLabel("SOP title", { exact: true }).evaluate((element) => getComputedStyle(element).outlineStyle !== "none")).toBe(true);
  const name = `${"long-synthetic-name-".repeat(8)}.docx`;
  await page.getByLabel("SOP file", { exact: true }).setInputFiles({ name,
    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", buffer: syntheticDocx() });
  await noOverflow(page);
  const buttons = await page.getByRole("button").all();
  for (const button of buttons) expect((await button.boundingBox())?.height).toBeGreaterThanOrEqual(44);
  await page.getByRole("button", { name: "Upload SOP", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "Upload saved", exact: true })).toBeVisible();
  await expect(page.getByText(name, { exact: true })).toBeVisible();
  await noOverflow(page);
});

test("D2 the exact20MB boundary survives browser upload and server sealing", async ({ page }) => {
  test.setTimeout(60_000);
  await openUpload(page);
  const bytes = syntheticPdf(20_000_000);
  await page.getByLabel("SOP title", { exact: true }).fill("Synthetic 20 MB boundary");
  await page.getByLabel("SOP file", { exact: true }).setInputFiles({ name: "synthetic-boundary.pdf", mimeType: "application/pdf", buffer: bytes });
  await page.getByRole("button", { name: "Upload SOP", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Upload saved", exact: true })).toBeVisible({ timeout: 45_000 });
  const id = new URL(page.url()).searchParams.get("document");
  expect(z.uuid().safeParse(id).success).toBe(true);
  const response = await page.request.get(`/api/documents/${id}`);
  expect(response.status()).toBe(200);
  expect((await response.json()).document).toMatchObject({ sizeBytes: 20_000_000, status: "UPLOADED", uploadStatus: "ACCEPTED",
    sha256: createHash("sha256").update(bytes).digest("hex"), job: { state: "WAITING_FOR_PIPELINE" } });
});

test("D2 field validation and safe service failure retry issue no premature success", async ({ page }) => {
  await openUpload(page);
  let initiations = 0;
  page.on("request", (request) => { if (new URL(request.url()).pathname === "/api/documents/upload-init") initiations++; });
  await page.getByRole("button", { name: "Upload SOP", exact: true }).click();
  await expect(page.getByText("Enter the SOP title.", { exact: true })).toBeVisible();
  await page.getByLabel("SOP title", { exact: true }).fill("Synthetic retry upload");
  await page.getByRole("button", { name: "Upload SOP", exact: true }).click();
  await expect(page.getByText("Choose a PDF or DOCX file.", { exact: true })).toBeVisible();
  await page.getByLabel("SOP file", { exact: true }).setInputFiles({ name: "unsupported.txt", mimeType: "text/plain", buffer: Buffer.from("synthetic") });
  await page.getByRole("button", { name: "Upload SOP", exact: true }).click();
  await expect(page.getByText("Choose a PDF or DOCX file.", { exact: true })).toBeVisible();
  await page.getByLabel("SOP file", { exact: true }).setInputFiles({ name: "oversized.pdf", mimeType: "application/pdf", buffer: Buffer.alloc(20_000_001) });
  await page.getByRole("button", { name: "Upload SOP", exact: true }).click();
  await expect(page.getByText("Choose a nonempty file no larger than 20 MB.", { exact: true })).toBeVisible();
  expect(initiations).toBe(0);
  await page.route("**/api/documents/upload-init", async (route) => route.fulfill({ status: 503, contentType: "application/json",
    body: JSON.stringify({ error: { code: "UPLOAD_STORAGE_UNAVAILABLE" } }) }), { times: 1 });
  await page.getByLabel("SOP file", { exact: true }).setInputFiles({ name: "retry.pdf", mimeType: "application/pdf", buffer: syntheticPdf() });
  await page.getByRole("button", { name: "Upload SOP", exact: true }).click();
  await expect(page.getByRole("region", { name: "SOP upload" }).getByRole("alert")).toHaveText("Upload storage is temporarily unavailable. Try again.");
  await expect(page.getByRole("heading", { name: "Upload saved", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Upload SOP", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Upload saved", exact: true })).toBeVisible();
});

test("D2 anonymous and Staff cannot obtain upload authorization or Admin controls", async ({ page }) => {
  const input = { requestKey: randomUUID(), title: "Synthetic access check", fileName: "synthetic.pdf", mimeType: "application/pdf", sizeBytes: 1, sha256: "0".repeat(64) };
  const anonymous = await page.request.post("/api/documents/upload-init", { headers: { Origin: fixture.baseURL }, data: input });
  expect(anonymous.status()).toBe(401);
  await page.goto("/documents");
  await expect(page.getByRole("link", { name: "Sign in", exact: true })).toBeVisible();
  await signIn(page, "staff");
  await page.reload();
  await expect(page.getByText("Only Admins can upload SOPs.", { exact: true })).toBeVisible();
  expect((await page.request.post("/api/documents/upload-init", { headers: { Origin: fixture.baseURL }, data: input })).status()).toBe(403);
  await expect(page.getByLabel("SOP file", { exact: true })).toHaveCount(0);
});
