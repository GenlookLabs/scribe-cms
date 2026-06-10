const openGraphLocales: Record<string, string> = {
  en: "en_US",
  fr: "fr_FR",
};

export function getOpenGraphLocale(locale: string): string {
  return openGraphLocales[locale] ?? locale;
}
