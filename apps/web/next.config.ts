import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");

const nextConfig: NextConfig = {
  serverExternalPackages: ["better-sqlite3", "scribe-cms", "scribe-cms/runtime"],
  // Scribe reads MDX + SQLite at runtime; include them in Vercel serverless traces.
  outputFileTracingIncludes: {
    "/**": ["./content/**/*", "./.scribe/**/*"],
  },
};

export default withNextIntl(nextConfig);
