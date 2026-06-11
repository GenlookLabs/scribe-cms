import type { Metadata } from "next";
import { setRequestLocale } from "next-intl/server";
import { ProseBody } from "@/components/ProseBody";
import { SiteFooter, SiteHeader } from "@/components/SiteChrome";
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
  const doc = getPageDoc(scribe, "getting-started", locale);

  return {
    title: doc?.frontmatter.title ?? "Getting started",
    description: doc?.frontmatter.description,
    openGraph: {
      locale: getOpenGraphLocale(locale),
      type: "website",
    },
    alternates: {
      canonical:
        locale === routing.defaultLocale ? "/getting-started" : `/${locale}/getting-started`,
      languages: await buildLanguageAlternates("/getting-started"),
    },
  };
}

export default async function GettingStartedPage({ params }: Props) {
  const { locale } = await params;
  setRequestLocale(locale);

  const scribe = getScribe();
  const doc = getPageDoc(scribe, "getting-started", locale);

  if (!doc) {
    throw new Error("Page content not found: content/pages/getting-started.mdx");
  }

  return (
    <>
      <SiteHeader active="/getting-started" />
      <main>
        <h1>{doc.frontmatter.title}</h1>
        <p className="lead">{doc.frontmatter.description}</p>
        <ProseBody content={doc.content} />
      </main>
      <SiteFooter />
    </>
  );
}
