import type { Metadata } from "next";
import { setRequestLocale } from "next-intl/server";
import { Code } from "@/components/Code";
import { JsonLd } from "@/components/JsonLd";
import { SiteFooter, SiteHeader } from "@/components/SiteChrome";
import { Link } from "@/i18n/navigation";
import { routing } from "@/i18n/routing";
import { getOpenGraphLocale } from "@/lib/locale";
import { buildLanguageAlternates } from "@/lib/metadata-alternates";
import { getScribe } from "@/lib/scribe";

type Props = {
  params: Promise<{ locale: string }>;
};

const GITHUB_URL = "https://github.com/GenlookLabs/scribe-cms";
const SITE_URL = "https://scribe.genlook.app";

const STEP_SNIPPETS: { code: string; lang: string }[] = [
  {
    lang: "ts",
    code: `// scribe.config.ts
defineContentType({
  id: "blog",
  path: "/blog/{slug}",
  slugStrategy: "localized",
  schema: z.object({
    title: field.translatable(z.string().min(1)),
    description: field.translatable(z.string().min(50)),
    author: field.relation("author"),
    heroImage: field.structural(z.string().optional()),
  }),
});`,
  },
  {
    lang: "mdx",
    code: `---
title: "Hello, world"
description: "A first post that says hello to the world."
author: jane
publishedAt: "2026-01-15"
---

The body is MDX. **Markdown** and <Components /> both work.`,
  },
  {
    lang: "bash",
    code: `export GEMINI_API_KEY=...

npx scribe translate --locale fr de --dry-run   # show the worklist
npx scribe translate --locale fr de             # translate, validate, store
git add .scribe/store.sqlite                    # translations live in git`,
  },
  {
    lang: "ts",
    code: `const scribe = createScribe(config);

const posts = scribe.blog.list("fr");                  // BlogDoc[]
const { document } = scribe.blog.resolve(slug, "fr");  // EN fallback built in
const author = scribe.blog.related(document!, "author"); // AuthorDoc
const hreflang = scribe.blog.alternates(document!);`,
  },
];

function getLanding(locale: string) {
  const scribe = getScribe();
  const en = scribe.landing.get("home");
  if (!en) throw new Error("Landing content not found: content/landing/home.mdx");
  return scribe.landing.translation(en, locale) ?? en;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  const doc = getLanding(locale);

  return {
    title: doc.frontmatter.title,
    description: doc.frontmatter.description,
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

  const doc = getLanding(locale);
  const f = doc.frontmatter;
  const url = locale === routing.defaultLocale ? SITE_URL : `${SITE_URL}/${locale}`;

  return (
    <>
      <JsonLd
        data={{
          "@context": "https://schema.org",
          "@type": "SoftwareApplication",
          name: "Scribe CMS",
          applicationCategory: "DeveloperApplication",
          operatingSystem: "Node.js",
          offers: {
            "@type": "Offer",
            price: 0,
            priceCurrency: "USD",
          },
          url,
          description: f.description,
        }}
      />
      <SiteHeader active="/" />
      <main className="mx-auto w-full max-w-3xl flex-1 px-6 pt-14 pb-24">
        {/* Hero */}
        <section>
          <h1 className="max-w-2xl text-3xl font-semibold tracking-tight text-balance sm:text-4xl">
            {f.title}
          </h1>
          <p className="mt-4 max-w-2xl text-base leading-relaxed text-neutral-600 sm:text-lg">
            {f.description}
          </p>

          <div className="mt-7">
            <Code code={f.installCommand} lang="bash" />
          </div>

          <div className="mt-6 flex flex-wrap items-center gap-3">
            <Link
              href="/docs"
              className="rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-700"
            >
              {f.ctaDocs}
            </Link>
            <a
              href={GITHUB_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="rounded-md border border-neutral-200 px-4 py-2 text-sm font-medium hover:border-neutral-400"
            >
              {f.ctaGithub}
            </a>
          </div>
        </section>

        {/* How it works */}
        <section className="mt-20">
          <h2 className="text-xl font-semibold tracking-tight">{f.howHeading}</h2>
          <ol className="mt-8 space-y-12">
            {f.steps.map((step, i) => (
              <li key={step.title}>
                <div className="flex items-baseline gap-3">
                  <span className="font-mono text-sm text-neutral-400">{i + 1}</span>
                  <h3 className="text-base font-semibold">{step.title}</h3>
                </div>
                <p className="mt-2 max-w-2xl text-sm leading-relaxed text-neutral-600">
                  {step.body}
                </p>
                {STEP_SNIPPETS[i] ? (
                  <div className="mt-4">
                    <Code code={STEP_SNIPPETS[i].code} lang={STEP_SNIPPETS[i].lang} />
                  </div>
                ) : null}
              </li>
            ))}
          </ol>
        </section>

        {/* Features */}
        <section className="mt-20">
          <h2 className="text-xl font-semibold tracking-tight">{f.featuresHeading}</h2>
          <div className="mt-8 grid gap-x-10 gap-y-8 sm:grid-cols-2">
            {f.features.map((feature) => (
              <div key={feature.title}>
                <h3 className="text-sm font-semibold">{feature.title}</h3>
                <p className="mt-1.5 text-sm leading-relaxed text-neutral-600">{feature.body}</p>
              </div>
            ))}
          </div>
        </section>

        {/* Contribute */}
        <section className="mt-20 border-t border-neutral-200 pt-10">
          <h2 className="text-xl font-semibold tracking-tight">{f.contributeHeading}</h2>
          <p className="mt-3 max-w-2xl text-sm leading-relaxed text-neutral-600">
            {f.contributeBody}
          </p>
          <div className="mt-5 flex flex-wrap gap-x-5 gap-y-2 text-sm">
            <a
              href={GITHUB_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="underline underline-offset-2 hover:text-neutral-500"
            >
              GitHub
            </a>
            <a
              href="https://www.npmjs.com/package/scribe-cms"
              target="_blank"
              rel="noopener noreferrer"
              className="underline underline-offset-2 hover:text-neutral-500"
            >
              npm
            </a>
            <Link href="/changelog" className="underline underline-offset-2 hover:text-neutral-500">
              Changelog
            </Link>
          </div>
        </section>
      </main>
      <SiteFooter />
    </>
  );
}
