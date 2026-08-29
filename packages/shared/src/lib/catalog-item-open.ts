// ─── Catalog item opener (host-provided detail drawer) ───────────────────────
// Same module-singleton pattern as chat's registerDmOpener: a host app that
// has a rich detail surface for a catalog collection (efp-new's stock
// planning drawer for cifa_items) registers an opener; CatalogPickerField
// then renders item labels as clickable links. Hosts without one see plain
// text — the affordance only exists where clicking actually goes somewhere.

/** context = the hosting form's current values (parent draft) — lets the
 *  host seed its drawer's filters (warehouse, project type, …) from the
 *  record the click came from. Shape is host-interpreted. */
type CatalogItemOpener = (id: string, context?: Record<string, unknown>) => void

const openers = new Map<string, CatalogItemOpener>()

/** Register a detail opener for a catalog collection. Returns an unregister
 *  cleanup — call it on unmount so a dead host can't leave a stale opener. */
export function registerCatalogItemOpener(
  collection: string,
  fn: CatalogItemOpener
): () => void {
  openers.set(collection, fn)
  return () => {
    if (openers.get(collection) === fn) openers.delete(collection)
  }
}

export function canOpenCatalogItem(collection: string | null | undefined): boolean {
  return !!collection && openers.has(collection)
}

export function openCatalogItem(
  collection: string,
  id: string,
  context?: Record<string, unknown>
): void {
  openers.get(collection)?.(id, context)
}
