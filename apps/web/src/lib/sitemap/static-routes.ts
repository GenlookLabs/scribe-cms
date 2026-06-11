import type { MetadataRoute } from "next";
import { getPathname } from "@/i18n/navigation";
import { routing } from "@/i18n/routing";

function joinBaseUrl(baseUrl: string, pathname: string): string {
  const origin = baseUrl.replace(/\/$/, "");
  const path = pathname.startsWith("/") ? pathname : `/${pathname}`;
  return `${origin}${path}`;
}

export interface StaticSitemapRoute {
  href: string;
  priority: number;
  changeFrequency: MetadataRoute.Sitemap[number]["changeFrequency"];
}

export const STATIC_SITEMAP_ROUTES: StaticSitemapRoute[] = [
  { href: "/", priority: 1, changeFrequency: "monthly" },
  { href: "/examples", priority: 0.8, changeFrequency: "weekly" },
  { href: "/getting-started", priority: 0.9, changeFrequency: "monthly" },
  { href: "/changelog", priority: 0.7, changeFrequency: "monthly" },
];

export async function buildStaticNextRoutes(baseUrl: string): Promise<MetadataRoute.Sitemap> {
  const now = new Date();
  const entries: MetadataRoute.Sitemap = [];

  for (const route of STATIC_SITEMAP_ROUTES) {
    const alternates: Record<string, string> = {};
    for (const locale of routing.locales) {
      const pathname = await getPathname({ locale, href: route.href });
      alternates[locale] = joinBaseUrl(baseUrl, pathname);
    }
    alternates["x-default"] = alternates[routing.defaultLocale]!;

    entries.push({
      url: alternates[routing.defaultLocale]!,
      lastModified: now,
      changeFrequency: route.changeFrequency,
      priority: route.priority,
      alternates: { languages: alternates },
    });
  }

  return entries;
}
