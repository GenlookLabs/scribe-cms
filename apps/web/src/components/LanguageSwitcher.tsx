"use client";

import { useLocale, useTranslations } from "next-intl";
import { usePathname, useRouter } from "@/i18n/navigation";
import { routing } from "@/i18n/routing";

const localeNames: Record<string, string> = {
  en: "English",
  fr: "Français",
};

export function LanguageSwitcher() {
  const t = useTranslations("Site");
  const currentLocale = useLocale();
  const pathname = usePathname();
  const router = useRouter();

  return (
    <label className="language-switcher">
      <span className="sr-only">{t("languageLabel")}</span>
      <select
        value={currentLocale}
        onChange={(event) => router.replace(pathname, { locale: event.target.value })}
        aria-label={t("languageLabel")}
      >
        {routing.locales.map((locale) => (
          <option key={locale} value={locale}>
            {localeNames[locale] ?? locale}
          </option>
        ))}
      </select>
    </label>
  );
}
