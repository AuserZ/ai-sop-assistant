import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { z } from "zod";

const fixture = z.object({
  baseURL: z.literal("http://127.0.0.1:3000"),
  staff: z.object({ email: z.email() }),
  admin: z.object({ email: z.email() }),
  password: z.string(),
}).parse(JSON.parse(readFileSync(".local-secrets/browser-fixtures/s02-browser-fixture.json", "utf8")));
const jobResult = z.object({ jobId: z.uuid(), eventsUrl: z.string(), synthetic: z.literal(true) });

async function signIn(page: Page, email = fixture.staff.email) {
  const response = await page.request.post("/api/auth/sign-in/email", {
    headers: { Origin: fixture.baseURL }, data: { email, password: fixture.password },
  });
  expect(response.status()).toBe(200);
  await page.goto("/");
  await expect(page.getByRole("region", { name: "Your account" })).toBeVisible();
}

async function createProbe(page: Page, scenario: "success" | "validation_failure" = "success", requestKey = randomUUID()) {
  const response = await page.request.post("/api/jobs/probe", {
    headers: { Origin: fixture.baseURL }, data: { requestKey, scenario },
  });
  expect([200, 202].includes(response.status())).toBe(true);
  return jobResult.parse(await response.json());
}

function frames(text: string) {
  return text.split("\n\n").filter((frame) => frame.includes("event:")).map((frame) => {
    const event = /^event: (.+)$/m.exec(frame)?.[1];
    const id = /^id: (.+)$/m.exec(frame)?.[1];
    const data = JSON.parse(/^data: (.+)$/m.exec(frame)?.[1] ?? "null");
    return { event, id, data };
  });
}

async function readBrowserStream(page: Page, url: string, cursor?: string) {
  return page.evaluate(async ({ target, resume }) => {
    const response = await fetch(target, { credentials: "same-origin", headers: resume ? { "Last-Event-ID": resume } : {} });
    return { status: response.status, contentType: response.headers.get("content-type"), text: await response.text() };
  }, { target: url, resume: cursor });
}

test("S03 owned probe crosses Queue Mode and proxy with only bounded synthetic frames", async ({ page }) => {
  await signIn(page);
  const requestKey = randomUUID();
  const job = await createProbe(page, "success", requestKey);
  const duplicate = await createProbe(page, "success", requestKey);
  expect(duplicate.jobId).toBe(job.jobId);
  const conflicting = await page.request.post("/api/jobs/probe", {
    headers: { Origin: fixture.baseURL }, data: { requestKey, scenario: "validation_failure" },
  });
  expect(conflicting.status()).toBe(409);
  const stream = await readBrowserStream(page, job.eventsUrl);
  expect(stream.status).toBe(200);
  expect(stream.contentType?.startsWith("text/event-stream")).toBe(true);
  expect(/Bearer|eyJ[A-Za-z0-9_-]+\.|https?:\/\/|draft|password|private.?key/i.test(stream.text)).toBe(false);
  const events = frames(stream.text);
  expect(events.length).toBeGreaterThanOrEqual(5);
  expect(events.every((event) => event.id?.startsWith(`${job.jobId}:`))).toBe(true);
  const progress = events.filter((event) => event.event === "progress");
  expect(progress.map((event) => event.data.stage)).toEqual(expect.arrayContaining(["accepted", "started", "deterministic_pass", "judge_stub_pass"]));
  for (const event of progress) expect(Object.keys(event.data).sort()).toEqual(["jobId", "stage", "synthetic"]);
  const completed = events.filter((event) => event.event === "completed");
  expect(completed).toHaveLength(1);
  expect(completed[0].data).toEqual({ jobId: job.jobId, synthetic: true, kind: "synthetic_probe", marker: "S03_SYNTHETIC_VALIDATED" });
  expect(events.at(-1)?.event).toBe("completed");
});

test("S03 synthetic validation failure emits no validated completion marker", async ({ page }) => {
  await signIn(page);
  const job = await createProbe(page, "validation_failure");
  const stream = await readBrowserStream(page, job.eventsUrl);
  expect(stream.status).toBe(200);
  expect(stream.text.includes("S03_SYNTHETIC_VALIDATED")).toBe(false);
  const events = frames(stream.text);
  expect(events.filter((event) => event.event === "completed")).toHaveLength(0);
  expect(events.filter((event) => event.event === "failed")).toHaveLength(1);
  expect(events.at(-1)?.data).toEqual({ jobId: job.jobId, synthetic: true, code: "SYNTHETIC_WORKFLOW_FAILED", retryable: false });
});

test("S03 a slow browser reader receives one bounded terminal outcome", async ({ page }) => {
  await signIn(page);
  const job = await createProbe(page);
  const slowReader = await page.evaluateHandle(async (url) => {
    const response = await fetch(url, { credentials: "same-origin" });
    if (!response.ok || !response.body) throw new Error("Workflow stream unavailable.");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const first = await reader.read();
    return { reader, decoder, text: first.value ? decoder.decode(first.value, { stream: true }) : "" };
  }, job.eventsUrl);
  try {
    const observed = await readBrowserStream(page, job.eventsUrl);
    expect(frames(observed.text).filter((event) => event.event === "completed")).toHaveLength(1);
    const delayed = await slowReader.evaluate(async (saved) => {
      while (true) {
        const chunk = await saved.reader.read();
        if (chunk.done) return saved.text;
        saved.text += saved.decoder.decode(chunk.value, { stream: true });
      }
    });
    expect(new TextEncoder().encode(delayed).byteLength).toBeLessThanOrEqual(65_536);
    expect(frames(delayed).filter((event) => event.event === "completed")).toHaveLength(1);
    expect(/Bearer|eyJ[A-Za-z0-9_-]+\.|https?:\/\/|draft|password|private.?key/i.test(delayed)).toBe(false);
  } finally {
    await slowReader.evaluate(async (saved) => { await saved.reader.cancel(); }).catch(() => undefined);
    await slowReader.dispose();
  }
});

test("S03 stream ownership and job-bound resume survive browser disconnect", async ({ page, browser }) => {
  await signIn(page);
  const job = await createProbe(page);
  const firstFrame = await page.evaluate(async (url) => {
    const response = await fetch(url, { credentials: "same-origin" });
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let text = "";
    let eventFrame: string | undefined;
    while (!eventFrame) {
      const chunk = await reader.read();
      if (chunk.done) break;
      text += decoder.decode(chunk.value, { stream: true });
      eventFrame = text.split("\n\n").slice(0, -1).find((frame) => /^event: /m.test(frame) && /^id: /m.test(frame));
    }
    await reader.cancel();
    if (!eventFrame) throw new Error("No workflow event received.");
    return eventFrame;
  }, job.eventsUrl);
  const first = frames(`${firstFrame}\n\n`)[0];
  expect(first.event).toBe("progress");
  const replay = await readBrowserStream(page, job.eventsUrl, first.id);
  expect(replay.status).toBe(200);
  expect(frames(replay.text).filter((event) => event.event === "completed")).toHaveLength(1);
  const foreignCursor = await page.request.get(job.eventsUrl, { headers: { "Last-Event-ID": `${randomUUID()}:1` } });
  expect(foreignCursor.status()).toBe(400);
  const futureCursor = await page.request.get(job.eventsUrl, { headers: { "Last-Event-ID": `${job.jobId}:999999999` } });
  expect(futureCursor.status()).toBe(400);
  const foreignContext = await browser.newContext({ baseURL: fixture.baseURL });
  try {
    expect((await foreignContext.request.get(job.eventsUrl)).status()).toBe(401);
    const login = await foreignContext.request.post("/api/auth/sign-in/email", {
      headers: { Origin: fixture.baseURL }, data: { email: fixture.admin.email, password: fixture.password },
    });
    expect(login.status()).toBe(200);
    expect((await foreignContext.request.get(job.eventsUrl)).status()).toBe(404);
  } finally {
    await foreignContext.close();
  }
});
