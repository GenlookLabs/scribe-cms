const openGraphLocales: Record<string, string> = {
  en: "en_US",
  fr: "fr_FR",
  "pt-BR": "pt_BR",
  "zh-CN": "zh_CN",
  es: "es_ES",
  de: "de_DE",
  ja: "ja_JP",
  ar: "ar_SA",
  it: "it_IT",
  ru: "ru_RU",
};

export function getOpenGraphLocale(locale: string): string {
  return openGraphLocales[locale] ?? locale;
}
