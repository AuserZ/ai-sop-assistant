import type { NextConfig } from "next";

const loopbackHostnames = new Set(["127.0.0.1", "localhost", "[::1]"]);
const defaultR2ConnectSource = "https://*.r2.cloudflarestorage.com";

function resolveStorageConnectOrigin(
  env: Readonly<Record<string, string | undefined>>,
): string | null {
  const rawEndpoint =
    env.R2_ENDPOINT?.trim() ||
    env.S3_ENDPOINT?.trim() ||
    env.SOP_STORAGE_ENDPOINT?.trim() ||
    "";
  if (!rawEndpoint) return null;

  let parsed: URL;
  try {
    parsed = new URL(rawEndpoint);
  } catch {
    return null;
  }

  if (parsed.username || parsed.password) return null;
  if (parsed.protocol === "https:") return parsed.origin;
  if (parsed.protocol === "http:" && loopbackHostnames.has(parsed.hostname)) {
    return parsed.origin;
  }
  return null;
}

// Next.js standalone evaluates headers() at build time into .next/routes-manifest.json.
// script-src retains 'unsafe-inline' because App Router emits inline RSC bootstrap/flight
// scripts that require dynamic per-request middleware nonces to eliminate.
export function buildContentSecurityPolicy(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const connectSources = new Set<string>(["'self'"]);
  const configuredStorageOrigin = resolveStorageConnectOrigin(env);

  if (configuredStorageOrigin) {
    connectSources.add(configuredStorageOrigin);
  } else {
    connectSources.add(defaultR2ConnectSource);
  }

  if (env.NODE_ENV !== "production") {
    connectSources.add("http://127.0.0.1:*");
    connectSources.add("http://localhost:*");
  }

  return [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "worker-src 'self' blob:",
    `connect-src ${Array.from(connectSources).join(" ")}`,
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
  ].join("; ");
}

const config: NextConfig = {
  output: "standalone",
  poweredByHeader: false,
  serverExternalPackages: ["pino"],
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
          { key: "Content-Security-Policy", value: buildContentSecurityPolicy(process.env) },
        ],
      },
      {
        // Permit browser built-in PDF viewer (<embed>) on authorized same-origin PDFs only.
        source: "/api/documents/:id/source/content",
        headers: [
          {
            key: "Content-Security-Policy",
            value: "default-src 'none'; object-src 'self'; frame-ancestors 'none'",
          },
        ],
      },
    ];
  },
};

export default config;
