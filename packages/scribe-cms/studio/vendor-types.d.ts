/**
 * Minimal ambient types for `js-yaml` v3 (a transitive dependency of
 * `gray-matter`, promoted to a direct dependency for the studio entry forms).
 * The published package ships no type declarations and `@types/js-yaml` targets
 * the v4 API; we only use `load`/`dump`, so a hand-written surface keeps the
 * build self-contained.
 */
declare module "js-yaml" {
  export function safeLoad(input: string): unknown;
  export function safeDump(input: unknown): string;
  const yaml: {
    safeLoad(input: string): unknown;
    safeDump(input: unknown): string;
  };
  export default yaml;
}
