import type {
  ContentTypeInput,
  ContentTypeRuntime,
  Scribe,
  ScribeConfigInput,
} from "./core/types.js";
import { resolveConfig } from "./config/resolve-config.js";
import { createProject } from "./create-project.js";
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
  const project = createProject(config);
  const scribe = {
    config,
    project,
    getType: project.getType,
    listTypes: project.listTypes,
    listRoutableTypes: project.listRoutableTypes,
    sitemap(options: GenerateSitemapOptions) {
      return generateSitemap(project, options);
    },
  } as unknown as Scribe<TTypes>;

  for (const type of config.types) {
    (scribe as unknown as Record<string, ContentTypeRuntime>)[type.id] =
      project.getType(type.id);
  }

  return scribe;
}
