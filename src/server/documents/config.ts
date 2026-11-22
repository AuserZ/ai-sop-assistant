import { readServerSecret } from "../auth/config";

type Environment = Readonly<Record<string, string | undefined>>;
const loopbackHosts = ["127.0.0.1", "localhost", "[::1]"];

export function documentQuotaBytes(env: Environment = process.env) {
  const value = env.DOCUMENT_UPLOAD_QUOTA_BYTES;
  if (!value || !/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new Error("DOCUMENT_UPLOAD_QUOTA_BYTES must be an explicit positive safe integer.");
  }
  return Number(value);
}

export function storageConfiguration(env: Environment = process.env) {
  if (!env.R2_BUCKET || !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(env.R2_BUCKET) || !env.R2_ENDPOINT) {
    throw new Error("Configure a valid private R2 bucket and endpoint.");
  }
  const endpoint = new URL(env.R2_ENDPOINT);
  const local = env.SOP_LOCAL_STORAGE_FIXTURE_ENABLED === "1";
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error("Invalid storage endpoint.");
  if (local) {
    const base = new URL(env.AUTH_BASE_URL ?? "");
    if (!loopbackHosts.includes(base.hostname) || !loopbackHosts.includes(endpoint.hostname) || endpoint.protocol !== "http:") {
      throw new Error("Storage fixtures require loopback app and storage origins.");
    }
  } else if (endpoint.protocol !== "https:" || endpoint.port || endpoint.pathname !== "/" ||
      !/^[a-f0-9]{32}(?:\.(?:eu|fedramp))?\.r2\.cloudflarestorage\.com$/.test(endpoint.hostname)) {
    throw new Error("R2 requires its HTTPS account or jurisdiction endpoint.");
  }
  return { bucket: env.R2_BUCKET, endpoint: endpoint.toString(), forcePathStyle: local,
    credentials: { accessKeyId: readServerSecret("R2_ACCESS_KEY_ID", env), secretAccessKey: readServerSecret("R2_SECRET_ACCESS_KEY", env) } };
}
