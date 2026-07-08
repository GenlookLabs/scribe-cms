import { getPathname } from "@/i18n/navigation";
import { routing } from "@/i18n/routing";

export async function buildLanguageAlternates(href: string): Promise<Record<string, string>> {
  const languages: Record<string, string> = {};
  for (const locale of routing.locales) {
    languages[locale] = getPathname({ locale, href });
  }
  languages["x-default"] = languages[routing.defaultLocale]!;
  return languages;
}
