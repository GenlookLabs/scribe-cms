export const locales = ["en", "fr"] as const;
export type AppLocale = (typeof locales)[number];
export const defaultLocale: AppLocale = "en";
