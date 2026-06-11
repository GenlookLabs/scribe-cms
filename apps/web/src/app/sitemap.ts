import type { MetadataRoute } from "next";
import { buildStaticNextRoutes } from "@/lib/sitemap/static-routes";

const baseUrl = "https://scribe.genlook.app";

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  return buildStaticNextRoutes(baseUrl);
}
