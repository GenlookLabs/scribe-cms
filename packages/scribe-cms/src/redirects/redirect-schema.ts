import { z } from "zod";
import { slugPatternSchema } from "../core/builtin-fields.js";

const redirectFromSchema = z.union([
  slugPatternSchema,
  z.array(slugPatternSchema).min(1).max(20),
]);

export const typeRedirectEntrySchema = z
  .object({
    from: redirectFromSchema,
    toSlug: slugPatternSchema.optional(),
    toType: z.string().min(1).optional(),
    toUrl: z.string().min(1).optional(),
    permanent: z.boolean().optional(),
  })
  .superRefine((entry, ctx) => {
    const hasToSlug = entry.toSlug !== undefined;
    const hasToUrl = entry.toUrl !== undefined;
    const hasToType = entry.toType !== undefined;
    const targetCount = Number(hasToSlug) + Number(hasToUrl);

    if (targetCount !== 1) {
      ctx.addIssue({
        code: "custom",
        message: "Each redirect must specify exactly one of toSlug/toType+toSlug or toUrl",
        path: ["toSlug"],
      });
      return;
    }

    if (hasToUrl && hasToType) {
      ctx.addIssue({
        code: "custom",
        message: "toUrl cannot be combined with toType",
        path: ["toUrl"],
      });
    }

    if (hasToType && !hasToSlug) {
      ctx.addIssue({
        code: "custom",
        message: "Cross-type redirects require both toType and toSlug",
        path: ["toSlug"],
      });
    }
  });

export const typeRedirectsFileSchema = z.object({
  redirects: z.array(typeRedirectEntrySchema).max(500),
});

export type TypeRedirectEntry = z.infer<typeof typeRedirectEntrySchema>;
export type TypeRedirectsFile = z.infer<typeof typeRedirectsFileSchema>;

export type RedirectTargetKind = "same-type" | "cross-type" | "anywhere";

export interface ParsedRedirectEntry {
  fromSlugs: string[];
  kind: RedirectTargetKind;
  toSlug?: string;
  toType?: string;
  toUrl?: string;
  permanent: boolean;
}

export function normalizeRedirectFrom(from: string | string[]): string[] {
  return Array.isArray(from) ? from : [from];
}

export function parseRedirectEntry(entry: TypeRedirectEntry): ParsedRedirectEntry {
  const fromSlugs = normalizeRedirectFrom(entry.from);
  if (entry.toUrl !== undefined) {
    return {
      fromSlugs,
      kind: "anywhere",
      toUrl: entry.toUrl,
      permanent: entry.permanent ?? true,
    };
  }
  if (entry.toType !== undefined) {
    return {
      fromSlugs,
      kind: "cross-type",
      toType: entry.toType,
      toSlug: entry.toSlug,
      permanent: entry.permanent ?? true,
    };
  }
  return {
    fromSlugs,
    kind: "same-type",
    toSlug: entry.toSlug,
    permanent: entry.permanent ?? true,
  };
}
