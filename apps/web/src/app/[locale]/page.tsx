import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { ProseBody } from "@/components/ProseBody";
import { SiteFooter, SiteHeader } from "@/components/SiteChrome";
import { Link } from "@/i18n/navigation";
import { routing } from "@/i18n/routing";
import { getOpenGraphLocale } from "@/lib/locale";
import { buildLanguageAlternates } from "@/lib/metadata-alternates";
import { getScribe } from "@/lib/scribe";

type Props = {
  params: Promise<{ locale: string }>;
};

function getPageDoc(scribe: ReturnType<typeof getScribe>, slug: string, locale: string) {
  return scribe.page.get(slug, locale) ?? scribe.page.get(slug, routing.defaultLocale);
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  const scribe = getScribe();
  const doc = getPageDoc(scribe, "home", locale);

  return {
    title: doc?.frontmatter.title ?? "Scribe",
    description: doc?.frontmatter.description,
    openGraph: {
      locale: getOpenGraphLocale(locale),
      type: "website",
    },
    alternates: {
      canonical: locale === routing.defaultLocale ? "/" : `/${locale}`,
      languages: await buildLanguageAlternates("/"),
    },
  };
}

export default async function HomePage({ params }: Props) {
  const { locale } = await params;
  setRequestLocale(locale);

  const t = await getTranslations("Site");
  const scribe = getScribe();
  const doc = getPageDoc(scribe, "home", locale);

  if (!doc) {
    throw new Error("Page content not found: content/pages/home.mdx");
  }

  const { title, description, installCommand } = doc.frontmatter;

  return (
    <>
      <SiteHeader active="/" />
      <main>
        <h1>{title}</h1>
        <p className="lead">{description}</p>

        {installCommand ? (
          <div className="install-block">
            <span className="install-label">{t("install")}</span>
            <pre className="code-block">
              <code>{installCommand}</code>
            </pre>
          </div>
        ) : null}

        <ProseBody content={doc.content} />

        <div className="links">
          <Link href="/examples">{t("viewExamples")}</Link>
          <Link href="/getting-started">{t("viewGettingStarted")}</Link>
          <a
            href="https://github.com/GenlookLabs/scribe-cms/tree/main/packages/scribe-cms/docs"
            target="_blank"
            rel="noopener noreferrer"
          >
            {t("viewDocs")}
          </a>
        </div>
      </main>
      <SiteFooter />
    </>
  );
}
