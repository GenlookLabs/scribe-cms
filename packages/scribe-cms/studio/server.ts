import { serve } from "@hono/node-server";
import { Hono } from "hono";
import type { ScribeProject } from "../src/core/types.js";
import { computePageEnHash } from "../src/hash/page-hash.js";
import { getTranslatablePayload, readEnDocument } from "../src/loader/create-loader.js";
import { openStore } from "../src/storage/sqlite.js";
import { listRevisions, listTranslationsForType } from "../src/storage/translations.js";
import { buildWorklist } from "../src/translate/worklist.js";

function renderLayout(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${title} — Scribe Studio</title>
  <style>
    body { font-family: ui-sans-serif, system-ui, sans-serif; margin: 0; background: #0b0d10; color: #e8eaed; }
    header { padding: 16px 24px; border-bottom: 1px solid #222; display: flex; gap: 16px; }
    header a { color: #9ecbff; text-decoration: none; }
    main { padding: 24px; }
    table { border-collapse: collapse; width: 100%; }
    th, td { border: 1px solid #333; padding: 8px 10px; text-align: left; vertical-align: top; }
    th { background: #151922; }
    .muted { color: #9aa0a6; }
    .stale { color: #ffb4a2; }
    .ok { color: #8ce99a; }
    .card { background: #151922; border: 1px solid #333; border-radius: 8px; padding: 16px; margin-bottom: 16px; }
  </style>
</head>
<body>
  <header>
    <strong>Scribe Studio</strong>
    <a href="/">Browser</a>
    <a href="/staleness">Staleness</a>
    <a href="/history">History</a>
  </header>
  <main>${body}</main>
</body>
</html>`;
}

/** Start a local read-only Scribe studio (browser, staleness, history). */
export async function startStudio(
  project: ScribeProject,
  options: { port?: number; host?: string } = {},
): Promise<void> {
  const app = new Hono();
  const config = project.config;

  app.get("/", (c) => {
    const cards = project.listTypes().map((type) => {
      const localeRows = config.locales
        .map((locale) => {
          const count = type.load().get(locale)?.bySlug.size ?? 0;
          return `<li>${locale}: ${count}</li>`;
        })
        .join("");
      return `<div class="card"><h2>${type.config.label}</h2><ul>${localeRows}</ul></div>`;
    });
    return c.html(renderLayout("Browser", cards.join("")));
  });

  app.get("/staleness", (c) => {
    const worklist = buildWorklist(config);
    const rows = worklist
      .slice(0, 500)
      .map(
        (item) =>
          `<tr><td>${item.contentType}</td><td>${item.enSlug}</td><td>${item.locale}</td><td class="stale">${item.reason}</td></tr>`,
      )
      .join("");
    const html = `<h1>Translation staleness</h1><p class="muted">${worklist.length} stale/missing entries (showing up to 500)</p>
      <table><thead><tr><th>Type</th><th>EN slug</th><th>Locale</th><th>Status</th></tr></thead><tbody>${rows}</tbody></table>`;
    return c.html(renderLayout("Staleness", html));
  });

  app.get("/history", (c) => {
    const typeId = c.req.query("type") ?? project.listTypes()[0]?.id;
    const enSlug = c.req.query("slug");
    if (!typeId) return c.html(renderLayout("History", "<p>No content types.</p>"));

    const db = openStore(config, "readonly");
    let body = `<h1>History</h1><form><label>Type <select name="type">${project
      .listTypes()
      .map((t) => `<option value="${t.id}" ${t.id === typeId ? "selected" : ""}>${t.id}</option>`)
      .join("")}</select></label> <label>EN slug <input name="slug" value="${enSlug ?? ""}" /></label> <button>View</button></form>`;

    if (enSlug) {
      const rows = listRevisions(db, typeId, enSlug)
        .slice(0, 100)
        .map(
          (row) =>
            `<tr><td>${row.created_at}</td><td>${row.revision_kind}</td><td>${row.locale ?? "en"}</td><td>${row.en_hash.slice(0, 8)}</td><td class="muted">${row.body_preview ?? ""}</td></tr>`,
        )
        .join("");
      body += `<table><thead><tr><th>When</th><th>Kind</th><th>Locale</th><th>EN hash</th><th>Preview</th></tr></thead><tbody>${rows}</tbody></table>`;
    } else {
      const translations = listTranslationsForType(db, typeId).slice(0, 100);
      body += `<ul>${translations
        .map((row) => `<li><a href="/history?type=${typeId}&slug=${row.en_slug}">${row.en_slug}</a> (${row.locale})</li>`)
        .join("")}</ul>`;
    }
    db.close();
    return c.html(renderLayout("History", body));
  });

  app.get("/api/staleness-matrix", (c) => {
    const matrix: Record<string, Record<string, number>> = {};
    for (const type of project.listTypes()) {
      matrix[type.id] = {};
      for (const locale of config.locales) {
        if (locale === config.defaultLocale) continue;
        const enSlugs = type.list().map((doc) => doc.slug);
        let stale = 0;
        for (const enSlug of enSlugs) {
          const enDoc = readEnDocument(config, type.config, enSlug);
          if (!enDoc) continue;
          const payload = getTranslatablePayload(enDoc, type.config);
          const hash = computePageEnHash(payload.frontmatter, payload.body);
          const db = openStore(config, "readonly");
          const row = db
            .prepare(
              `SELECT en_hash FROM translations WHERE content_type = ? AND en_slug = ? AND locale = ?`,
            )
            .get(type.id, enSlug, locale) as { en_hash: string } | undefined;
          db.close();
          if (!row || row.en_hash !== hash) stale++;
        }
        matrix[type.id]![locale] = stale;
      }
    }
    return c.json(matrix);
  });

  const port = options.port ?? 3600;
  const host = options.host ?? "127.0.0.1";
  serve({ fetch: app.fetch, port, hostname: host }, () => {
    console.log(`Scribe studio listening on http://${host}:${port}`);
  });
}
