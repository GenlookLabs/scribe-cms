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
