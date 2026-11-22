import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTypeScript from "eslint-config-next/typescript";

export default defineConfig([
  ...nextVitals,
  ...nextTypeScript,
  { files: ["src/emails/**/*.tsx"], rules: { "@next/next/no-head-element": "off" } },
  globalIgnores([".next/**", "coverage/**", ".local-secrets/**", "next-env.d.ts"]),
]);
