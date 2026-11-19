import { z } from "zod";

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

export const inputClassName = "min-h-11 w-full rounded-md border border-[#6b7280] bg-white px-3 py-2 text-black outline-offset-4 focus-visible:outline-2 focus-visible:outline-black disabled:cursor-not-allowed disabled:bg-gray-100";
export const buttonClassName = "min-h-11 cursor-pointer rounded-md bg-black px-5 py-2 font-medium text-white hover:bg-[#333333] active:bg-[#111111] focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-black disabled:cursor-not-allowed disabled:bg-[#4b5563]";
export const linkClassName = "inline-flex min-h-11 cursor-pointer items-center underline underline-offset-4 hover:text-[#4b5563] active:text-black focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-black";
