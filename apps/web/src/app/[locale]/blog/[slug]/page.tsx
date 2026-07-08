import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { setRequestLocale } from "next-intl/server";
import { JsonLd } from "@/components/JsonLd";
import { Markdown } from "@/components/Markdown";
import { Prose } from "@/components/Prose";
import { SiteFooter, SiteHeader } from "@/components/SiteChrome";
import { routing } from "@/i18n/routing";
import { getOpenGraphLocale } from "@/lib/locale";
import { buildLanguageAlternates } from "@/lib/metadata-alternates";
import { getScribe } from "@/lib/scribe";

const SITE_URL = "https://scribe.genlook.app";

type Props = {
  params: Promise<{ locale: string; slug: string }>;
};

function getPost(slug: string, locale: string) {
  const scribe = getScribe();
  const en = scribe.blog.get(slug);
  if (!en) return null;
  return scribe.blog.translation(en, locale) ?? en;
}

function canonicalPath(locale: string, slug: string): string {
  const path = `/blog/${slug}`;
  return locale === routing.defaultLocale ? path : `/${locale}${path}`;
}

export function generateStaticParams() {
  return getScribe()
    .blog.list()
    .map((post) => ({ slug: post.enSlug }));
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale, slug } = await params;
  const post = getPost(slug, locale);
  if (!post) return {};

  return {
    title: post.frontmatter.title,
    description: post.frontmatter.description,
    openGraph: {
      locale: getOpenGraphLocale(locale),
      type: "article",
      publishedTime: post.publishedAt ?? undefined,
    },
    alternates: {
      canonical: canonicalPath(locale, slug),
      languages: await buildLanguageAlternates(`/blog/${slug}`),
      types: {
        "text/markdown": `${locale === routing.defaultLocale ? "" : `/${locale}`}/blog/${post.slug}.md`,
      },
    },
  };
}

export default async function BlogPostPage({ params }: Props) {
  const { locale, slug } = await params;
  setRequestLocale(locale);

  const post = getPost(slug, locale);
  if (!post) notFound();

  const url = `${SITE_URL}${canonicalPath(locale, slug)}`;

  return (
    <>
      <JsonLd
        data={{
          "@context": "https://schema.org",
          "@type": "BlogPosting",
          headline: post.frontmatter.title,
          description: post.frontmatter.description,
          datePublished: post.publishedAt ?? undefined,
          inLanguage: locale,
          url,
        }}
      />
      <SiteHeader active="/blog" />
      <main className="mx-auto w-full max-w-3xl flex-1 px-6 pt-10 pb-24">
        <article className="min-w-0">
          {post.publishedAt ? (
            <time className="text-sm text-neutral-500" dateTime={post.publishedAt}>
              {post.publishedAt}
            </time>
          ) : null}
          <h1 className="mt-2 text-2xl font-semibold tracking-tight">{post.frontmatter.title}</h1>
          <p className="mt-3 max-w-2xl text-neutral-600">{post.frontmatter.description}</p>
          <a
            href={`${locale === routing.defaultLocale ? "" : `/${locale}`}/blog/${post.slug}.md`}
            className="mt-3 inline-block text-sm text-neutral-500 hover:underline"
          >
            View as Markdown
          </a>
          <div className="mt-8">
            <Prose>
              <Markdown content={post.content} />
            </Prose>
          </div>
        </article>
      </main>
      <SiteFooter />
    </>
  );
}
