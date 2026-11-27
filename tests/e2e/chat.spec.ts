import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { z } from "zod";

const fixture = z
  .object({
    baseURL: z.literal("http://127.0.0.1:3000"),
    password: z.string(),
    admin: z.object({ email: z.email() }),
    staff: z.object({ email: z.email() }),
  })
  .parse(
    JSON.parse(readFileSync(".local-secrets/browser-fixtures/s02-browser-fixture.json", "utf8")),
  );

function escapePdfLiteral(line: string): string {
  return line.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

function buildProceduralPdf(lines: string[]): Buffer {
  const ops = lines
    .map((line, index) => `${index === 0 ? "72 720 Td" : "0 -18 Td"} (${escapePdfLiteral(line)}) Tj`)
    .join(" ");
  const content = `BT /F1 12 Tf ${ops} ET\n`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}endstream`,
  ];
  let source = "%PDF-1.7\n";
  const offsets = objects.map((object, index) => {
    const offset = Buffer.byteLength(source);
    source += `${index + 1} 0 obj\n${object}\nendobj\n`;
    return offset;
  });
  const xrefOffset = Buffer.byteLength(source);
  source += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    source += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  source += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(source);
}

async function signIn(page: Page, role: "admin" | "staff") {
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

test("S11 Staff chat streams progress-only before validation, renders cited steps, persists session history, enforces exact fallback, and preserves 320px/3-menu layout", async ({
  page,
}) => {
  test.setTimeout(240_000);
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.name));

  const tag = `S11E2E${randomUUID().slice(0, 6).toUpperCase()}`;
  const sopTitle = `${tag} SOP-711 Valve Calibration`;
  const pdfBytes = buildProceduralPdf([
    `Section 1.1 ${tag} Valve Calibration Procedure`,
    `1. Set line regulator V-14 to 2.75 bar for ${tag} calibration.`,
    `2. Hold pressure for 15 minutes at 75 C before logging readings.`,
    `3. Do not release pressure until gauge stabilizes below 0.3 bar.`,
  ]);

  // 1. Admin uploads and activates a procedural synthetic SOP.
  await signIn(page, "admin");
  const documentId = await uploadAndActivatePdf(page, sopTitle, "s11-valve-calibration.pdf", pdfBytes);

  // 2. Staff signs in and navigates to /chat.
  await signIn(page, "staff");
  await page.goto("/chat");
  await expect(page.getByRole("heading", { name: "SOP Assistant", exact: true })).toBeVisible();

  // Capture raw SSE response from POST /api/chat/messages to verify byte-level stream safety.
  const firstSseResponsePromise = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/chat/messages") && response.request().method() === "POST",
    { timeout: 60_000 },
  );

  await page
    .getByLabel("Ask an SOP question", { exact: true })
    .fill(`What are the ${tag} valve calibration steps and regulator pressure?`);
  await page.getByRole("button", { name: "Send", exact: true }).click();

  const firstSseResponse = await firstSseResponsePromise;
  expect(firstSseResponse.status()).toBe(200);
  expect(firstSseResponse.headers()["content-type"]).toContain("text/event-stream");
  expect(firstSseResponse.headers()["cache-control"]).toContain("no-store");

  const assistantMessage = page.locator('[data-message-role="assistant"][data-outcome="completed"]').first();
  await expect(assistantMessage).toBeVisible({ timeout: 60_000 });
  await expect(assistantMessage.locator("ol li")).toHaveCount(3);
  await expect(assistantMessage).toContainText("2.75 bar");
  await expect(assistantMessage).toContainText("15 minutes");

  // Inspect actual captured SSE frames: zero procedural tokens before terminal completed event!
  const rawSsePayload = await firstSseResponse.text();
  const frames = rawSsePayload
    .split("\n\n")
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk.length > 0 && !chunk.startsWith(":"));
  const completedIndex = frames.findIndex((frame) => frame.includes("event: completed"));
  expect(completedIndex).toBeGreaterThan(0);
  const preTerminalFrames = frames.slice(0, completedIndex);
  for (const frame of preTerminalFrames) {
    expect(frame).not.toContain("2.75 bar");
    expect(frame).not.toContain("V-14");
    expect(frame).not.toContain("15 minutes");
  }

  // Verify timing metrics were measured separately on the workspace DOM.
  const workspace = page.locator('[data-chat-workspace="ready"]');
  const firstProgressMs = Number(await workspace.getAttribute("data-first-progress-ms"));
  const firstAnswerMs = Number(await workspace.getAttribute("data-first-answer-ms"));
  const completedMs = Number(await workspace.getAttribute("data-completed-ms"));
  expect(Number.isFinite(firstProgressMs) && firstProgressMs >= 0).toBe(true);
  expect(Number.isFinite(firstAnswerMs) && firstAnswerMs >= firstProgressMs).toBe(true);
  expect(Number.isFinite(completedMs) && completedMs >= firstAnswerMs).toBe(true);

  // Verify clickable citation requests authorized backend source link and original bytes succeed (200).
  const citationButton = assistantMessage.locator(`button[data-document-id="${documentId}"]`).first();
  await expect(citationButton).toBeVisible();
  const sourceAuthPromise = page.waitForResponse(
    (response) =>
      response.url().includes(`/api/documents/${documentId}/source`) &&
      !response.url().includes("/source/content"),
    { timeout: 15_000 },
  );
  await citationButton.click();
  const sourceAuthResponse = await sourceAuthPromise;
  expect(sourceAuthResponse.status()).toBe(200);
  const sourceUrl = (await sourceAuthResponse.json()).source.url as string;
  expect((await page.request.get(sourceUrl)).status()).toBe(200);

  // 3. Follow-up question in the same session.
  await page
    .getByLabel("Ask an SOP question", { exact: true })
    .fill(`What temperature and duration apply to ${tag} valve calibration?`);
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(
    page.locator('[data-message-role="assistant"][data-outcome="completed"]'),
  ).toHaveCount(2, { timeout: 60_000 });

  // 4. Reload current session -> history persists without P1 past-chat reopen sidebar.
  await page.reload();
  await expect(page.locator('[data-message-role="user"]')).toHaveCount(2, { timeout: 15_000 });
  await expect(
    page.locator('[data-message-role="assistant"][data-outcome="completed"]'),
  ).toHaveCount(2);

  // 5. Unsupported question -> exact fallback with zero citations.
  await page
    .getByLabel("Ask an SOP question", { exact: true })
    .fill("What is the visitor cafeteria lunch voucher reimbursement policy?");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  const fallbackMessage = page.locator('[data-message-role="assistant"][data-outcome="no_evidence"]');
  await expect(fallbackMessage).toBeVisible({ timeout: 60_000 });
  await expect(fallbackMessage).toContainText("No SOP found for this question");
  await expect(fallbackMessage.locator("button")).toHaveCount(0);

  // 6. 320px mobile layout: zero horizontal overflow, >= 44px buttons, <= 3 nav links (Staff sees Chat + List Document SOP).
  await page.setViewportSize({ width: 320, height: 720 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
    ),
  ).toBe(true);
  for (const button of await page.getByRole("button").all()) {
    const box = await button.boundingBox();
    if (box) {
      expect(box.height).toBeGreaterThanOrEqual(44);
    }
  }
  const navLinks = await page.getByRole("link").allTextContents();
  expect(navLinks).toEqual(["Chat", "List Document SOP"]);
  expect(navLinks.length).toBeLessThanOrEqual(3);
  expect(pageErrors).toEqual([]);
});
