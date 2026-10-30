/**
 * Region placement for Command Center reads (program slice 1 implements these; until then they
 * answer "this cannot be placed", and every caller treats that as "the region focus does not
 * apply to this read" — it answers for everywhere and says `region_applies: false`).
 */

/**
 * Ids of `collection` records that sit in region `regionId` — through the configured or
 * detected region source (the geo collection itself, a direct link to the region collection, or
 * a link to a geo record in the region). null = this collection cannot be placed in regions.
 * Callers still read the records AS THE CALLER; this only narrows.
 */
export async function recordIdsInRegion(
  _collection: string,
  _regionId: string
): Promise<Set<string> | null> {
  return null
}

/** User ids placed in region `regionId` (the region source's user-scope dimension); null = people are not placed. */
export async function userIdsInRegion(_regionId: string): Promise<Set<string> | null> {
  return null
}
