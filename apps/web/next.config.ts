import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";
import { defaultLocale, locales } from "./locales";

const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");

// Regex alternation of prefixed locales, so :locale never swallows real
// segments like /docs in /docs/getting-started.
const localePattern = locales.filter((l) => l !== defaultLocale).join("|");

const nextConfig: NextConfig = {
  serverExternalPackages: ["better-sqlite3", "scribe-cms", "scribe-cms/runtime"],
  // Scribe reads MDX + SQLite at runtime; include them in Vercel serverless traces.
  outputFileTracingIncludes: {
    "/**": ["./content/**/*", "./.scribe/**/*"],
  },
  async redirects() {
    // Old routes folded into /docs.
    return [
      { source: "/examples", destination: "/docs", permanent: true },
      {
        source: `/:locale(${localePattern})/examples`,
        destination: "/:locale/docs",
        permanent: true,
      },
      { source: "/getting-started", destination: "/docs/getting-started", permanent: true },
      {
        source: `/:locale(${localePattern})/getting-started`,
        destination: "/:locale/docs/getting-started",
        permanent: true,
      },
    ];
  },
};

export default withNextIntl(nextConfig);
