import { z } from "zod";
import { buttonClass, inputFieldClassName, textLinkClassName } from "@/components/ui/primitives";

export const accountSchema = z.object({
  id: z.string(),
  name: z.string(),
  email: z.email(),
  role: z.enum(["ADMIN", "STAFF"]),
});

export type Account = z.infer<typeof accountSchema>;

const errorMessages: Record<string, string> = {
  INVALID_CREDENTIALS: "Email or password is incorrect.",
  INVALID_EMAIL_OR_PASSWORD: "Email or password is incorrect.",
  INVALID_INVITATION: "This invitation is invalid, expired, or already used. Ask an Admin for a new one.",
  ACCOUNT_INACTIVE: "This account is inactive. Contact an Admin.",
  RATE_LIMITED: "Too many attempts. Wait a moment and try again.",
  INVALID_INPUT: "Check the form and try again.",
};

export async function postAuth(path: string, body: unknown): Promise<unknown> {
  const response = await fetch(path, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const error = z.object({ error: z.object({ code: z.string() }) }).safeParse(payload);
    throw new Error(error.success && errorMessages[error.data.error.code] || "This request is temporarily unavailable. Try again.");
  }
  return payload;
}

export const inputClassName = inputFieldClassName;
export const buttonClassName = buttonClass("primary");
export const linkClassName = textLinkClassName;
