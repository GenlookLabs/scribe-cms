"use client";

import { useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";
import { LanguageSwitcher } from "./LanguageSwitcher";

const navLinks = [
  { href: "/docs", key: "docs" as const },
  { href: "/changelog", key: "changelog" as const },
] as const;

export function SiteHeader({ active }: { active?: string }) {
  const t = useTranslations("Site");

  return (
    <header className="border-b border-neutral-200">
      <div className="mx-auto flex w-full max-w-5xl flex-wrap items-center justify-between gap-x-6 gap-y-3 px-6 py-4">
        <Link href="/" className="flex items-baseline gap-2.5">
          <span className="text-base font-semibold tracking-tight">Scribe</span>
          <span className="hidden text-sm text-neutral-500 sm:inline">{t("tagline")}</span>
        </Link>

        <div className="flex items-center gap-5">
          <nav className="flex items-center gap-5 text-sm" aria-label="Main">
            {navLinks.map(({ href, key }) => (
              <Link
                key={href}
                href={href}
                className={
                  active === href || active?.startsWith(`${href}/`)
                    ? "font-medium text-neutral-900"
                    : "text-neutral-500 hover:text-neutral-900"
                }
              >
                {t(key)}
              </Link>
            ))}
            <a
              href="https://github.com/GenlookLabs/scribe-cms"
              target="_blank"
              rel="noopener noreferrer"
              className="text-neutral-500 hover:text-neutral-900"
            >
              {t("github")}
            </a>
          </nav>
          <LanguageSwitcher />
        </div>
      </div>
    </header>
  );
}

export function SiteFooter() {
  const t = useTranslations("Site");
  const year = new Date().getFullYear();

  return (
    <footer className="mt-auto border-t border-neutral-200 text-sm text-neutral-500">
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-3 px-6 py-6">
        <div className="flex flex-wrap gap-x-4 gap-y-2">
          <a
            href="https://www.npmjs.com/package/scribe-cms"
            target="_blank"
            rel="noopener noreferrer"
            className="text-neutral-900 hover:text-neutral-500"
          >
            {t("footerNpm")}
          </a>
          <a
            href="https://github.com/GenlookLabs/scribe-cms"
            target="_blank"
            rel="noopener noreferrer"
            className="text-neutral-900 hover:text-neutral-500"
          >
            {t("footerGithub")}
          </a>
        </div>

        <p className="max-w-lg leading-relaxed">
          {t("madeBy")}{" "}
          <a
            href="https://genlook.app"
            target="_blank"
            rel="noopener noreferrer"
            className="text-neutral-900 underline underline-offset-2 hover:text-neutral-500"
          >
            Genlook
          </a>
          {" — "}
          {t("genlookTagline")}
        </p>

        <p className="text-xs">© {year} Genlook</p>
      </div>
    </footer>
  );
}
