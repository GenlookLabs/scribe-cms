"use client";

import { useLocale, useTranslations } from "next-intl";
import { usePathname, useRouter } from "@/i18n/navigation";
import { routing } from "@/i18n/routing";
import { localeDisplayNames } from "@/lib/locale-display";

export function LanguageSwitcher() {
  const t = useTranslations("Site");
  const currentLocale = useLocale();
  const pathname = usePathname();
  const router = useRouter();

  return (
    <label>
      <span className="sr-only">{t("languageLabel")}</span>
      <select
        value={currentLocale}
        onChange={(event) => router.replace(pathname, { locale: event.target.value })}
        aria-label={t("languageLabel")}
        className="appearance-none rounded-md border border-neutral-200 bg-white px-2 py-1.5 text-sm text-neutral-900"
      >
        {routing.locales.map((locale) => (
          <option key={locale} value={locale}>
            {localeDisplayNames[locale] ?? locale}
          </option>
        ))}
      </select>
    </label>
  );
}
