import type { InlineToken } from "../src/inline/tokens.js";
import { enFileExists } from "../src/core/alias-helpers.js";
import type { ScribeConfig, ScribeProject } from "../src/core/types.js";
import { encodePathSegment } from "./shared.js";

export interface PreviewToken {
  kind: "static" | "relation" | "asset" | "var";
  raw: string;
  studioUrl?: string;
  label?: string;
  dangling?: boolean;
  value?: string;
}

function isStringRecord(v: unknown): v is Record<string, string> {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  return Object.values(v as Record<string, unknown>).every((x) => typeof x === "string");
}

export function buildPreviewTokens(
  tokens: InlineToken[],
  opts: { enFrontmatter: Record<string, unknown>; docExists: (typeId: string, enSlug: string) => boolean },
): PreviewToken[] {
  return tokens.map((t): PreviewToken => {
    switch (t.kind) {
      case "static":
        return { kind: "static", raw: t.raw, value: t.text };
      case "var": {
        const vars = opts.enFrontmatter.vars;
        const value = isStringRecord(vars) && typeof vars[t.key] === "string" ? vars[t.key]! : "";
        return { kind: "var", raw: t.raw, value };
      }
      case "asset":
        return { kind: "asset", raw: t.raw, value: t.webPath };
      case "relation": {
        const studioUrl = `/type/${encodePathSegment(t.targetTypeId)}/doc/${encodePathSegment(t.enSlug)}`;
        return {
          kind: "relation",
          raw: t.raw,
          studioUrl,
          label: t.enSlug,
          dangling: !opts.docExists(t.targetTypeId, t.enSlug),
        };
      }
    }
  });
}

export function makeDocExists(
  project: ScribeProject,
  config: ScribeConfig,
): (typeId: string, enSlug: string) => boolean {
  return (typeId, enSlug) => {
    const t = project.getType(typeId);
    return t ? enFileExists(config, t.config, enSlug) : false;
  };
}
