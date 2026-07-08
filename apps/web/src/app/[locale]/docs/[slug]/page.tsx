import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { setRequestLocale } from "next-intl/server";
import { DocsSidebar } from "@/components/DocsSidebar";
import { JsonLd } from "@/components/JsonLd";
import { Markdown } from "@/components/Markdown";
import { Prose } from "@/components/Prose";
import { SiteFooter, SiteHeader } from "@/components/SiteChrome";
import { routing } from "@/i18n/routing";
import { getOpenGraphLocale } from "@/lib/locale";
import { buildLanguageAlternates } from "@/lib/metadata-alternates";
import { getScribe } from "@/lib/scribe";

type Props = {
  params: Promise<{ locale: string; slug: string }>;
};

function getDoc(slug: string, locale: string) {
  const scribe = getScribe();
  const en = scribe.doc.get(slug);
  if (!en) return null;
  return scribe.doc.translation(en, locale) ?? en;
}

export function generateStaticParams() {
  return getScribe()
    .doc.list()
    .map((doc) => ({ slug: doc.enSlug }));
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale, slug } = await params;
  const doc = getDoc(slug, locale);
  if (!doc) return {};

  const path = `/docs/${slug}`;
  const mdPath = `${locale === routing.defaultLocale ? "" : `/${locale}`}/docs/${doc.slug}.md`;
  return {
    title: doc.frontmatter.title,
    description: doc.frontmatter.description,
    openGraph: {
      locale: getOpenGraphLocale(locale),
      type: "article",
    },
    alternates: {
      canonical: locale === routing.defaultLocale ? path : `/${locale}${path}`,
      languages: await buildLanguageAlternates(path),
      types: { "text/markdown": mdPath },
    },
  };
}

export default async function DocPage({ params }: Props) {
  const { locale, slug } = await params;
  setRequestLocale(locale);

  const doc = getDoc(slug, locale);
  if (!doc) notFound();

  const path = `/docs/${slug}`;
  const canonical =
    locale === routing.defaultLocale
      ? `https://scribe.genlook.app${path}`
      : `https://scribe.genlook.app/${locale}${path}`;

  return (
    <>
      <JsonLd
        data={{
          "@context": "https://schema.org",
          "@type": "TechArticle",
          headline: doc.frontmatter.title,
          description: doc.frontmatter.description,
          inLanguage: locale,
          url: canonical,
        }}
      />
      <SiteHeader active="/docs" />
      <main className="mx-auto w-full max-w-5xl flex-1 px-6 pt-10 pb-24 lg:grid lg:grid-cols-[13rem_1fr] lg:items-start lg:gap-12">
        <DocsSidebar locale={locale} activeSlug={doc.enSlug} />
        <article className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight">{doc.frontmatter.title}</h1>
          <p className="mt-2 max-w-2xl text-neutral-600">{doc.frontmatter.description}</p>
          <a
            href={`${locale === routing.defaultLocale ? "" : `/${locale}`}/docs/${doc.slug}.md`}
            className="mt-2 inline-block text-sm text-neutral-500 hover:underline"
          >
            View as Markdown
          </a>
          <div className="mt-8">
            <Prose>
              <Markdown content={doc.content} />
            </Prose>
          </div>
        </article>
      </main>
      <SiteFooter />
    </>
  );
}
