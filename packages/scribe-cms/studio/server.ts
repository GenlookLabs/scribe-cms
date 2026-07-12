import fs from "node:fs";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import type { ContentTypeRuntime, ScribeProject } from "../src/core/types.js";
import { isTypeTranslatable, mergeStructuralOntoLocale } from "../src/core/introspect-schema.js";
import { readEnDocument } from "../src/loader/create-loader.js";
import { openStore } from "../src/storage/sqlite.js";
import { getTranslation } from "../src/storage/translations.js";
import { validateProject } from "../src/validate/validate-project.js";
import { docTitleFromFrontmatter, encodePathSegment, escapeHtml, renderLayout } from "./shared.js";
import { buildIndexes } from "./introspect-fields.js";
import {
  bucketValidation,
  renderCollectionBrowser,
  renderContentHome,
  renderDeletionPlanPage,
  renderEntryInspector,
  typeBadges,
  type InspectorContext,
  type ValidationBuckets,
} from "./content-views.js";
import { renderAssetBrowser } from "./asset-views.js";
import {
  entryFormToolbar,
  formFieldsFor,
  renderEntryForm,
  type EntryFormContext,
} from "./entry-forms.js";
import { formValuesFromInput, readEntryForm, writeEntry } from "./entry-write.js";
import { buildDeletionPlan, isPlanBlocked, type DeletionPlan } from "../src/delete/plan.js";
import { executeDeletionPlan } from "../src/delete/execute.js";
import { renderSearchPage } from "./search.js";
import { contentTypeForPath, resolveAssetWebPath, serveStudioAsset, statAsset } from "./asset-serve.js";
import { StudioCache, computeContentFingerprint } from "./studio-cache.js";
import {
  batchedStatusDots,
  buildStalenessMatrix,
  documentStatus,
  renderTranslationDetailPanel,
  renderTranslationsPage,
  statusDot,
} from "./translation-views.js";

/**
 * Build the studio's Hono app (routes + derived-data cache) without binding a
 * port. Exposed for tests, which drive routes via `app.request(...)`.
 * `startStudio` wraps this with `@hono/node-server`.
 */
export function createStudioApp(project: ScribeProject): Hono {
  const app = new Hono();
  const config = project.config;

  // Back-ref + asset-reference indexes and the validation report are derived
  // once per content-change tick (a cheap file-count/mtime/store fingerprint)
  // and served stale-while-revalidate: only the first build blocks a request;
  // after that a fingerprint change returns the current value immediately and
  // refreshes in the background. See studio-cache.ts. The validation report
  // parses every EN + translated MDX body, which is multiple seconds on a large
  // project — doing it inline made `/types/:id` block for ~5s after any edit.
  interface StudioCacheValue {
    backRefs: ReturnType<typeof buildIndexes>["backRefs"];
    assetRefs: ReturnType<typeof buildIndexes>["assetRefs"];
    buckets: ValidationBuckets;
    typeBadges: Map<string, string>;
  }

  const studioCache = new StudioCache<StudioCacheValue>({
    fingerprint: () => computeContentFingerprint(project, config),
    build: () => {
      const { backRefs, assetRefs } = buildIndexes(project.listTypes());
      let buckets: ValidationBuckets;
      try {
        buckets = bucketValidation(validateProject(config).issues);
      } catch {
        buckets = bucketValidation([]);
      }
      return { backRefs, assetRefs, buckets, typeBadges: typeBadges(buckets) };
    },
    // First-paint placeholder so even the very first request doesn't block on the
    // multi-second MDX validation pass. Back-refs/badges fill in a moment later.
    initial: () => {
      const empty = bucketValidation([]);
      return {
        backRefs: new Map(),
        assetRefs: new Map(),
        buckets: empty,
        typeBadges: typeBadges(empty),
      };
    },
    onError: (err) => console.error("[scribe:studio] cache rebuild failed:", err),
  });

  function getStudioCache(): StudioCacheValue {
    return studioCache.get();
  }

  function getTypeSafe(id: string): ContentTypeRuntime | null {
    try {
      return project.getType(id);
    } catch {
      return null;
    }
  }

  // ------------------------------------------------------------------
  // Content home + translations section
  // ------------------------------------------------------------------

  // Content-first landing page: a grid of content-type cards.
  app.get("/", (c) => {
    const cache = getStudioCache();
    return c.html(
      renderLayout("Content", renderContentHome(project, cache.buckets), project, {
        activeNav: "content",
        typeBadges: cache.typeBadges,
      }),
    );
  });

  // Translations: one tabbed section (Coverage + Staleness).
  app.get("/translations", (c) => {
    const cache = getStudioCache();
    const tab = c.req.query("tab") === "staleness" ? "staleness" : "coverage";
    return c.html(
      renderLayout("Translations", renderTranslationsPage(project, tab), project, {
        activeNav: "translations",
        typeBadges: cache.typeBadges,
      }),
    );
  });

  app.get("/api/staleness-matrix", (c) => c.json(buildStalenessMatrix(project)));

  // ------------------------------------------------------------------
  // Legacy route redirects (301 → their content-first homes)
  // ------------------------------------------------------------------

  app.get("/dashboard", (c) => c.redirect("/translations", 301));
  app.get("/staleness", (c) => c.redirect("/translations?tab=staleness", 301));
  app.get("/type/:id", (c) =>
    c.redirect(`/types/${encodePathSegment(c.req.param("id"))}`, 301),
  );
  app.get("/type/:id/doc/:enSlug", (c) => {
    const typeId = encodePathSegment(c.req.param("id"));
    const enSlug = encodePathSegment(c.req.param("enSlug"));
    const locale = c.req.query("locale");
    const localePart = locale ? `&locale=${encodePathSegment(locale)}` : "";
    return c.redirect(`/types/${typeId}/${enSlug}?tab=translations${localePart}`, 301);
  });

  // ------------------------------------------------------------------
  // Content management surfaces (read-only)
  // ------------------------------------------------------------------

  // Traversal-safe asset preview: maps a web path onto the configured assets
  // dir and streams the SOURCE file (never the site's publicPath URL).
  app.get("/asset", (c) => {
    const webPath = c.req.query("p");
    if (!webPath) return c.text("missing p", 400);
    const resolved = resolveAssetWebPath(config, webPath);
    if (!resolved) return c.text("not found", 404);
    const info = statAsset(resolved.absPath, webPath);
    if (!info.exists) return c.text("not found", 404);
    try {
      const buf = fs.readFileSync(resolved.absPath);
      const body = new Uint8Array(buf);
      return c.body(body, 200, {
        "Content-Type": contentTypeForPath(webPath),
        "Cache-Control": "no-cache",
      });
    } catch {
      return c.text("not found", 404);
    }
  });

  // Collection browser (table / gallery + field filters).
  app.get("/types/:typeId", (c) => {
    const typeId = c.req.param("typeId");
    const type = getTypeSafe(typeId);
    const cache = getStudioCache();
    if (!type) {
      return c.html(
        renderLayout("Not found", `<div class="toolbar">Unknown type</div>`, project, {
          typeBadges: cache.typeBadges,
        }),
        404,
      );
    }
    const db = openStore(config, "readonly");
    // Precompute status dots for the whole page in one query + one hash pass,
    // then hand the renderer a pure in-memory lookup per entry.
    const statusDotsFor = batchedStatusDots(config, db, type);
    const html = renderCollectionBrowser(
      {
        project,
        config,
        type,
        buckets: cache.buckets,
        statusDots: (_tid, enSlug) => statusDotsFor(enSlug),
      },
      (key) => c.req.query(key),
    );
    db.close();
    return c.html(
      renderLayout(type.config.label, html, project, {
        activeTypeId: typeId,
        typeBadges: cache.typeBadges,
      }),
    );
  });

  // ------------------------------------------------------------------
  // Entry creation + editing. Localhost dev tool: POST-only mutations,
  // no CSRF token (same trust model as the delete route below). Every
  // successful write is a plain file write — one .md/.mdx per entry plus
  // any uploaded images under the assets dir. See entry-write.ts.
  //
  // Registered before the generic `/types/:typeId/:enSlug` routes so the
  // static "new"/"edit" segments win. These 2-/3-segment static paths are
  // matched by Hono's router ahead of the `:enSlug` param either way.
  // ------------------------------------------------------------------

  const renderFormPage = (
    ctx: EntryFormContext,
    title: string,
    crumb: string,
    entryHref: string | undefined,
    typeBadgeMap: Map<string, string>,
    status?: 200 | 422,
  ) => {
    const html = entryFormToolbar(ctx.type, crumb, entryHref) + renderEntryForm(ctx);
    const page = renderLayout(title, html, project, {
      activeTypeId: ctx.type.id,
      typeBadges: typeBadgeMap,
    });
    return status && status !== 200 ? { page, status } : { page };
  };

  // New entry form.
  app.get("/types/:typeId/new", (c) => {
    const typeId = c.req.param("typeId");
    const cache = getStudioCache();
    const type = getTypeSafe(typeId);
    if (!type) {
      return c.html(
        renderLayout("Not found", `<div class="toolbar">Unknown type</div>`, project, {
          typeBadges: cache.typeBadges,
        }),
        404,
      );
    }
    const ctx: EntryFormContext = {
      project,
      config,
      type,
      mode: "create",
      slug: "",
      values: {},
      body: "",
      postAction: `/types/${encodePathSegment(typeId)}/new`,
      cancelHref: `/types/${encodePathSegment(typeId)}`,
    };
    const { page } = renderFormPage(ctx, `New ${type.config.label}`, "New entry", undefined, cache.typeBadges);
    return c.html(page);
  });

  app.post("/types/:typeId/new", async (c) => {
    const typeId = c.req.param("typeId");
    const cache = getStudioCache();
    const type = getTypeSafe(typeId);
    if (!type) return c.text("Unknown type", 404);
    const fields = formFieldsFor(type.config.schema);
    const input = await readEntryForm(c, fields);
    const result = writeEntry(project, type, "create", input);
    if (result.ok) {
      studioCache.invalidate();
      studioCache.get();
      return c.redirect(
        `/types/${encodePathSegment(typeId)}/${encodePathSegment(input.slug.trim())}`,
        303,
      );
    }
    const ctx: EntryFormContext = {
      project,
      config,
      type,
      mode: "create",
      slug: input.slug,
      values: formValuesFromInput(fields, input),
      body: input.body,
      errors: result.errors,
      postAction: `/types/${encodePathSegment(typeId)}/new`,
      cancelHref: `/types/${encodePathSegment(typeId)}`,
    };
    const { page, status } = renderFormPage(
      ctx,
      `New ${type.config.label}`,
      "New entry",
      undefined,
      cache.typeBadges,
      422,
    );
    return c.html(page, status ?? 200);
  });

  // Edit entry form.
  app.get("/types/:typeId/:enSlug/edit", (c) => {
    const typeId = c.req.param("typeId");
    const enSlug = c.req.param("enSlug");
    const cache = getStudioCache();
    const type = getTypeSafe(typeId);
    if (!type) {
      return c.html(
        renderLayout("Not found", `<div class="toolbar">Unknown type</div>`, project, {
          typeBadges: cache.typeBadges,
        }),
        404,
      );
    }
    const enDoc = readEnDocument(config, type.config, enSlug);
    if (!enDoc) {
      return c.html(
        renderLayout(
          "Not found",
          `<div class="toolbar">Not found</div><p class="dim" style="padding:12px">${escapeHtml(enSlug)}</p>`,
          project,
          { activeTypeId: typeId, typeBadges: cache.typeBadges },
        ),
        404,
      );
    }
    const entryHref = `/types/${encodePathSegment(typeId)}/${encodePathSegment(enSlug)}`;
    const ctx: EntryFormContext = {
      project,
      config,
      type,
      mode: "edit",
      slug: enSlug,
      values: enDoc.frontmatter as Record<string, unknown>,
      body: type.config.body === false ? "" : enDoc.content,
      postAction: `${entryHref}/edit`,
      cancelHref: entryHref,
    };
    const { page } = renderFormPage(ctx, `Edit ${enSlug}`, enSlug, entryHref, cache.typeBadges);
    return c.html(page);
  });

  app.post("/types/:typeId/:enSlug/edit", async (c) => {
    const typeId = c.req.param("typeId");
    const enSlug = c.req.param("enSlug");
    const cache = getStudioCache();
    const type = getTypeSafe(typeId);
    if (!type) return c.text("Unknown type", 404);
    const fields = formFieldsFor(type.config.schema);
    const input = await readEntryForm(c, fields);
    // Slug is fixed on edit — always take it from the route, never the form.
    input.slug = enSlug;
    const result = writeEntry(project, type, "edit", input);
    const entryHref = `/types/${encodePathSegment(typeId)}/${encodePathSegment(enSlug)}`;
    if (result.ok) {
      studioCache.invalidate();
      studioCache.get();
      return c.redirect(entryHref, 303);
    }
    // Prefill asset fields from the on-disk doc, overlay submitted scalar values.
    const enDoc = readEnDocument(config, type.config, enSlug);
    const base = (enDoc?.frontmatter as Record<string, unknown>) ?? {};
    const ctx: EntryFormContext = {
      project,
      config,
      type,
      mode: "edit",
      slug: enSlug,
      values: { ...base, ...formValuesFromInput(fields, input) },
      body: input.body,
      errors: result.errors,
      postAction: `${entryHref}/edit`,
      cancelHref: entryHref,
    };
    const { page, status } = renderFormPage(ctx, `Edit ${enSlug}`, enSlug, entryHref, cache.typeBadges, 422);
    return c.html(page, status ?? 200);
  });

  // Entry inspector.
  app.get("/types/:typeId/:enSlug", (c) => {
    const typeId = c.req.param("typeId");
    const enSlug = c.req.param("enSlug");
    const locale = c.req.query("locale") ?? config.defaultLocale;
    const type = getTypeSafe(typeId);
    const cache = getStudioCache();
    if (!type) {
      return c.html(
        renderLayout("Not found", `<div class="toolbar">Unknown type</div>`, project, {
          typeBadges: cache.typeBadges,
        }),
        404,
      );
    }
    const enDoc = readEnDocument(config, type.config, enSlug);
    if (!enDoc) {
      return c.html(
        renderLayout(
          "Not found",
          `<div class="toolbar">Not found</div><p class="dim" style="padding:12px">${escapeHtml(enSlug)}</p>`,
          project,
          { activeTypeId: typeId, typeBadges: cache.typeBadges },
        ),
        404,
      );
    }

    const translatable = isTypeTranslatable(type.config);
    const bodyView = c.req.query("body") === "preview" ? "preview" : "raw";
    const showRaw = c.req.query("raw") === "1";
    // The "Translations" tab only exists for translatable types; a stray
    // `?tab=translations` on a non-translatable type falls back to Details.
    const view: "details" | "translations" =
      c.req.query("tab") === "translations" && translatable ? "translations" : "details";

    // Inspector self-URL builder — composes query params in a stable order so
    // the locale tabs, view tabs, and body/frontmatter toggles all agree.
    const inspectorHref = (opts: {
      translations?: boolean;
      locale?: string;
      preview?: boolean;
      raw?: boolean;
    }): string => {
      const p = new URLSearchParams();
      if (opts.translations) p.set("tab", "translations");
      if (opts.locale && opts.locale !== config.defaultLocale) p.set("locale", opts.locale);
      if (opts.preview) p.set("body", "preview");
      if (opts.raw) p.set("raw", "1");
      const qs = p.toString();
      return `/types/${encodePathSegment(typeId)}/${encodePathSegment(enSlug)}${qs ? `?${qs}` : ""}`;
    };

    const db = openStore(config, "readonly");

    // Locale tabs reuse the existing status-dot component. Non-translatable types
    // have only an EN source, so we skip the per-locale tabs entirely. Each tab
    // preserves the current view + body so switching locale never drops you back
    // to Details or Raw.
    const tabLocales = translatable ? config.locales : [config.defaultLocale];
    const localeTabs = tabLocales
      .map((loc) => {
        const { status } = documentStatus(config, db, type, enSlug, loc);
        const active = loc === locale ? " active" : "";
        const href = inspectorHref({
          translations: view === "translations",
          locale: loc,
          preview: bodyView === "preview",
        });
        return `<a class="tab${active}" href="${href}">${escapeHtml(loc)} ${statusDot(status)}</a>`;
      })
      .join("");

    // View tabs: Details (default) + Translations (translatable types only).
    const viewTabs = translatable
      ? `<div class="tabs">
          <a class="tab${view === "details" ? " active" : ""}" href="${inspectorHref({
            locale,
            preview: bodyView === "preview",
          })}">Details</a>
          <a class="tab${view === "translations" ? " active" : ""}" href="${inspectorHref({
            translations: true,
            locale,
            preview: bodyView === "preview",
          })}">Translations</a>
        </div>`
      : "";

    // Merged locale frontmatter (structural from EN + translatable from store).
    let localeFrontmatter: Record<string, unknown> | null = null;
    let isFallback = false;
    if (locale !== config.defaultLocale) {
      const translation = getTranslation(db, typeId, enSlug, locale);
      if (translation) {
        const rawFm = JSON.parse(translation.frontmatter_json) as Record<string, unknown>;
        localeFrontmatter = mergeStructuralOntoLocale(
          rawFm,
          enDoc.frontmatter as Record<string, unknown>,
          type.config.schema,
        );
      } else {
        isFallback = true;
      }
    }
    db.close();

    // The per-locale translation detail (its own db read) is only built for the
    // Translations tab; its frontmatter/body toggles route back through the
    // inspector URL with `tab=translations` preserved.
    const translationDetail =
      view === "translations"
        ? renderTranslationDetailPanel({
            project,
            config,
            type,
            enSlug,
            locale,
            enDoc,
            showRaw,
            bodyView,
            buildHref: (raw, preview) =>
              inspectorHref({ translations: true, locale, raw, preview }),
          })
        : undefined;

    // Prev/next in the collection's default order (same order the table uses).
    // Preserve the current view + locale + body query params on the target hrefs.
    const orderedSlugs = type.list().map((d) => d.enSlug);
    const currentIndex = orderedSlugs.indexOf(enSlug);
    const linkFor = (slug: string) => {
      const p = new URLSearchParams();
      if (view === "translations") p.set("tab", "translations");
      if (locale !== config.defaultLocale) p.set("locale", locale);
      if (bodyView === "preview") p.set("body", "preview");
      const qs = p.toString();
      return `/types/${encodePathSegment(typeId)}/${encodePathSegment(slug)}${qs ? `?${qs}` : ""}`;
    };
    const prev =
      currentIndex > 0
        ? { href: linkFor(orderedSlugs[currentIndex - 1]!), slug: orderedSlugs[currentIndex - 1]! }
        : null;
    const next =
      currentIndex >= 0 && currentIndex < orderedSlugs.length - 1
        ? { href: linkFor(orderedSlugs[currentIndex + 1]!), slug: orderedSlugs[currentIndex + 1]! }
        : null;
    const deleteHref = `/types/${encodePathSegment(typeId)}/${encodePathSegment(enSlug)}/delete`;
    const editHref = `/types/${encodePathSegment(typeId)}/${encodePathSegment(enSlug)}/edit`;

    const ctx: InspectorContext = {
      project,
      config,
      type,
      enSlug,
      locale,
      enDoc,
      localeFrontmatter,
      isFallback,
      backRefs: cache.backRefs,
      buckets: cache.buckets,
      localeTabs,
      viewTabs,
      view,
      translationDetail,
      bodyView,
      prev,
      next,
      deleteHref,
      editHref,
    };
    const title = docTitleFromFrontmatter(enDoc.frontmatter as Record<string, unknown>, enSlug);
    return c.html(
      renderLayout(title, renderEntryInspector(ctx), project, {
        activeTypeId: typeId,
        typeBadges: cache.typeBadges,
      }),
    );
  });

  // Entry deletion: confirmation page (GET) + execution (POST). The studio's
  // first mutating route; it stays a localhost dev tool (POST-only, no CSRF).
  app.get("/types/:typeId/:enSlug/delete", (c) => {
    const typeId = c.req.param("typeId");
    const enSlug = c.req.param("enSlug");
    const cache = getStudioCache();
    const type = getTypeSafe(typeId);
    if (!type) {
      return c.html(
        renderLayout("Not found", `<div class="toolbar">Unknown type</div>`, project, {
          typeBadges: cache.typeBadges,
        }),
        404,
      );
    }
    let plan: DeletionPlan;
    try {
      plan = buildDeletionPlan(project, typeId, enSlug);
    } catch {
      return c.html(
        renderLayout(
          "Not found",
          `<div class="toolbar">Not found</div><p class="dim" style="padding:12px">${escapeHtml(enSlug)}</p>`,
          project,
          { activeTypeId: typeId, typeBadges: cache.typeBadges },
        ),
        404,
      );
    }
    const cancelHref = `/types/${encodePathSegment(typeId)}/${encodePathSegment(enSlug)}`;
    const postHref = `/types/${encodePathSegment(typeId)}/${encodePathSegment(enSlug)}/delete`;
    const html = renderDeletionPlanPage(project, plan, { typeId, enSlug, cancelHref, postHref });
    return c.html(
      renderLayout(`Delete ${enSlug}`, html, project, {
        activeTypeId: typeId,
        typeBadges: cache.typeBadges,
      }),
    );
  });

  app.post("/types/:typeId/:enSlug/delete", async (c) => {
    const typeId = c.req.param("typeId");
    const enSlug = c.req.param("enSlug");
    const type = getTypeSafe(typeId);
    if (!type) return c.text("Unknown type", 404);
    let plan: DeletionPlan;
    try {
      plan = buildDeletionPlan(project, typeId, enSlug);
    } catch {
      return c.text("Not found", 404);
    }
    if (isPlanBlocked(plan)) {
      // A blocked plan can never be executed; bounce back to the confirmation page.
      return c.redirect(
        `/types/${encodePathSegment(typeId)}/${encodePathSegment(enSlug)}/delete`,
        303,
      );
    }
    try {
      executeDeletionPlan(project, plan);
    } catch (err) {
      console.error("[scribe:studio] deletion failed:", err);
      return c.text("Deletion failed", 500);
    }
    // Refresh derived data so the collection view reflects the deletion at once.
    studioCache.invalidate();
    studioCache.get();
    return c.redirect(`/types/${encodePathSegment(typeId)}`, 303);
  });

  // Global full-text search (EN content).
  app.get("/search", (c) => {
    const q = c.req.query("q") ?? "";
    const cache = getStudioCache();
    const html = renderSearchPage(project, q);
    return c.html(
      renderLayout("Search", html, project, {
        activeNav: "search",
        typeBadges: cache.typeBadges,
        searchQuery: q,
      }),
    );
  });

  // Asset browser.
  app.get("/assets", (c) => {
    const cache = getStudioCache();
    const html = renderAssetBrowser(config, cache.assetRefs);
    return c.html(
      renderLayout("Assets", html, project, {
        activeNav: "assets",
        typeBadges: cache.typeBadges,
      }),
    );
  });

  app.get("/*", (c) => {
    const asset = serveStudioAsset(config, c.req.path);
    if (!asset) {
      return c.html(renderLayout("Not found", `<div class="toolbar">Not found</div>`, project), 404);
    }
    return c.body(asset.body, 200, {
      "Content-Type": asset.contentType,
      "Cache-Control": "no-cache",
    });
  });

  // Warm the derived-data cache (back-refs, asset graph, validation report) and
  // every content loader off the request path. The full build parses ~all EN
  // docs and validates every MDX body — multiple seconds on a large project.
  // Without this, that cost is scheduled by the *first* request and, running
  // synchronously on the event loop, blocks whichever request arrives next
  // (observed: a ~4s stall on the second navigation). Priming it means the build
  // has usually finished before the first click. Fire-and-forget: `get()`
  // returns the placeholder immediately and schedules the real build via its own
  // scheduler, which also calls `type.list()` for every type and so warms all
  // loaders. Errors surface through the cache's `onError`.
  try {
    studioCache.get();
  } catch (err) {
    console.error("[scribe:studio] boot warm-up failed:", err);
  }

  return app;
}

/** Start a local read-only Scribe studio (browser, translations, assets, edit). */
export async function startStudio(
  project: ScribeProject,
  options: { port?: number; host?: string } = {},
): Promise<void> {
  const app = createStudioApp(project);
  const port = options.port ?? 3600;
  const host = options.host ?? "127.0.0.1";
  serve({ fetch: app.fetch, port, hostname: host }, () => {
    console.log(`Scribe studio listening on http://${host}:${port}`);
  });
}
