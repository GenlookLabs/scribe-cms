import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { DocsSidebar, groupDocsBySection, listDocs } from "@/components/DocsSidebar";
import { SiteFooter, SiteHeader } from "@/components/SiteChrome";
import { Link } from "@/i18n/navigation";
import { routing } from "@/i18n/routing";
import { getOpenGraphLocale } from "@/lib/locale";
import { buildLanguageAlternates } from "@/lib/metadata-alternates";

type Props = {
  params: Promise<{ locale: string }>;
};

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "Site" });

  return {
    title: t("docsTitle"),
    description: t("docsLead"),
    openGraph: {
      locale: getOpenGraphLocale(locale),
      type: "website",
    },
    alternates: {
      canonical: locale === routing.defaultLocale ? "/docs" : `/${locale}/docs`,
      languages: await buildLanguageAlternates("/docs"),
    },
  };
}

export default async function DocsIndexPage({ params }: Props) {
  const { locale } = await params;
  setRequestLocale(locale);

  const t = await getTranslations("Site");
  const groups = groupDocsBySection(listDocs(locale));

  const sectionLabelKey = {
    start: "docsSectionStart",
    guides: "docsSectionGuides",
    features: "docsSectionFeatures",
    reference: "docsSectionReference",
  } as const;

  return (
    <>
      <SiteHeader active="/docs" />
      <main className="mx-auto w-full max-w-5xl flex-1 px-6 pt-10 pb-24 lg:grid lg:grid-cols-[13rem_1fr] lg:items-start lg:gap-12">
        <DocsSidebar locale={locale} />
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{t("docsTitle")}</h1>
          <p className="mt-2 max-w-2xl text-neutral-600">{t("docsLead")}</p>

          <div className="mt-10 flex flex-col gap-10">
            {groups.map((group) => (
              <section key={group.section}>
                <h2 className="text-xs font-medium tracking-wide text-neutral-400 uppercase">
                  {t(sectionLabelKey[group.section])}
                </h2>
                <ul className="mt-2 flex flex-col divide-y divide-neutral-100">
                  {group.docs.map((doc) => (
                    <li key={doc.enSlug}>
                      <Link href={`/docs/${doc.enSlug}`} className="group block py-4">
                        <span className="font-medium group-hover:underline group-hover:underline-offset-2">
                          {doc.frontmatter.title}
                        </span>
                        <span className="mt-1 block text-sm leading-relaxed text-neutral-600">
                          {doc.frontmatter.description}
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        </div>
      </main>
      <SiteFooter />
    </>
  );
}
