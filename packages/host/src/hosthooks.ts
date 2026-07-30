/**
 * Optional hosthooks surface for Fly wake env merge.
 * In a NanoClaw fork this module is provided by core `src/hosthooks.ts`
 * (copied/overlaid). Package unit tests use this stub.
 */
export function runContainerEnvContributors(
  _occupiedKeys: Iterable<string> = [],
): Record<string, string> {
  return {};
}
