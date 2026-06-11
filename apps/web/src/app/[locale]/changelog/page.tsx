import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { ProseBody } from "@/components/ProseBody";
import { SiteFooter, SiteHeader } from "@/components/SiteChrome";
import { routing } from "@/i18n/routing";
import { getOpenGraphLocale } from "@/lib/locale";
import { buildLanguageAlternates } from "@/lib/metadata-alternates";
import { getScribe } from "@/lib/scribe";

type Props = {
  params: Promise<{ locale: string }>;
};

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "Site" });

  return {
    title: t("changelogTitle"),
    description: t("changelogLead"),
    openGraph: {
      locale: getOpenGraphLocale(locale),
      type: "website",
    },
    alternates: {
      canonical: locale === routing.defaultLocale ? "/changelog" : `/${locale}/changelog`,
      languages: await buildLanguageAlternates("/changelog"),
    },
  };
}

export default async function ChangelogPage({ params }: Props) {
  const { locale } = await params;
  setRequestLocale(locale);

  const t = await getTranslations("Site");
  const scribe = getScribe();
  const entries = scribe.changelog.list(locale);

  return (
    <>
      <SiteHeader active="/changelog" />
      <main>
        <h1>{t("changelogTitle")}</h1>
        <p className="lead">{t("changelogLead")}</p>

        <div className="changelog-list">
          {entries.map((doc) => (
            <article key={doc.slug} id={doc.slug} className="changelog-entry">
              <header className="changelog-header">
                <h2 className="changelog-version">v{doc.frontmatter.version}</h2>
                {doc.publishedAt ? (
                  <time className="changelog-date" dateTime={doc.publishedAt}>
                    {doc.publishedAt}
                  </time>
                ) : null}
              </header>
              <ProseBody content={doc.content} />
            </article>
          ))}
        </div>
      </main>
      <SiteFooter />
    </>
  );
}
