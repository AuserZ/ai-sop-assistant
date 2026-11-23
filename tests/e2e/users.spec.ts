import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { z } from "zod";

const fixture = z
  .object({
    baseURL: z.literal("http://127.0.0.1:3000"),
    password: z.string(),
    admin: z.object({ id: z.string().optional(), email: z.email() }),
    staff: z.object({ id: z.string().optional(), email: z.email() }),
  })
  .parse(
    JSON.parse(readFileSync(".local-secrets/browser-fixtures/s02-browser-fixture.json", "utf8")),
  );

async function signInApi(page: Page, role: "admin" | "staff") {
  const response = await page.request.post("/api/auth/sign-in/email", {
    headers: { Origin: fixture.baseURL },
    data: { email: fixture[role].email, password: fixture.password },
  });
  expect(response.status()).toBe(200);
}

test("S12 Admin manages user directory, roles, invitations and deactivation while Staff is denied and 3-menu / 320px invariants hold", async ({
  browser,
  page,
}) => {
  test.setTimeout(120_000);
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.name));

  // 1. Staff sees only 2 top-level navigation links on home and is denied /users (UI + API 403).
  await signInApi(page, "staff");
  await page.goto("/");
  await expect(page.getByRole("region", { name: "Your account" })).toBeVisible();
  const staffHomeNavLinks = await page
    .getByRole("navigation", { name: "Primary" })
    .getByRole("link")
    .allTextContents();
  expect(staffHomeNavLinks).toEqual(["Chat", "List Document SOP"]);

  await page.goto("/users");
  await expect(page.getByRole("alert")).toHaveText("Admin access required.");
  await expect(page.getByTestId("users-directory-list")).toHaveCount(0);
  expect((await page.request.get("/api/users")).status()).toBe(403);

  // 2. Admin sees strictly 3 top-level menus on home and navigates to User Management.
  await signInApi(page, "admin");
  await page.goto("/");
  const adminHomeNavLinks = await page
    .getByRole("navigation", { name: "Primary" })
    .getByRole("link")
    .allTextContents();
  expect(adminHomeNavLinks).toEqual(["Chat", "List Document SOP", "User Management"]);
  await page.getByRole("link", { name: "User Management", exact: true }).click();
  await expect(page).toHaveURL(new URL("/users", fixture.baseURL).href);
  await expect(page.getByRole("heading", { level: 1, name: "User Management" })).toBeVisible();

  // Verify <= 3 navigation links on /users.
  const usersPageLinks = await page.getByRole("link").allTextContents();
  expect(usersPageLinks.length).toBeLessThanOrEqual(3);

  // Verify summary badges are rendered.
  await expect(page.getByTestId("summary-total-users")).toBeVisible();
  await expect(page.getByTestId("summary-active-users")).toBeVisible();
  await expect(page.getByTestId("summary-active-admins")).toBeVisible();

  // 3. Invite form: existing account returns 409 ACCOUNT_EXISTS from real backend; new invite updates status.
  await page.getByLabel("Email address", { exact: true }).fill(fixture.staff.email);
  await page.getByLabel("Role", { exact: true }).selectOption("STAFF");
  await page.getByRole("button", { name: "Send invitation", exact: true }).click();
  await expect(page.getByTestId("invite-error")).toHaveText(
    "An account with this email address already exists.",
  );

  const syntheticInviteEmail = `s12-e2e-${randomUUID().slice(0, 8)}@example.invalid`;
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
  await page.getByRole("button", { name: "Send invitation", exact: true }).click();
  await expect(page.getByTestId("invite-status")).toHaveText(
    `Invitation sent to ${syntheticInviteEmail} (Staff).`,
  );
  await page.unroute("**/api/users/invite");

  // 4. Search & filter for the Staff user, verify self-row protection for Admin.
  await page.getByLabel("Search users", { exact: true }).fill(fixture.admin.email);
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(page.getByTestId("users-count-status")).toHaveText(
    `1 user shown for "${fixture.admin.email}".`,
  );
  const adminRow = page
    .locator('[data-testid^="user-row-"]')
    .filter({ hasText: fixture.admin.email });
  await expect(adminRow).toContainText("Current Admin (you)");
  await expect(adminRow.getByRole("button", { name: "Make Staff", exact: true })).toBeDisabled();
  await expect(adminRow.getByRole("button", { name: "Deactivate", exact: true })).toBeDisabled();

  await page.getByRole("button", { name: "Clear", exact: true }).click();
  await page.getByLabel("Search users", { exact: true }).fill(fixture.staff.email);
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(page.getByTestId("users-count-status")).toHaveText(
    `1 user shown for "${fixture.staff.email}".`,
  );

  const staffRow = page
    .locator('[data-testid^="user-row-"]')
    .filter({ hasText: fixture.staff.email });
  await expect(staffRow).toBeVisible();

  // 5. Open a second browser context signed in as Staff before role change & deactivation.
  const staffContext = await browser.newContext();
  const staffPage = await staffContext.newPage();
  try {
    await signInApi(staffPage, "staff");
    expect((await staffPage.request.get("/api/account")).status()).toBe(200);

    // Admin promotes Staff -> Admin, then back to Staff.
    await staffRow.getByRole("button", { name: "Make Admin", exact: true }).click();
    await expect(page.getByTestId("user-action-status")).toContainText("Admin, Active");
    await expect(staffRow).toHaveAttribute("data-user-role", "ADMIN");

    // Staff's pre-change session was immediately revoked by role change.
    expect((await staffPage.request.get("/api/account")).status()).toBe(401);

    // Restore role back to STAFF.
    await staffRow.getByRole("button", { name: "Make Staff", exact: true }).click();
    await expect(page.getByTestId("user-action-status")).toContainText("Staff, Active");
    await expect(staffRow).toHaveAttribute("data-user-role", "STAFF");

    // Staff signs in again, then Admin deactivates Staff while Staff session is active.
    await signInApi(staffPage, "staff");
    expect((await staffPage.request.get("/api/account")).status()).toBe(200);

    await staffRow.getByRole("button", { name: "Deactivate", exact: true }).click();
    await expect(page.getByTestId("user-action-status")).toContainText("Staff, Inactive");
    await expect(staffRow).toHaveAttribute("data-user-status", "INACTIVE");

    // Deactivated Staff immediately loses protected access (401) and cannot sign in.
    expect((await staffPage.request.get("/api/account")).status()).toBe(401);
    expect((await staffPage.request.get("/api/documents")).status()).toBe(401);
    const blockedLogin = await staffPage.request.post("/api/auth/sign-in/email", {
      headers: { Origin: fixture.baseURL },
      data: { email: fixture.staff.email, password: fixture.password },
    });
    expect(blockedLogin.status()).toBe(401);

    // Reactivate Staff so shared browser fixture state remains clean.
    await staffRow.getByRole("button", { name: "Reactivate", exact: true }).click();
    await expect(page.getByTestId("user-action-status")).toContainText("Staff, Active");
    await expect(staffRow).toHaveAttribute("data-user-status", "ACTIVE");

    // Old revoked session remains dead; fresh sign-in succeeds as Staff.
    expect((await staffPage.request.get("/api/account")).status()).toBe(401);
    await signInApi(staffPage, "staff");
    expect((await staffPage.request.get("/api/account")).status()).toBe(200);
  } finally {
    await staffContext.close();
  }

  // 6. Verify 320px narrow mobile layout has zero horizontal overflow and min-h-11 interactive targets.
  await page.setViewportSize({ width: 320, height: 720 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
    ),
  ).toBe(true);
  for (const button of await page.getByRole("button").all()) {
    expect((await button.boundingBox())?.height).toBeGreaterThanOrEqual(44);
  }
  expect(pageErrors).toEqual([]);
});
