import { Link } from "@/i18n/navigation";
import { getScribe } from "@/lib/scribe";

export function listDocs(locale: string) {
  const scribe = getScribe();
  return scribe.doc.list().map((doc) => scribe.doc.translation(doc, locale) ?? doc);
}

export function DocsSidebar({ locale, activeSlug }: { locale: string; activeSlug?: string }) {
  const docs = listDocs(locale);

  return (
    <nav aria-label="Docs" className="mb-10 lg:mb-0">
      <ul className="flex flex-col gap-1 text-sm">
        {docs.map((doc) => (
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
    </nav>
  );
}
