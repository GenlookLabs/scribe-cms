/**
 * One traversal primitive for asset-field paths, shared by the loader, the
 * validator, the deletion planner, and the studio field introspector.
 *
 * An asset-field path is a list of object keys with `"*"` marking "descend into
 * each item of this array". `walkAssetValues` walks a container to every
 * concrete leaf location the path resolves to and hands each one to `visit`.
 * The visitor reads the raw leaf value and may return a string to REPLACE it in
 * place (used by asset resolution); returning nothing leaves the leaf untouched.
 *
 * Container guarding is uniform: a segment only descends into a plain, non-array
 * object; anything else (string, number, null, array) stops that branch. This
 * matches the historical read walkers; the write walker's per-child guard is
 * equivalent (a non-object child was never recursed into or written).
 */

/** A concrete leaf location reached while walking an asset-field path. */
export interface AssetLeafVisit {
  /**
   * The raw value at this leaf, exactly as stored (any type). `undefined` when
   * the key is absent — callers materialize templated defaults off this.
   *
   * For a `multiple` field: element visits carry the individual element value,
   * while the single field-level visit (`index === null`) carries the whole
   * array (or the raw non-array/absent value).
   */
  raw: unknown;
  /** Dotted path to this leaf, with literal `*` segments for array descents. */
  fieldPath: string;
  /**
   * True only for a synthesized location emitted when an expected `*` array is
   * absent and `reportAbsentArrays` is set — for attribution, not a real value.
   */
  absentArray: boolean;
  /** Whether this leaf belongs to a `multiple` asset field. */
  multiple: boolean;
  /**
   * Element index within a `multiple` field's array, or `null` for the
   * field-level summary/absent visit (and for every single-value field).
   */
  index: number | null;
  /**
   * For a `multiple` field: the array length (0 for an empty array), or `null`
   * when the value is absent / not an array. Always `null` for single fields.
   */
  count: number | null;
}

export interface WalkAssetValuesOptions {
  /**
   * When a `"*"` segment finds no array, emit a single synthetic
   * `absentArray` visit at that location instead of silently skipping. Used by
   * the validator to attribute a "required but missing" error to the field.
   */
  reportAbsentArrays?: boolean;
  /**
   * The leaf is a `multiple` asset field: when its raw value is an array, emit
   * one visit per element (`index`/`count` set, string returns replace the
   * element in place) plus one field-level summary visit (`index: null`,
   * `count` = length) for count/required checks. When the value is absent or
   * not an array, emit a single field-level visit (`index: null, count: null`).
   */
  multiple?: boolean;
}

/**
 * Walk `container` along `path` (object keys, `"*"` = each array item) and call
 * `visit` at each concrete leaf. If `visit` returns a string, the leaf is
 * replaced in place with it; any other return (including `undefined`) leaves the
 * leaf unchanged. Traversal is depth-first in declaration/array order.
 */
export function walkAssetValues(
  container: unknown,
  path: string[],
  visit: (leaf: AssetLeafVisit) => string | undefined | void,
  options: WalkAssetValuesOptions = {},
): void {
  const reportAbsentArrays = options.reportAbsentArrays ?? false;
  const multiple = options.multiple ?? false;

  const recurse = (node: unknown, remaining: string[], soFar: string[]): void => {
    const [head, ...rest] = remaining;
    if (head === undefined) return;
    if (typeof node !== "object" || node === null || Array.isArray(node)) return;
    const record = node as Record<string, unknown>;

    if (rest.length === 0) {
      const raw = record[head];
      const fieldPath = [...soFar, head].join(".");
      if (multiple) {
        if (Array.isArray(raw)) {
          for (let i = 0; i < raw.length; i++) {
            const next = visit({
              raw: raw[i],
              fieldPath: [...soFar, head, String(i)].join("."),
              absentArray: false,
              multiple: true,
              index: i,
              count: raw.length,
            });
            if (typeof next === "string") raw[i] = next;
          }
          // Field-level summary: lets consumers check count / required-but-empty.
          visit({ raw, fieldPath, absentArray: false, multiple: true, index: null, count: raw.length });
        } else {
          // Absent or non-array: one field-level visit so required checks fire.
          visit({ raw, fieldPath, absentArray: false, multiple: true, index: null, count: null });
        }
        return;
      }
      const next = visit({ raw, fieldPath, absentArray: false, multiple: false, index: null, count: null });
      if (typeof next === "string") record[head] = next;
      return;
    }

    if (rest[0] === "*") {
      const arr = record[head];
      if (!Array.isArray(arr)) {
        if (reportAbsentArrays) {
          visit({
            raw: undefined,
            fieldPath: [...soFar, head, "*", ...rest.slice(1)].join("."),
            absentArray: true,
            multiple,
            index: null,
            count: null,
          });
        }
        return;
      }
      for (const item of arr) {
        recurse(item, rest.slice(1), [...soFar, head, "*"]);
      }
      return;
    }

    recurse(record[head], rest, [...soFar, head]);
  };

  recurse(container, path, []);
}
