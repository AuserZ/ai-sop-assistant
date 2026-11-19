import { readFileSync } from "node:fs";

type Environment = Readonly<Record<string, string | undefined>>;

export function readServerSecret(name: string, env: Environment = process.env) {
  const value = env[name];
  const path = env[`${name}_FILE`];
  if (value && path) throw new Error(`Configure one credential source for ${name}.`);
  const secret = path ? readFileSync(path, "utf8").trimEnd() : value;
  if (!secret) throw new Error(`Missing configuration for ${name}.`);
  return secret;
}

export function authConfiguration(env: Environment = process.env) {
  if (!env.AUTH_BASE_URL) throw new Error("Missing AUTH_BASE_URL.");
  const base = new URL(env.AUTH_BASE_URL);
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(base.hostname);
  if (base.username || base.password || base.pathname !== "/" || base.search || base.hash ||
      (base.protocol !== "https:" && !(base.protocol === "http:" && loopback))) {
    throw new Error("AUTH_BASE_URL must be an HTTPS origin or a local loopback HTTP origin.");
  }
  const secret = readServerSecret("AUTH_SECRET", env);
  if (secret.length < 32) throw new Error("AUTH_SECRET must contain at least 32 characters.");
  return { baseURL: base.origin, secret, secureCookies: base.protocol === "https:" };
}
