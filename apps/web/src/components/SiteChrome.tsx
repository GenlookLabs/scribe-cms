"use client";

import { useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";
import { LanguageSwitcher } from "./LanguageSwitcher";

const links = [
  { href: "/", key: "home" as const },
  { href: "/examples", key: "examples" as const },
  { href: "/getting-started", key: "gettingStarted" as const },
] as const;

export function SiteHeader({ active }: { active?: (typeof links)[number]["href"] }) {
  const t = useTranslations("Site");

  return (
    <header className="header">
      <div className="header-inner">
        <Link href="/" className="brand">
          <span className="brand-name">Scribe</span>
          <span className="brand-tagline">{t("tagline")}</span>
        </Link>

        <div className="header-actions">
          <nav className="nav" aria-label="Main">
            {links.map(({ href, key }) => (
              <Link key={href} href={href} data-active={active === href ? "true" : undefined}>
                {t(key)}
              </Link>
            ))}
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
    <footer className="footer">
      <div className="footer-inner">
        <div className="footer-links">
          <a href="https://www.npmjs.com/package/scribe-crm" target="_blank" rel="noopener noreferrer">
            {t("footerNpm")}
          </a>
          <a href="https://github.com/GenlookLabs" target="_blank" rel="noopener noreferrer">
            {t("footerGithub")}
          </a>
        </div>

        <p className="footer-credit">
          {t("madeBy")}{" "}
          <a href="https://genlook.app" target="_blank" rel="noopener noreferrer">
            Genlook
          </a>
          {" — "}
          {t("genlookTagline")}
        </p>

        <p className="footer-copy">© {year} Genlook</p>
      </div>
    </footer>
  );
}
