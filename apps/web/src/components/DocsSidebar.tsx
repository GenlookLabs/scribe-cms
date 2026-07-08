import { useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";
import { getScribe } from "@/lib/scribe";

type DocEntry = ReturnType<typeof listDocs>[number];

const SECTION_ORDER = ["start", "guides", "features", "reference"] as const;
type DocSection = (typeof SECTION_ORDER)[number];

const SECTION_LABEL_KEY: Record<DocSection, string> = {
  start: "docsSectionStart",
  guides: "docsSectionGuides",
  features: "docsSectionFeatures",
  reference: "docsSectionReference",
};

export function listDocs(locale: string) {
  const scribe = getScribe();
  return scribe.doc.list().map((doc) => scribe.doc.translation(doc, locale) ?? doc);
}

/** Group docs by their `section` frontmatter (defaulting to "guides"), in section order. */
export function groupDocsBySection(docs: DocEntry[]): { section: DocSection; docs: DocEntry[] }[] {
  return SECTION_ORDER.map((section) => ({
    section,
    docs: docs.filter((doc) => (doc.frontmatter.section ?? "guides") === section),
  })).filter((group) => group.docs.length > 0);
}

export function DocsSidebar({ locale, activeSlug }: { locale: string; activeSlug?: string }) {
  const t = useTranslations("Site");
  const groups = groupDocsBySection(listDocs(locale));

  return (
    <nav aria-label="Docs" className="mb-10 lg:mb-0">
      <div className="flex flex-col gap-5">
        {groups.map((group) => (
          <div key={group.section}>
            <p className="mb-1.5 px-2.5 text-xs font-medium tracking-wide text-neutral-400 uppercase">
              {t(SECTION_LABEL_KEY[group.section])}
            </p>
            <ul className="flex flex-col gap-1 text-sm">
              {group.docs.map((doc) => (
                <li key={doc.enSlug}>
                  <Link
                    href={`/docs/${doc.enSlug}`}
                    className={
                      doc.enSlug === activeSlug
                        ? "block rounded-md bg-neutral-100 px-2.5 py-1.5 font-medium text-neutral-900"
                        : "block rounded-md px-2.5 py-1.5 text-neutral-600 hover:bg-neutral-50 hover:text-neutral-900"
                    }
                  >
                    {doc.frontmatter.title}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </nav>
  );
}
