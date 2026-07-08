import type { MetadataRoute } from "next";
import { getPathname } from "@/i18n/navigation";
import { routing } from "@/i18n/routing";
import { getScribe } from "@/lib/scribe";

function joinBaseUrl(baseUrl: string, pathname: string): string {
  const origin = baseUrl.replace(/\/$/, "");
  const path = pathname.startsWith("/") ? pathname : `/${pathname}`;
  return `${origin}${path}`;
}

export interface StaticSitemapRoute {
  href: string;
  priority: number;
  changeFrequency: MetadataRoute.Sitemap[number]["changeFrequency"];
  lastModified?: Date;
}

export const STATIC_SITEMAP_ROUTES: StaticSitemapRoute[] = [
  { href: "/", priority: 1, changeFrequency: "monthly" },
  { href: "/docs", priority: 0.9, changeFrequency: "monthly" },
  { href: "/blog", priority: 0.8, changeFrequency: "monthly" },
  { href: "/changelog", priority: 0.7, changeFrequency: "monthly" },
];

function listSitemapRoutes(): StaticSitemapRoute[] {
  const scribe = getScribe();

  const docRoutes = scribe.doc.list().map((doc) => ({
    href: `/docs/${doc.enSlug}`,
    priority: 0.8,
    changeFrequency: "monthly" as const,
  }));

  const blogRoutes = scribe.blog.list().map((post) => ({
    href: `/blog/${post.enSlug}`,
    priority: 0.7,
    changeFrequency: "monthly" as const,
    lastModified: post.publishedAt ? new Date(post.publishedAt) : undefined,
  }));

  return [...STATIC_SITEMAP_ROUTES, ...docRoutes, ...blogRoutes];
}

export async function buildStaticNextRoutes(baseUrl: string): Promise<MetadataRoute.Sitemap> {
  const now = new Date();
  const entries: MetadataRoute.Sitemap = [];

  for (const route of listSitemapRoutes()) {
    const alternates: Record<string, string> = {};
    for (const locale of routing.locales) {
      const pathname = getPathname({ locale, href: route.href });
      alternates[locale] = joinBaseUrl(baseUrl, pathname);
    }
    alternates["x-default"] = alternates[routing.defaultLocale]!;

    entries.push({
      url: alternates[routing.defaultLocale]!,
      lastModified: route.lastModified ?? now,
      changeFrequency: route.changeFrequency,
      priority: route.priority,
      alternates: { languages: alternates },
    });
  }

  return entries;
}
