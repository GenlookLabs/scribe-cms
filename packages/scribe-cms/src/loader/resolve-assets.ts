import type { SchemaFieldMeta } from "../core/introspect-schema.js";
import type { ResolvedAssetsConfig, ScribeDocument } from "../core/types.js";
import { walkAssetValues } from "../core/walk-asset-values.js";

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
    // For a multiple field each element is prefixed in place; the field-level
    // summary visit (raw = the array) is skipped (not a string, no template).
    walkAssetValues(
      frontmatter,
      f.path,
      ({ raw }) => {
        let value = typeof raw === "string" ? raw : undefined;
        if (value === undefined) {
          if (!f.assetTemplate) return undefined;
          value = materializeTemplate(f.assetTemplate, doc.enSlug);
        }
        return joinPublicPath(assets.publicPath, value);
      },
      { multiple: f.assetMultiple },
    );
  }
}
