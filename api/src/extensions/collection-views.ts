export interface CollectionViewDef {
  id: string
  label: string
  icon?: string
  /** URL of the extension's UI bundle that renders this view.
   *  Receives collection, filters, and item data via postMessage. */
  bundleUrl?: string
  /** Optional field mappings to configure the view (e.g. titleField, dateField). */
  fieldMappings?: Array<{ key: string; label: string; required?: boolean }>
  /** Which collections this view supports. Omit for all. */
  collections?: string[]
}

class CollectionViewRegistry {
  private views = new Map<string, CollectionViewDef>()

  register(def: CollectionViewDef): void {
    if (this.views.has(def.id)) throw new Error(`Collection view "${def.id}" already registered`)
    this.views.set(def.id, def)
  }

  unregister(id: string): void {
    this.views.delete(id)
  }

  list(collection?: string): CollectionViewDef[] {
    const all = [...this.views.values()]
    if (!collection) return all
    return all.filter((v) => !v.collections || v.collections.includes(collection))
  }

  get(id: string): CollectionViewDef | undefined {
    return this.views.get(id)
  }
}

export const collectionViewRegistry = new CollectionViewRegistry()
