import { createElement } from "react";
import { render, toPlainText } from "@react-email/render";
import { Resend } from "resend";
import { readServerSecret } from "../auth/config";
import { AuthFailure } from "../auth/errors";

const invitationDeliveryTimeoutMilliseconds = 10_000;

export type InvitationDelivery = {
  email: string;
  role: "ADMIN" | "STAFF";
  acceptUrl: string;
  expiresAt: Date;
  invitationId: string;
};

export async function sendInvitationEmail(invitation: InvitationDelivery) {
  try {
    if (!process.env.RESEND_FROM) throw new Error("Missing sender configuration.");
    const apiKey = readServerSecret("RESEND_API_KEY");
    const { InvitationEmail } = await import("../../emails/invitation");
    const html = await render(createElement(InvitationEmail, {
      acceptUrl: invitation.acceptUrl, role: invitation.role, expiresAt: invitation.expiresAt,
    }));
    const resend = new Resend(apiKey);
    const { data, error } = await resend.emails.send({
      from: process.env.RESEND_FROM,
      to: invitation.email,
      subject: "Your AI SOP Assistant invitation",
      html,
      text: toPlainText(html),
    }, {
      idempotencyKey: `invitation-${invitation.invitationId}`,
      signal: AbortSignal.timeout(invitationDeliveryTimeoutMilliseconds),
    });
    if (error || !data?.id) throw new Error("Email delivery failed.");
  } catch {
    throw new AuthFailure("INVITATION_DELIVERY_FAILED", 503);
  }
}
