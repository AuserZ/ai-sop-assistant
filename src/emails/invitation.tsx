import type { ReactElement } from "react";

type InvitationEmailProps = {
  acceptUrl: string;
  role: "ADMIN" | "STAFF";
  expiresAt: Date;
};

export function InvitationEmail({ acceptUrl, role, expiresAt }: InvitationEmailProps): ReactElement {
  return (
    <html lang="en">
      <head><title>Your AI SOP Assistant invitation</title></head>
      <body style={{ backgroundColor: "#ffffff", color: "#111111", fontFamily: "Arial, sans-serif", margin: 0 }}>
        <main style={{ maxWidth: "480px", margin: "0 auto", padding: "32px 24px", lineHeight: 1.6 }}>
          <h1 style={{ fontSize: "24px", lineHeight: 1.3 }}>Your AI SOP Assistant invitation</h1>
          <p>An Admin invited you to join AI SOP Assistant as {role === "ADMIN" ? "an Admin" : "Staff"}.</p>
          <p>Use the invited email address to create your password.</p>
          <p style={{ margin: "28px 0" }}>
            <a href={acceptUrl} style={{ display: "inline-block", backgroundColor: "#111111", color: "#ffffff", padding: "12px 20px", borderRadius: "4px", textDecoration: "none" }}>Accept invitation</a>
          </p>
          <p>This invitation expires at {expiresAt.toISOString().replace("T", " ").replace(".000Z", " UTC")}.</p>
          <p>If you were not expecting this invitation, contact your Admin.</p>
        </main>
      </body>
    </html>
  );
}
