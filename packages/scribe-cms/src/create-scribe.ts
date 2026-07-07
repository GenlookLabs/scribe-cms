import type {
  AssetUrlOptions,
  ContentTypeInput,
  ContentTypeRuntime,
  Scribe,
  ScribeConfigInput,
} from "./core/types.js";
import { resolveConfig } from "./config/resolve-config.js";
import { createProject } from "./create-project.js";
import { joinPublicPath } from "./loader/resolve-assets.js";
import { generateSitemap } from "./sitemap/generate-sitemap.js";
import type { GenerateSitemapOptions } from "./sitemap/types.js";

/**
 * Create the typed Scribe client. Each content type id becomes a typed
 * accessor (`scribe.blog.list()`, `scribe.blog.related(doc, "author")`, …),
 * plus `scribe.sitemap()`.
 *
 * Pass the object returned by `defineConfig()`; defaults and path resolution
 * are applied here.
 */
export function createScribe<const TTypes extends readonly ContentTypeInput<any>[]>(
  input: ScribeConfigInput<TTypes>,
): Scribe<TTypes> {
  const config = resolveConfig(input);
  const project = createProject(config, { resolveAssets: true });
  const scribe = {
    config,
    project,
    getType: project.getType,
    listTypes: project.listTypes,
    listRoutableTypes: project.listRoutableTypes,
    sitemap(options: GenerateSitemapOptions) {
      return generateSitemap(project, options);
    },
    assets: {
      url(ref: string, opts?: AssetUrlOptions) {
        if (opts && Object.keys(opts).length > 0) {
          throw new Error(
            `scribe.assets.url: options are reserved for a future pipeline; got ${Object.keys(opts).join(", ")}`,
          );
        }
        const assetsConfig = config.assets;
        return assetsConfig ? joinPublicPath(assetsConfig.publicPath, ref) : ref;
      },
    },
  } as unknown as Scribe<TTypes>;

  for (const type of config.types) {
    (scribe as unknown as Record<string, ContentTypeRuntime>)[type.id] =
      project.getType(type.id);
  }

  return scribe;
}
