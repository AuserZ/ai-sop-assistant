import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sendInvitationEmail } from "../../src/server/email/invitation";

const { sendEmail } = vi.hoisted(() => ({ sendEmail: vi.fn() }));
vi.mock("resend", () => ({
  Resend: class {
    emails = { send: sendEmail };
  },
}));

const invitation = {
  invitationId: "synthetic-invitation",
  email: "intended@example.invalid",
  role: "STAFF" as const,
  acceptUrl: "https://sop.example.invalid/accept-invitation#synthetic-token",
  expiresAt: new Date("2030-01-01T12:00:00.000Z"),
};

beforeEach(() => {
  vi.stubEnv("RESEND_FROM", "Synthetic SOP <sender@example.invalid>");
  vi.stubEnv("RESEND_API_KEY", "synthetic-provider-secret");
  vi.stubEnv("RESEND_API_KEY_FILE", "");
  sendEmail.mockReset().mockResolvedValue({ data: { id: "synthetic-email" }, error: null });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("U2/ADR07 invitation delivery with mocked Resend and real React Email rendering", () => {
  it("renders intended role/expiry and an actionable fragment link in HTML/plain text without a password", async () => {
    await sendInvitationEmail(invitation);
    expect(sendEmail).toHaveBeenCalledOnce();
    const [message, options] = sendEmail.mock.calls[0];
    expect(message.to).toBe(invitation.email);
    expect(message.html).toContain(invitation.acceptUrl);
    expect(message.html).toContain("Staff");
    expect(message.html).toContain("2030-01-01 12:00:00 UTC");
    expect(message.text).toContain(invitation.acceptUrl);
    expect(message).not.toHaveProperty("password");
    expect(JSON.stringify(message)).not.toContain("synthetic-provider-secret");
    expect(options).toEqual({ idempotencyKey: "invitation-synthetic-invitation", signal: expect.any(AbortSignal) });
  });

  it("fails closed with safe errors when sender, credentials or provider delivery are unavailable", async () => {
    vi.stubEnv("RESEND_FROM", "");
    await expect(sendInvitationEmail(invitation)).rejects.toMatchObject({ code: "INVITATION_DELIVERY_FAILED", status: 503 });
    expect(sendEmail).not.toHaveBeenCalled();
    vi.stubEnv("RESEND_FROM", "sender@example.invalid");
    vi.stubEnv("RESEND_API_KEY", "");
    await expect(sendInvitationEmail(invitation)).rejects.toMatchObject({ code: "INVITATION_DELIVERY_FAILED", status: 503 });
    expect(sendEmail).not.toHaveBeenCalled();
    vi.stubEnv("RESEND_API_KEY", "synthetic-provider-secret");
    sendEmail.mockResolvedValue({ data: null, error: { message: "sensitive-provider-diagnostics" } });
    await expect(sendInvitationEmail(invitation)).rejects.toThrow("INVITATION_DELIVERY_FAILED");
  });

  it("bounds stalled provider calls with a ten-second abort and returns a safe delivery failure", async () => {
    const controller = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
    let signalSending!: () => void;
    const sending = new Promise<void>((resolve) => { signalSending = resolve; });
    sendEmail.mockImplementation((_message, options: { signal: AbortSignal }) => new Promise((_resolve, reject) => {
      options.signal.addEventListener("abort", () => reject(new Error("sensitive-provider-timeout")), { once: true });
      signalSending();
    }));
    const outcome = sendInvitationEmail(invitation).then(() => null, (error: unknown) => error);
    await sending;
    expect(timeout).toHaveBeenCalledWith(10_000);
    controller.abort();
    expect(await outcome).toMatchObject({ code: "INVITATION_DELIVERY_FAILED", status: 503 });
  });
});
