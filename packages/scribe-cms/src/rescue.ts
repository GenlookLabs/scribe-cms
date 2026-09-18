/**
 * Edge-safe entry — zero dependencies, no fs. Import from middleware against
 * the build-generated alternates/redirects JSON maps.
 */
export { createCrossLocaleRescue } from "./i18n/cross-locale-rescue.js";
export type {
  AlternateCluster,
  AlternatesMap,
  CrossLocaleRescue,
  CrossLocaleRescueConfig,
} from "./i18n/cross-locale-rescue.js";
