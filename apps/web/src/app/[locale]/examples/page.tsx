import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { CodeBlock } from "@/components/CodeBlock";
import { SiteFooter, SiteHeader } from "@/components/SiteChrome";
import { routing } from "@/i18n/routing";
import { getOpenGraphLocale } from "@/lib/locale";
import { getScribe } from "@/lib/scribe";

type Props = {
  params: Promise<{ locale: string }>;
};

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "Site" });

  return {
    title: t("examplesTitle"),
    description: t("examplesLead"),
    openGraph: {
      locale: getOpenGraphLocale(locale),
      type: "website",
    },
    alternates: {
      canonical: locale === routing.defaultLocale ? "/examples" : `/${locale}/examples`,
      languages: {
        en: "/examples",
        fr: "/fr/examples",
      },
    },
  };
}

export default async function ExamplesPage({ params }: Props) {
  const { locale } = await params;
  setRequestLocale(locale);

  const t = await getTranslations("Site");
  const scribe = getScribe();
  const examples = scribe.example
    .list(locale)
    .sort((a, b) => a.frontmatter.order - b.frontmatter.order);

  return (
    <>
      <SiteHeader active="/examples" />
      <main>
        <h1>{t("examplesTitle")}</h1>
        <p className="lead">{t("examplesLead")}</p>

        <div className="example-list">
          {examples.map((doc) => (
            <section key={doc.slug} id={doc.slug} className="example">
              <div className="example-header">
                <h2 className="example-title">{doc.frontmatter.title}</h2>
                <p className="example-caption">{doc.frontmatter.caption}</p>
              </div>
              <CodeBlock code={doc.content} language={doc.frontmatter.language} />
            </section>
          ))}
        </div>
      </main>
      <SiteFooter />
    </>
  );
}
