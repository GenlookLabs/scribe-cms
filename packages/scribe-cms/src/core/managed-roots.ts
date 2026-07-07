import { listAssetFields } from "./introspect-schema.js";
import type { ScribeConfig } from "./types.js";

function normalizeRoot(root: string): string {
  const trimmed = `/${root.replace(/^\/+|\/+$/g, "")}`;
  return trimmed === "/" ? "" : trimmed;
}

/**
 * Managed root implied by a template's static prefix: the substring up to the
 * first `{`, with the trailing partial path segment dropped.
 * `"/try-on/garments/{slug}/product.webp"` → `"/try-on/garments"`.
 */
export function templateManagedRoot(template: string): string {
  const braceIndex = template.indexOf("{");
  const staticPart = braceIndex >= 0 ? template.slice(0, braceIndex) : template;
  const lastSlash = staticPart.lastIndexOf("/");
  const prefix = lastSlash >= 0 ? staticPart.slice(0, lastSlash) : staticPart;
  return normalizeRoot(prefix);
}

/**
 * Set of Scribe-owned source roots (web paths) for the phase-2 audit layer;
 * files outside these roots are never reported or touched. Union of
 * `assets.managedDirs` and every asset field's `dir`/`template` prefix.
 * Deduped and sorted; empty when the asset system is disabled.
 */
export function getManagedRoots(config: ScribeConfig): string[] {
  // Managed roots are meaningful only when the asset system is enabled.
  if (!config.assets) return [];

  const roots = new Set<string>();

  for (const dir of config.assets.managedDirs ?? []) {
    const normalized = normalizeRoot(dir);
    if (normalized) roots.add(normalized);
  }

  for (const type of config.types) {
    for (const f of listAssetFields(type.schema)) {
      if (f.assetDir) {
        const normalized = normalizeRoot(f.assetDir);
        if (normalized) roots.add(normalized);
      }
      if (f.assetTemplate) {
        const normalized = templateManagedRoot(f.assetTemplate);
        if (normalized) roots.add(normalized);
      }
    }
  }

  return [...roots].sort();
}
