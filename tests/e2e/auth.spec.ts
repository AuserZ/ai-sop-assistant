import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { z } from "zod";

const fixture = z.object({
  version: z.literal(1),
  baseURL: z.literal("http://127.0.0.1:3000"),
  admin: z.object({ email: z.email() }),
  staff: z.object({ email: z.email() }),
  password: z.string(),
  invitations: z.array(z.object({ email: z.email(), acceptUrl: z.string() })).length(2),
}).parse(JSON.parse(readFileSync(".local-secrets/browser-fixtures/s02-browser-fixture.json", "utf8")));

async function signIn(page: Page, email: string) {
  await page.goto("/sign-in");
  await page.getByLabel("Email", { exact: true }).fill(email);
  await page.getByLabel("Password", { exact: true }).fill(fixture.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("region", { name: "Your account" })).toBeVisible();
}

async function checkLayout(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await expect(page.locator("main")).toBeVisible();
  await expect(page.locator("h1")).toHaveCount(1);
  expect(await page.locator("html").getAttribute("lang")).toBe("en");
  for (const control of await page.locator("input, button, a").all()) {
    const bounds = await control.boundingBox();
    expect(bounds?.height).toBeGreaterThanOrEqual(44);
  }
}

async function openInvitation(page: Page, acceptUrl: string) {
  await page.goto("/sign-in");
  await page.evaluate((url) => { window.location.assign(url); }, acceptUrl);
  await expect(page.getByLabel("Name", { exact: true })).toBeVisible();
}

test("U4 Staff signs in and out; Admin API remains forbidden", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.name));
  await page.goto("/");
  await page.getByRole("link", { name: "Sign in", exact: true }).click();
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByText("Enter a valid email address.", { exact: true })).toBeVisible();
  await expect(page.getByText("Enter your password.", { exact: true })).toBeVisible();
  await signIn(page, fixture.staff.email);
  await expect(page.getByText("Role: Staff", { exact: true })).toBeVisible();
  const denied = await page.request.post("/api/users/invite", {
    headers: { Origin: fixture.baseURL }, data: { email: "forbidden@example.invalid", role: "ADMIN" },
  });
  expect(denied.status()).toBe(403);
  const session = await page.request.get("/api/auth/get-session");
  const sessionData = await session.json();
  expect(Object.keys(sessionData.session).sort()).toEqual(["expiresAt", "id"]);
  const cookies = await page.context().cookies();
  expect(cookies.some((cookie) => cookie.name.includes("session_token") && cookie.httpOnly && cookie.sameSite === "Lax")).toBe(true);
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(page.getByRole("link", { name: "Sign in", exact: true })).toBeVisible();
  expect((await page.request.get("/api/account")).status()).toBe(401);
  expect(errors).toEqual([]);
});

test("U4 Admin session displays its bound role", async ({ page }) => {
  await signIn(page, fixture.admin.email);
  await expect(page.getByText("Role: Admin", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(page.getByRole("link", { name: "Sign in", exact: true })).toBeVisible();
});

test("completed sign-out cannot be replaced by an earlier focus refresh", async ({ page }) => {
  await signIn(page, fixture.staff.email);
  const account = await (await page.request.get("/api/account")).json();
  let releaseSignOut!: () => void;
  let releaseRefresh!: () => void;
  let refreshStarted!: () => void;
  let refreshFinished!: () => void;
  const pendingSignOut = new Promise<void>((resolve) => { releaseSignOut = resolve; });
  const pendingRefresh = new Promise<void>((resolve) => { releaseRefresh = resolve; });
  const refreshReady = new Promise<void>((resolve) => { refreshStarted = resolve; });
  const refreshComplete = new Promise<void>((resolve) => { refreshFinished = resolve; });
  await page.route("**/api/auth/sign-out", async (route) => { await pendingSignOut; await route.continue(); });
  await page.route("**/api/account", async (route) => {
    refreshStarted();
    await pendingRefresh;
    await route.fulfill({ status: 200, json: account }).catch(() => undefined);
    refreshFinished();
  });
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await page.evaluate(() => { window.dispatchEvent(new Event("focus")); });
  await refreshReady;
  releaseSignOut();
  await expect(page.getByRole("link", { name: "Sign in", exact: true })).toBeVisible();
  releaseRefresh();
  await refreshComplete;
  await expect(page.getByRole("link", { name: "Sign in", exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "Your account" })).toHaveCount(0);
  await page.unroute("**/api/account");
  await page.reload();
  await expect(page.getByRole("link", { name: "Sign in", exact: true })).toBeVisible();
  expect((await page.request.get("/api/account")).status()).toBe(401);
});

for (const [index, width] of [1280, 320].entries()) {
  test(`U2 invitation acceptance at ${width}px preserves email and one-use rules`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    const invitation = fixture.invitations[index];
    const requestedUrls: string[] = [];
    page.on("request", (request) => requestedUrls.push(request.url()));
    await openInvitation(page, invitation.acceptUrl);
    expect(new URL(page.url()).hash).toBe("");
    expect(requestedUrls.some((url) => url.includes(new URL(invitation.acceptUrl).hash.slice(1)))).toBe(false);
    await checkLayout(page);
    await page.getByRole("button", { name: "Create account", exact: true }).click();
    await expect(page.getByText("Enter your name.", { exact: true })).toBeVisible();
    await expect(page.getByText("Use at least 12 characters.", { exact: true }).first()).toBeVisible();
    await page.getByLabel("Name", { exact: true }).fill("Invited synthetic Staff");
    await page.getByLabel("Invited email", { exact: true }).fill("wrong@example.invalid");
    await page.getByLabel("Create password", { exact: true }).fill(fixture.password);
    await page.getByRole("button", { name: "Create account", exact: true }).click();
    await expect(page.getByRole("main").getByRole("alert")).toHaveText("This invitation is invalid, expired, or already used. Ask an Admin for a new one.");
    await page.getByLabel("Invited email", { exact: true }).fill(invitation.email);
    await page.getByRole("button", { name: "Create account", exact: true }).click();
    await expect(page.getByRole("status")).toHaveText("Your account is ready. Sign in with your invited email and new password.");
    await page.getByRole("link", { name: "Continue to sign in", exact: true }).click();
    await signIn(page, invitation.email);
    await expect(page.getByText("Role: Staff", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    await openInvitation(page, invitation.acceptUrl);
    await page.getByLabel("Name", { exact: true }).fill("Reused invitation");
    await page.getByLabel("Invited email", { exact: true }).fill(invitation.email);
    await page.getByLabel("Create password", { exact: true }).fill(fixture.password);
    await page.getByRole("button", { name: "Create account", exact: true }).click();
    await expect(page.getByRole("main").getByRole("alert")).toHaveText("This invitation is invalid, expired, or already used. Ask an Admin for a new one.");
    await checkLayout(page);
  });
}

test("auth errors, pending states, keyboard and narrow layout remain usable", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 600 });
  await page.goto("/accept-invitation");
  await expect(page.getByRole("main").getByRole("alert")).toContainText("Open the full invitation link");
  await page.getByRole("link", { name: "Back to sign in", exact: true }).click();
  await expect(page).toHaveURL(new URL("/sign-in", fixture.baseURL).href);
  await expect(page.getByRole("heading", { level: 1, name: "Sign in", exact: true })).toBeVisible();
  await expect(page.getByLabel("Email", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Password", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeEnabled();
  await checkLayout(page);
  await page.keyboard.press("Tab");
  await expect(page.getByLabel("Email", { exact: true })).toBeFocused();
  expect(await page.getByLabel("Email", { exact: true }).evaluate((element) => getComputedStyle(element).outlineStyle)).not.toBe("none");
  await page.keyboard.type(fixture.staff.email);
  await page.keyboard.press("Tab");
  await page.keyboard.type("Incorrect-password-42!");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("main").getByRole("alert")).toHaveText("Email or password is incorrect.");
  await page.setViewportSize({ width: 320, height: 300 });
  await page.getByLabel("Password", { exact: true }).focus();
  expect(await page.getByLabel("Password", { exact: true }).evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    return bounds.top >= 0 && bounds.bottom <= window.innerHeight;
  })).toBe(true);
  await page.setViewportSize({ width: 320, height: 600 });
  await page.route("**/api/auth/sign-in/email", async (route) => route.fulfill({ status: 429, json: { error: { code: "RATE_LIMITED" } } }));
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("main").getByRole("alert")).toHaveText("Too many attempts. Wait a moment and try again.");
  await page.unroute("**/api/auth/sign-in/email");
  let releaseSignIn!: () => void;
  const pendingSignIn = new Promise<void>((resolve) => { releaseSignIn = resolve; });
  await page.route("**/api/auth/sign-in/email", async (route) => {
    await pendingSignIn;
    await route.fulfill({ status: 503, json: { error: { code: "SERVICE_UNAVAILABLE" } } });
  });
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("button", { name: "Signing in...", exact: true })).toBeDisabled();
  await expect(page.getByLabel("Email", { exact: true })).toBeDisabled();
  releaseSignIn();
  await expect(page.getByRole("main").getByRole("alert")).toHaveText("This request is temporarily unavailable. Try again.");
  await page.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
  await checkLayout(page);
  let releaseAccount!: () => void;
  const pendingAccount = new Promise<void>((resolve) => { releaseAccount = resolve; });
  await page.route("**/api/account", async (route) => {
    await pendingAccount;
    await route.fulfill({ status: 503, json: { error: { code: "SERVICE_UNAVAILABLE" } } });
  });
  await page.goto("/");
  await expect(page.getByRole("status")).toHaveText("Checking sign-in...");
  releaseAccount();
  await expect(page.getByRole("main").getByRole("alert")).toHaveText("Sign-in status is temporarily unavailable.");
  await page.unroute("**/api/account");
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(page.getByRole("link", { name: "Sign in", exact: true })).toBeVisible();
});
