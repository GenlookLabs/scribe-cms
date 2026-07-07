import fs from "node:fs";
import path from "node:path";
import type { ScribeConfig } from "../src/core/types.js";
import { getManagedRoots } from "../src/core/managed-roots.js";
import { assetPreviewUrl, encodePathSegment, escapeHtml } from "./shared.js";
import {
  assetsDirOf,
  readImageDimensions,
  resolveAssetWebPath,
  statAsset,
} from "./asset-serve.js";
import type { AssetRef, AssetRefIndex } from "./introspect-fields.js";

const IMAGE_EXT = new Set([".webp", ".png", ".jpg", ".jpeg", ".gif", ".svg", ".avif"]);

/** Recursively list image files under a managed root, returning web paths. */
function listFilesUnderRoot(assetsDir: string, root: string): string[] {
  const abs = path.join(assetsDir, root.replace(/^\/+/, ""));
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && IMAGE_EXT.has(path.extname(entry.name).toLowerCase())) {
        const rel = path.relative(assetsDir, full).split(path.sep).join("/");
        out.push(`/${rel}`);
      }
    }
  };
  walk(abs);
  return out.sort();
}

interface AssetEntry {
  webPath: string;
  refs: AssetRef[];
  exists: boolean;
  sizeKB?: number;
  width?: number;
  height?: number;
}

interface AssetBadge {
  cls: string;
  label: string;
  title: string;
}

/** Compute live badges for an asset (orphan, oversized, format drift). Missing-but-referenced is handled per-ref. */
function badgesFor(entry: AssetEntry): AssetBadge[] {
  const badges: AssetBadge[] = [];
  if (entry.exists && entry.refs.length === 0) {
    badges.push({ cls: "warn", label: "unreferenced", title: "No entry/field references this file" });
  }
  if (!entry.exists && entry.refs.length > 0) {
    badges.push({ cls: "err", label: "missing", title: "Referenced but no file on disk" });
  }
  const declaredRefs = entry.refs.filter((r) => r.declared);
  const ext = entry.webPath.split(".").pop()?.toLowerCase();
  for (const ref of declaredRefs) {
    if (
      ref.maxKB !== undefined &&
      entry.sizeKB !== undefined &&
      entry.sizeKB > ref.maxKB &&
      !badges.some((b) => b.label.startsWith("over"))
    ) {
      badges.push({ cls: "warn", label: `over ${ref.maxKB}KB`, title: `${entry.sizeKB}KB exceeds ${ref.maxKB}KB budget` });
    }
    if (
      ref.formats &&
      ref.formats.length > 0 &&
      ext &&
      !ref.formats.includes(ext) &&
      !badges.some((b) => b.label.startsWith("format"))
    ) {
      badges.push({ cls: "warn", label: `format .${ext}`, title: `.${ext} not in [${ref.formats.join(", ")}]` });
    }
  }
  return badges;
}

function renderAssetCard(entry: AssetEntry): string {
  const badges = badgesFor(entry);
  const badgeHtml = badges
    .map((b) => `<span class="vbadge ${b.cls}" title="${escapeHtml(b.title)}">${escapeHtml(b.label)}</span>`)
    .join("");

  const thumb = entry.exists
    ? `<div class="athumb"><img loading="lazy" src="${assetPreviewUrl(entry.webPath)}" alt="asset" /></div>`
    : `<div class="athumb"><span class="noimg" style="color:var(--dim);font-size:11px">missing</span></div>`;

  const refList =
    entry.refs.length > 0
      ? entry.refs
          .slice(0, 6)
          .map((ref) => {
            const href = `/types/${encodePathSegment(ref.typeId)}/${encodePathSegment(ref.enSlug)}`;
            return `<a href="${href}" title="${escapeHtml(ref.typeId + " · " + ref.field)}">${escapeHtml(ref.enSlug)}</a>`;
          })
          .join(", ")
      : `<span class="dim">unreferenced</span>`;
  const extraRefs = entry.refs.length > 6 ? ` +${entry.refs.length - 6}` : "";

  const meta = entry.exists
    ? `${entry.sizeKB !== undefined ? `${entry.sizeKB} KB` : ""}${entry.width ? ` · ${entry.width}×${entry.height}` : ""}`
    : "";

  return `<div class="acard">
    ${thumb}
    <div class="abody">
      <span class="apath">${escapeHtml(entry.webPath)}</span>
      <div class="dim" style="margin-bottom:3px">${meta}</div>
      <div>${badgeHtml || `<span class="vbadge ok">ok</span>`}</div>
      <div style="margin-top:4px">${refList}${extraRefs}</div>
    </div>
  </div>`;
}

export function renderAssetBrowser(
  config: ScribeConfig,
  assetRefs: AssetRefIndex,
): string {
  const assetsDir = assetsDirOf(config);
  const roots = getManagedRoots(config);

  if (!assetsDir || roots.length === 0) {
    return `<div class="toolbar">Assets</div>
      <p class="dim" style="padding:12px">No managed asset roots configured. Add <code>assets.managedDirs</code> or <code>field.asset({ dir })</code> to enable the asset browser.</p>`;
  }

  const sections = roots
    .map((root) => {
      const files = listFilesUnderRoot(assetsDir, root);
      // Referenced-but-missing files under this root that don't exist on disk.
      const referencedUnderRoot = [...assetRefs.keys()].filter(
        (p) => p === root || p.startsWith(root + "/"),
      );
      const allPaths = new Set<string>([...files, ...referencedUnderRoot]);

      const entries: AssetEntry[] = [...allPaths].sort().map((webPath) => {
        const refs = assetRefs.get(webPath) ?? [];
        const resolved = resolveAssetWebPath(config, webPath);
        const info = resolved ? statAsset(resolved.absPath, webPath) : null;
        const dims = resolved && info?.exists ? readImageDimensions(resolved.absPath) : null;
        return {
          webPath,
          refs,
          exists: Boolean(info?.exists),
          sizeKB: info?.sizeBytes !== undefined ? Math.round(info.sizeBytes / 1024) : undefined,
          width: dims?.width,
          height: dims?.height,
        };
      });

      const orphans = entries.filter((e) => e.exists && e.refs.length === 0).length;
      const missing = entries.filter((e) => !e.exists && e.refs.length > 0).length;
      const summary = [
        `${entries.length} files`,
        orphans ? `<span class="tag-warn">${orphans} unreferenced</span>` : "",
        missing ? `<span class="tag-err">${missing} missing</span>` : "",
      ]
        .filter(Boolean)
        .join(" · ");

      const cards = entries.map((e) => renderAssetCard(e)).join("");
      return `<div class="section">
        <div class="section-head">${escapeHtml(root)} <span class="dim">· ${summary}</span></div>
        <div class="asset-grid">${cards || `<span class="dim" style="padding:12px">No files</span>`}</div>
      </div>`;
    })
    .join("");

  return `<div class="toolbar">Assets <span class="dim">· ${roots.length} managed root(s)</span></div>${sections}`;
}
