import type { SchemaFieldMeta } from "../core/introspect-schema.js";
import type { ResolvedAssetsConfig, ScribeDocument } from "../core/types.js";

/**
 * Join `publicPath` in front of a root-relative web path, avoiding double
 * slashes. Handles the `"/"` identity case, absolute origins
 * (`https://cdn.example.com/`), and path prefixes (`/static/`).
 */
export function joinPublicPath(publicPath: string, webPath: string): string {
  if (publicPath === "" || publicPath === "/") return webPath;
  const suffix = webPath.startsWith("/") ? webPath : `/${webPath}`;
  return publicPath.replace(/\/+$/, "") + suffix;
}

function materializeTemplate(template: string, enSlug: string): string {
  return template.split("{slug}").join(enSlug);
}

/**
 * Navigate to each concrete location of an asset field path (arrays at `*`
 * segments) and replace the leaf via `transform`. A `template`-backed field
 * whose value is absent is materialized at the leaf when the immediate parent
 * container exists; a top-level absent leaf is set directly on the frontmatter.
 */
function setAssetAtPath(
  container: Record<string, unknown>,
  path: string[],
  transform: (current: string | undefined) => string | undefined,
): void {
  const [head, ...rest] = path;
  if (head === undefined) return;

  if (rest.length === 0) {
    const current = container[head];
    const next = transform(typeof current === "string" ? current : undefined);
    if (next !== undefined) container[head] = next;
    return;
  }

  if (rest[0] === "*") {
    const arr = container[head];
    if (!Array.isArray(arr)) return;
    for (const item of arr) {
      if (item && typeof item === "object" && !Array.isArray(item)) {
        setAssetAtPath(item as Record<string, unknown>, rest.slice(1), transform);
      }
    }
    return;
  }

  const child = container[head];
  if (child && typeof child === "object" && !Array.isArray(child)) {
    setAssetAtPath(child as Record<string, unknown>, rest, transform);
  }
}

/**
 * Resolve declared asset fields on a freshly-built document's frontmatter,
 * in place: materialize templated paths (`{slug}` → EN slug) and prefix
 * `assets.publicPath`. Runs after `mergeStructuralOntoLocale`, so locale
 * documents resolve from the merged EN source values.
 */
export function resolveDocumentAssets(
  doc: ScribeDocument,
  assetFields: SchemaFieldMeta[],
  assets: ResolvedAssetsConfig,
): void {
  const frontmatter = doc.frontmatter as Record<string, unknown>;
  for (const f of assetFields) {
    setAssetAtPath(frontmatter, f.path, (current) => {
      let value = current;
      if (value === undefined) {
        if (!f.assetTemplate) return undefined;
        value = materializeTemplate(f.assetTemplate, doc.enSlug);
      }
      return joinPublicPath(assets.publicPath, value);
    });
  }
}
