import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { Markdown } from "@/components/Markdown";
import { Prose } from "@/components/Prose";
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
  const entries = scribe.changelog
    .list()
    .map((doc) => scribe.changelog.translation(doc, locale) ?? doc);

  return (
    <>
      <SiteHeader active="/changelog" />
      <main className="mx-auto w-full max-w-3xl flex-1 px-6 pt-10 pb-24">
        <h1 className="text-2xl font-semibold tracking-tight">{t("changelogTitle")}</h1>
        <p className="mt-2 max-w-2xl text-neutral-600">{t("changelogLead")}</p>

        <div className="mt-12 flex flex-col gap-12">
          {entries.map((doc) => (
            <article
              key={doc.enSlug}
              id={doc.enSlug}
              className="scroll-mt-4 border-b border-neutral-100 pb-12 last:border-b-0 last:pb-0"
            >
              <header className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
                <h2 className="text-lg font-semibold">v{doc.frontmatter.version}</h2>
                {doc.publishedAt ? (
                  <time className="text-sm text-neutral-500" dateTime={doc.publishedAt}>
                    {doc.publishedAt}
                  </time>
                ) : null}
              </header>
              <div className="mt-3">
                <Prose>
                  <Markdown content={doc.content} />
                </Prose>
              </div>
            </article>
          ))}
        </div>
      </main>
      <SiteFooter />
    </>
  );
}
