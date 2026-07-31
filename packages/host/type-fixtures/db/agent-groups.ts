/** CI-only stub — real module exists once installed into a NanoClaw host. */
export function getAgentGroup(
  id: string,
): { id: string; name: string; folder: string } | undefined {
  if (id === "missing-group") return undefined;
  return { id, name: id, folder: id };
}
