import type { DeletionPlan } from "./plan.js";

/**
 * Render a deletion plan as grouped plain text for the CLI. Sections: header,
 * cascades, detaches, assets, store counts, and blockers. No em dashes.
 */
export function renderDeletionPlanText(plan: DeletionPlan): string {
  const lines: string[] = [];
  const root = plan.roots[0];
  const rootLabel = root
    ? `${root.typeId}/${root.enSlug}${root.title ? ` (${root.title})` : ""}`
    : "(unknown)";
  lines.push(`Deletion plan for ${rootLabel}`);

  lines.push("");
  lines.push(`Cascades (${plan.cascades.length}):`);
  if (plan.cascades.length === 0) {
    lines.push("  none");
  } else {
    for (const c of plan.cascades) {
      lines.push(`  ${c.typeId}/${c.enSlug}${c.via ? `  via ${c.via}` : ""}`);
    }
  }

  lines.push("");
  lines.push(`Detaches (${plan.detaches.length}):`);
  if (plan.detaches.length === 0) {
    lines.push("  none");
  } else {
    for (const d of plan.detaches) {
      lines.push(`  ${d.typeId}/${d.enSlug} . ${d.fieldPath} drops "${d.removedSlug}"`);
    }
  }

  const toDelete = plan.assets.filter((a) => a.action === "delete");
  const toKeep = plan.assets.filter((a) => a.action === "keep");
  lines.push("");
  lines.push(`Assets (${toDelete.length} to delete, ${toKeep.length} kept):`);
  if (plan.assets.length === 0) {
    lines.push("  none");
  } else {
    for (const a of toDelete) lines.push(`  delete  ${a.path}`);
    for (const a of toKeep) {
      const why = a.reason === "shared" ? "shared" : "keep";
      lines.push(`  keep    ${a.path}  (${why})`);
    }
  }

  const totalTranslations = plan.store.reduce((sum, s) => sum + s.translations, 0);
  const totalSnapshots = plan.store.reduce((sum, s) => sum + s.snapshots, 0);
  lines.push("");
  lines.push(
    `Store rows: ${totalTranslations} translation(s), ${totalSnapshots} snapshot(s) across ${plan.store.length} document(s).`,
  );

  if (plan.blocked.length > 0) {
    lines.push("");
    lines.push(`Blockers (${plan.blocked.length}):`);
    for (const b of plan.blocked) {
      const why =
        b.reason === "required-single"
          ? "required single relation cannot be detached"
          : "restrict";
      lines.push(`  ${b.typeId}/${b.enSlug} . ${b.fieldPath}  (${why})`);
    }
  }

  return lines.join("\n");
}
