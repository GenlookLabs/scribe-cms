import fs from "node:fs";
import path from "node:path";
import type { ScribeConfig } from "../src/core/types.js";

/**
 * Read-only asset serving for the studio. The studio previews SOURCE files off
 * disk (never the site's resolved/publicPath URLs), so every surface points its
 * <img> at `/asset?p=<web-path>` and this module maps that web path back onto
 * the configured assets dir — traversal-safe.
 */

const CONTENT_TYPES: Record<string, string> = {
  ".webp": "image/webp",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".mp4": "video/mp4",
};

export function contentTypeForPath(webPath: string): string {
  return CONTENT_TYPES[path.extname(webPath).toLowerCase()] ?? "application/octet-stream";
}

/** The absolute assets directory the studio serves from, or null when disabled. */
export function assetsDirOf(config: ScribeConfig): string | null {
  return config.assets?.assetsPath ?? config.assetsPath ?? null;
}

export interface ResolvedAssetPath {
  /** Absolute path on disk, guaranteed to be inside the assets dir. */
  absPath: string;
}

/**
 * Map a root-relative web path onto the assets dir, refusing anything that
 * escapes it. Returns null when the asset system is disabled or the resolved
 * path would land outside the assets root (path traversal, absolute paths,
 * symlink-free string check). Pure: no filesystem access — safe to unit-test.
 */
export function resolveAssetWebPath(
  config: ScribeConfig,
  webPath: string,
): ResolvedAssetPath | null {
  const assetsDir = assetsDirOf(config);
  if (!assetsDir) return null;
  if (typeof webPath !== "string" || webPath.length === 0) return null;

  // Reject NUL and normalize to a root-relative path. Decode is the caller's job
  // (query params arrive decoded); we still guard against embedded traversal.
  if (webPath.includes("\0")) return null;

  const root = path.resolve(assetsDir);
  // Strip any leading slashes so path.join can't treat it as absolute, then
  // resolve and verify containment. `path.resolve` collapses `..` segments.
  const relative = webPath.replace(/^\/+/, "");
  const absPath = path.resolve(root, relative);

  // Containment check: absPath must equal root or sit strictly beneath it.
  const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
  if (absPath !== root && !absPath.startsWith(rootWithSep)) return null;

  return { absPath };
}

export interface AssetFileInfo {
  exists: boolean;
  sizeBytes?: number;
  contentType: string;
}

export interface StudioAssetResponse {
  /** Backed by a plain ArrayBuffer (not SharedArrayBuffer) so Hono's `c.body` accepts it. */
  body: Uint8Array<ArrayBuffer>;
  contentType: string;
}

/** Read and return a traversal-safe asset file for studio preview serving. */
export function serveStudioAsset(
  config: ScribeConfig,
  rawWebPath: string,
): StudioAssetResponse | null {
  let webPath: string;
  try {
    webPath = decodeURIComponent(rawWebPath);
  } catch {
    return null;
  }
  const resolved = resolveAssetWebPath(config, webPath);
  if (!resolved) return null;
  const info = statAsset(resolved.absPath, webPath);
  if (!info.exists) return null;
  try {
    const buf = fs.readFileSync(resolved.absPath);
    // Copy into a fresh ArrayBuffer-backed view so the type is Uint8Array<ArrayBuffer>.
    const body = new Uint8Array(buf.byteLength);
    body.set(buf);
    return { body, contentType: contentTypeForPath(webPath) };
  } catch {
    return null;
  }
}

/** Stat a resolved asset (existence + size). */
export function statAsset(absPath: string, webPath: string): AssetFileInfo {
  const contentType = contentTypeForPath(webPath);
  try {
    const stat = fs.statSync(absPath);
    if (!stat.isFile()) return { exists: false, contentType };
    return { exists: true, sizeBytes: stat.size, contentType };
  } catch {
    return { exists: false, contentType };
  }
}

export interface ImageDimensions {
  width: number;
  height: number;
}

/**
 * Read image dimensions from the file header when cheap (PNG, JPEG, WEBP, GIF);
 * returns null otherwise. Reads only the leading bytes needed. Never throws.
 */
export function readImageDimensions(absPath: string): ImageDimensions | null {
  let fd: number | undefined;
  try {
    fd = fs.openSync(absPath, "r");
    const head = Buffer.alloc(64);
    const read = fs.readSync(fd, head, 0, 64, 0);
    if (read < 24) return null;
    return dimensionsFromHeader(head, fd);
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
}

function dimensionsFromHeader(head: Buffer, fd: number): ImageDimensions | null {
  // PNG: 8-byte signature, then IHDR (width/height as big-endian u32 at 16/20).
  if (head.readUInt32BE(0) === 0x89504e47) {
    return { width: head.readUInt32BE(16), height: head.readUInt32BE(20) };
  }
  // GIF: "GIF8", width/height little-endian u16 at offset 6/8.
  if (head.toString("ascii", 0, 4) === "GIF8") {
    return { width: head.readUInt16LE(6), height: head.readUInt16LE(8) };
  }
  // WEBP: RIFF....WEBP — VP8/VP8L/VP8X variants.
  if (head.toString("ascii", 0, 4) === "RIFF" && head.toString("ascii", 8, 12) === "WEBP") {
    return webpDimensions(head);
  }
  // JPEG: scan SOFn markers for dimensions (needs streaming past the header).
  if (head[0] === 0xff && head[1] === 0xd8) {
    return jpegDimensions(fd);
  }
  return null;
}

function webpDimensions(head: Buffer): ImageDimensions | null {
  const format = head.toString("ascii", 12, 16);
  if (format === "VP8 ") {
    // Lossy: 16-bit width/height at bytes 26/28 (14-bit, low bits).
    const width = head.readUInt16LE(26) & 0x3fff;
    const height = head.readUInt16LE(28) & 0x3fff;
    return { width, height };
  }
  if (format === "VP8L") {
    // Lossless: 14-bit dimensions packed after the 0x2f signature byte at 21.
    const b0 = head[21]!;
    const b1 = head[22]!;
    const b2 = head[23]!;
    const b3 = head[24]!;
    const width = 1 + (((b1 & 0x3f) << 8) | b0);
    const height = 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6));
    return { width, height };
  }
  if (format === "VP8X") {
    // Extended: 24-bit canvas width/height minus one at bytes 24/27.
    const width = 1 + ((head[24]! | (head[25]! << 8) | (head[26]! << 16)) & 0xffffff);
    const height = 1 + ((head[27]! | (head[28]! << 8) | (head[29]! << 16)) & 0xffffff);
    return { width, height };
  }
  return null;
}

function jpegDimensions(fd: number): ImageDimensions | null {
  // Walk JPEG segments looking for a Start-Of-Frame marker (0xFFC0..0xFFCF,
  // excluding 0xC4/0xC8/0xCC). Read incrementally in small chunks.
  const buf = Buffer.alloc(2);
  let offset = 2; // skip SOI (FFD8)
  try {
    for (let guard = 0; guard < 4096; guard++) {
      if (fs.readSync(fd, buf, 0, 2, offset) < 2) return null;
      if (buf[0] !== 0xff) return null;
      const marker = buf[1]!;
      offset += 2;
      // Standalone markers without a length payload.
      if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (fs.readSync(fd, buf, 0, 2, offset) < 2) return null;
      const segLen = buf.readUInt16BE(0);
      const isSof =
        marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isSof) {
        const sof = Buffer.alloc(5);
        if (fs.readSync(fd, sof, 0, 5, offset + 2) < 5) return null;
        return { height: sof.readUInt16BE(1), width: sof.readUInt16BE(3) };
      }
      offset += segLen;
    }
  } catch {
    return null;
  }
  return null;
}
