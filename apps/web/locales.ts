export const locales = [
  "en",
  "fr",
  "pt-BR",
  "zh-CN",
  "es",
  "de",
  "ja",
  "ar",
  "it",
  "ru",
] as const;

export type AppLocale = (typeof locales)[number];
export const defaultLocale: AppLocale = "en";

/** Non-English locales seeded at build time (see scripts/seed-translations.mjs). */
export const seededLocales = locales.filter((locale) => locale !== defaultLocale);
