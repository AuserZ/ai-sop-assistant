import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { z } from "zod";

const rawFixture = z
  .object({
    baseURL: z.literal("http://127.0.0.1:3000"),
    password: z.string(),
    admin: z.object({ email: z.email() }),
    staff: z.object({ email: z.email() }),
    s13Admin: z.object({ email: z.email() }).optional(),
    s13Staff: z.object({ email: z.email() }).optional(),
  })
  .parse(
    JSON.parse(readFileSync(".local-secrets/browser-fixtures/s02-browser-fixture.json", "utf8")),
  );
const fixture = {
  ...rawFixture,
  admin: rawFixture.s13Admin ?? rawFixture.admin,
  staff: rawFixture.s13Staff ?? rawFixture.staff,
};

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

async function signInViaUi(page: Page, email: string) {
  await page.goto("/sign-in");
  await page.getByLabel("Email", { exact: true }).fill(email);
  await page.getByLabel("Password", { exact: true }).fill(fixture.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("region", { name: "Your account" })).toBeVisible();
}

async function signInViaApi(page: Page, role: "admin" | "staff") {
  const response = await page.request.post("/api/auth/sign-in/email", {
    headers: { Origin: fixture.baseURL },
    data: { email: fixture[role].email, password: fixture.password },
  });
  expect(response.status()).toBe(200);
}

async function assertMobileConstraints(page: Page, expectedMenus: string[]) {
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
    ),
  ).toBe(true);

  const visibleNavLinks = await page
    .getByRole("navigation", { name: "Primary" })
    .getByRole("link")
    .allTextContents();
  expect(visibleNavLinks).toEqual(expectedMenus);

  for (const navLink of await page
    .getByRole("navigation", { name: "Primary" })
    .getByRole("link")
    .all()) {
    const bounds = await navLink.boundingBox();
    expect(bounds?.height).toBeGreaterThanOrEqual(44);
  }

  for (const button of await page.getByRole("button").all()) {
    const bounds = await button.boundingBox();
    if (bounds) {
      expect(bounds.height).toBeGreaterThanOrEqual(44);
    }
  }
}

test("S13 Phase 3 integrated desktop and mobile experience: 3-menu shell, invite/accept, upload->verify->activate, Staff find/download/chat/citations, delete & deactivation", async ({
  browser,
  page,
}) => {
  test.setTimeout(240_000);
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.name));

  const tag = `S13E2E${randomUUID().slice(0, 6).toUpperCase()}`;
  const xssTitle = `<img src=x onerror=window.__s13Xss=1> ${tag} Pump Isolation SOP`;
  const pdfBytes = buildProceduralPdf([
    `Section 2.1 ${tag} Pump Isolation Procedure`,
    `1. Close intake valve P-08 and confirm pressure reads 1.40 bar for ${tag}.`,
    `2. Lock breaker B-12 and wait 10 minutes before draining line.`,
    `3. Verify temperature drops below 45 C before opening cover.`,
  ]);

  await page.setViewportSize({ width: 1280, height: 800 });

  // 1. Admin signs in via UI and sees strictly 3 menus on desktop.
  await signInViaUi(page, fixture.admin.email);
  const adminDesktopMenus = await page
    .getByRole("navigation", { name: "Primary" })
    .getByRole("link")
    .allTextContents();
  expect(adminDesktopMenus).toEqual(["Chat", "List Document SOP", "User Management"]);

  // Verify keyboard Tab moves focus cleanly onto visible interactive controls.
  await page.keyboard.press("Tab");
  expect(await page.evaluate(() => document.activeElement?.tagName)).toBe("BUTTON");

  // 2. Admin navigates to User Management, verifies invitation UI and accept-invitation UI (including XSS-safe name input).
  await page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: "User Management", exact: true }).click();
  await expect(page).toHaveURL(new URL("/users", fixture.baseURL).href);
  await expect(page.getByRole("heading", { level: 1, name: "User Management" })).toBeVisible();

  const syntheticInviteEmail = `s13-invite-${randomUUID().slice(0, 8)}@example.invalid`;
  await page.route("**/api/users/invite", async (route) => {
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({
        invitationId: randomUUID(),
        email: syntheticInviteEmail,
        role: "STAFF",
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      }),
    });
  });
  await page.getByLabel("Email address", { exact: true }).fill(syntheticInviteEmail);
  await page.getByLabel("Role", { exact: true }).selectOption("STAFF");
  await page.getByRole("button", { name: "Send invitation", exact: true }).click();
  await expect(page.getByTestId("invite-status")).toHaveText(
    `Invitation sent to ${syntheticInviteEmail} (Staff).`,
  );
  await page.unroute("**/api/users/invite");

  // Exercise /accept-invitation UI flow in an isolated context without consuming shared S02 tokens.
  const inviteContext = await browser.newContext({ baseURL: fixture.baseURL });
  const invitePage = await inviteContext.newPage();
  try {
    await invitePage.setViewportSize({ width: 320, height: 667 });
    await invitePage.route("**/api/auth/invitations/accept", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ accepted: true }),
      });
    });
    const fakeToken = "A".repeat(43);
    await invitePage.goto(`/accept-invitation#${fakeToken}`);
    await expect(invitePage.getByLabel("Name", { exact: true })).toBeVisible();
    expect(new URL(invitePage.url()).hash).toBe("");
    await invitePage.getByLabel("Name", { exact: true }).fill("<b>Invited Staff</b>");
    await invitePage.getByLabel("Invited email", { exact: true }).fill(syntheticInviteEmail);
    await invitePage.getByLabel("Create password", { exact: true }).fill(fixture.password);
    await invitePage.getByRole("button", { name: "Create account", exact: true }).click();
    await expect(invitePage.getByRole("status")).toHaveText(
      "Your account is ready. Sign in with your invited email and new password.",
    );
    expect(
      await invitePage.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ),
    ).toBe(true);
  } finally {
    await inviteContext.close();
  }

  // 3. Admin navigates to List Document SOP, uploads a synthetic PDF with XSS-like title, reviews in desktop & stacked mobile, and activates.
  await page
    .getByRole("navigation", { name: "Primary" })
    .getByRole("link", { name: "List Document SOP", exact: true })
    .click();
  await expect(page).toHaveURL(new URL("/documents", fixture.baseURL).href);
  await expect(page.getByRole("heading", { name: "Upload SOP", exact: true })).toBeVisible();

  await page.getByLabel("SOP title", { exact: true }).fill(xssTitle);
  await page.getByLabel("SOP file", { exact: true }).setInputFiles({
    name: "s13-pump-isolation.pdf",
    mimeType: "application/pdf",
    buffer: pdfBytes,
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
  // Nested verification maps active menu to List Document SOP (never a 4th menu).
  const activeVerifyLink = page
    .getByRole("navigation", { name: "Primary" })
    .locator('a[aria-current="page"]');
  await expect(activeVerifyLink).toHaveText("List Document SOP");

  // Verify stacked mobile verification pane at 320x667.
  await page.setViewportSize({ width: 320, height: 667 });
  await assertMobileConstraints(page, ["Chat", "List Document SOP", "User Management"]);
  await page.setViewportSize({ width: 1280, height: 800 });

  await page.getByLabel(/I compared the original preview/).check();
  await page.getByRole("button", { name: "Approve and activate SOP", exact: true }).click();
  await expect(page.getByTestId("document-status-badge")).toHaveText("ACTIVE", { timeout: 15_000 });
  expect(await page.evaluate(() => (window as unknown as { __s13Xss?: unknown }).__s13Xss)).toBeUndefined();

  // 4. Staff signs in: sees strictly 2 menus on desktop and mobile, denied /users UI + API 403.
  await signInViaUi(page, fixture.staff.email);
  const staffDesktopMenus = await page
    .getByRole("navigation", { name: "Primary" })
    .getByRole("link")
    .allTextContents();
  expect(staffDesktopMenus).toEqual(["Chat", "List Document SOP"]);

  await page.goto("/users");
  await expect(page.getByRole("main").getByRole("alert")).toHaveText("Admin access required.");
  expect((await page.request.get("/api/users")).status()).toBe(403);

  // 5. Staff finds and downloads SOP in List Document SOP, zero Admin controls.
  await page
    .getByRole("navigation", { name: "Primary" })
    .getByRole("link", { name: "List Document SOP", exact: true })
    .click();
  await page.getByLabel("Search SOP title", { exact: true }).fill(tag);
  await page.getByRole("button", { name: "Search", exact: true }).click();

  const staffRow = page.getByTestId(`library-row-${documentId}`);
  await expect(staffRow).toBeVisible();
  await expect(staffRow).toContainText(xssTitle);
  await expect(page.getByLabel("SOP file", { exact: true })).toHaveCount(0);
  await expect(staffRow.getByRole("button", { name: /Delete SOP/i })).toHaveCount(0);

  const downloadResponsePromise = page.waitForResponse(
    (response) =>
      response.url().includes(`/api/documents/${documentId}/source/content?token=`) &&
      response.request().method() === "GET",
  );
  await staffRow.getByRole("button", { name: "Download original", exact: true }).click();
  expect((await downloadResponsePromise).status()).toBe(200);

  // 6. Staff asks question in Chat (including XSS string), verifies SSE progress-before-answer bytes, Citation Inspector, follow-up, and reload persistence.
  await page
    .getByRole("navigation", { name: "Primary" })
    .getByRole("link", { name: "Chat", exact: true })
    .click();
  await expect(page.getByRole("heading", { name: "SOP Assistant", exact: true })).toBeVisible();

  const ssePromise = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/chat/messages") && response.request().method() === "POST",
    { timeout: 60_000 },
  );
  await page
    .getByLabel("Ask an SOP question", { exact: true })
    .fill(`What are the ${tag} pump isolation steps? <img src=x onerror=window.__s13Xss=1>`);
  await page.getByRole("button", { name: "Send", exact: true }).click();

  const sseResponse = await ssePromise;
  expect(sseResponse.status()).toBe(200);
  expect(sseResponse.headers()["content-type"]).toContain("text/event-stream");

  const assistantMessage = page.locator('[data-message-role="assistant"][data-outcome="completed"]').first();
  await expect(assistantMessage).toBeVisible({ timeout: 60_000 });
  await expect(assistantMessage).toContainText("1.40 bar");

  const rawSse = await sseResponse.text();
  const frames = rawSse
    .split("\n\n")
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk.length > 0 && !chunk.startsWith(":"));
  const completedIdx = frames.findIndex((frame) => frame.includes("event: completed"));
  expect(completedIdx).toBeGreaterThan(0);
  for (const frame of frames.slice(0, completedIdx)) {
    expect(frame).not.toContain("1.40 bar");
    expect(frame).not.toContain("P-08");
  }

  // Click citation chip -> opens Citation Inspector and authorizes source link (200).
  const sourceAuthPromise = page.waitForResponse(
    (response) =>
      response.url().includes(`/api/documents/${documentId}/source`) &&
      !response.url().includes("/source/content"),
    { timeout: 15_000 },
  );
  await assistantMessage.locator(`button[data-document-id="${documentId}"]`).first().click();
  expect((await sourceAuthPromise).status()).toBe(200);
  await expect(page.getByTestId("citation-inspector")).toBeVisible();
  await expect(page.getByTestId("citation-inspector").getByRole("button", { name: "Open source", exact: true })).toBeVisible();

  // Follow-up & reload persistence.
  await page
    .getByLabel("Ask an SOP question", { exact: true })
    .fill(`How long should we wait for ${tag} pump isolation?`);
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(
    page.locator('[data-message-role="assistant"][data-outcome="completed"]'),
  ).toHaveCount(2, { timeout: 60_000 });

  const chatUrl = page.url();
  await page.reload();
  await expect(page.locator('[data-message-role="user"]')).toHaveCount(2, { timeout: 15_000 });
  await expect(
    page.locator('[data-message-role="assistant"][data-outcome="completed"]'),
  ).toHaveCount(2);

  // Mobile 320x667 check for Staff Chat.
  await page.setViewportSize({ width: 320, height: 667 });
  await assertMobileConstraints(page, ["Chat", "List Document SOP"]);
  await page.setViewportSize({ width: 1280, height: 800 });

  expect(await page.evaluate(() => (window as unknown as { __s13Xss?: unknown }).__s13Xss)).toBeUndefined();

  // 7. Admin deletes SOP -> Staff historical citation becomes unavailable.
  await signInViaApi(page, "admin");
  await page.goto("/documents");
  await page.getByLabel("Search SOP title", { exact: true }).fill(tag);
  await page.getByRole("button", { name: "Search", exact: true }).click();
  const adminRow = page.getByTestId(`library-row-${documentId}`);
  await expect(adminRow).toBeVisible();
  await adminRow.getByRole("button", { name: `Delete SOP ${xssTitle}`, exact: true }).click();
  await page.getByTestId(`delete-confirm-${documentId}`).getByRole("button", { name: "Confirm delete", exact: true }).click();
  await expect(page.getByTestId(`library-status-${documentId}`)).toHaveText("DELETED", { timeout: 15_000 });

  await signInViaApi(page, "staff");
  await page.goto(chatUrl);
  await expect(page.locator(`[data-source-unavailable="true"][data-document-id="${documentId}"]`).first()).toBeVisible({
    timeout: 15_000,
  });
  expect((await page.request.get(`/api/documents/${documentId}/source`)).status()).toBe(404);

  // 8. Admin deactivates Staff -> active Staff session immediately blocked on account, documents, and chat, then reactivated cleanly.
  const staffContext = await browser.newContext({ baseURL: fixture.baseURL });
  const staffPage = await staffContext.newPage();
  let staffDeactivated = false;
  let staffUserId: string | null = null;
  try {
    await signInViaApi(staffPage, "staff");
    expect((await staffPage.request.get("/api/account")).status()).toBe(200);

    await signInViaApi(page, "admin");
    await page.goto("/users");
    await page.getByLabel("Search users", { exact: true }).fill(fixture.staff.email);
    await page.getByRole("button", { name: "Search", exact: true }).click();

    const staffDirRow = page
      .locator('[data-testid^="user-row-"]')
      .filter({ hasText: fixture.staff.email });
    await expect(staffDirRow).toBeVisible();
    const rowTestId = await staffDirRow.getAttribute("data-testid");
    staffUserId = rowTestId?.replace(/^user-row-/, "") ?? null;

    await staffDirRow.getByRole("button", { name: "Deactivate", exact: true }).click();
    await expect(staffDirRow).toHaveAttribute("data-user-status", "INACTIVE");
    staffDeactivated = true;

    expect((await staffPage.request.get("/api/account")).status()).toBe(401);
    expect((await staffPage.request.get("/api/documents")).status()).toBe(401);
    expect(
      (
        await staffPage.request.post("/api/chat/messages", {
          headers: { Origin: fixture.baseURL },
          data: { requestKey: randomUUID(), question: "Are SOPs accessible?" },
        })
      ).status(),
    ).toBe(401);

    // Restore Staff active state so shared fixture stays clean.
    await staffDirRow.getByRole("button", { name: "Reactivate", exact: true }).click();
    await expect(staffDirRow).toHaveAttribute("data-user-status", "ACTIVE");
    staffDeactivated = false;
  } finally {
    if (staffDeactivated) {
      await signInViaApi(page, "admin").catch(() => undefined);
      let targetId = staffUserId;
      if (!targetId) {
        const listRes = await page.request
          .get(`/api/users?q=${encodeURIComponent(fixture.staff.email)}`)
          .catch(() => null);
        if (listRes?.ok()) {
          const payload = (await listRes.json().catch(() => null)) as {
            users?: Array<{ id: string; email: string }>;
          } | null;
          targetId = payload?.users?.find((u) => u.email === fixture.staff.email)?.id ?? null;
        }
      }
      if (targetId) {
        await page.request
          .patch(`/api/users/${encodeURIComponent(targetId)}`, {
            headers: { Origin: fixture.baseURL },
            data: { active: true },
          })
          .catch(() => undefined);
      }
    }
    await staffContext.close();
  }

  expect(pageErrors).toEqual([]);
});
