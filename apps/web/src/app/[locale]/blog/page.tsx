import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { SiteFooter, SiteHeader } from "@/components/SiteChrome";
import { Link } from "@/i18n/navigation";
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
    title: t("blogTitle"),
    description: t("blogLead"),
    openGraph: {
      locale: getOpenGraphLocale(locale),
      type: "website",
    },
    alternates: {
      canonical: locale === routing.defaultLocale ? "/blog" : `/${locale}/blog`,
      languages: await buildLanguageAlternates("/blog"),
    },
  };
}

export default async function BlogIndexPage({ params }: Props) {
  const { locale } = await params;
  setRequestLocale(locale);

  const t = await getTranslations("Site");
  const scribe = getScribe();
  const posts = scribe.blog.list().map((doc) => scribe.blog.translation(doc, locale) ?? doc);

  return (
    <>
      <SiteHeader active="/blog" />
      <main className="mx-auto w-full max-w-3xl flex-1 px-6 pt-10 pb-24">
        <h1 className="text-2xl font-semibold tracking-tight">{t("blogTitle")}</h1>
        <p className="mt-2 max-w-2xl text-neutral-600">{t("blogLead")}</p>

        <ul className="mt-12 flex flex-col divide-y divide-neutral-100">
          {posts.map((post) => (
            <li key={post.enSlug}>
              <Link href={`/blog/${post.enSlug}`} className="group block py-6">
                {post.publishedAt ? (
                  <time className="text-sm text-neutral-500" dateTime={post.publishedAt}>
                    {post.publishedAt}
                  </time>
                ) : null}
                <span className="mt-1 block text-lg font-medium group-hover:underline group-hover:underline-offset-2">
                  {post.frontmatter.title}
                </span>
                <span className="mt-2 block text-sm leading-relaxed text-neutral-600">
                  {post.frontmatter.description}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </main>
      <SiteFooter />
    </>
  );
}
