import type { CollectionViewDef } from '@nivaro/extension-kit'

export type { CollectionViewDef } from '@nivaro/extension-kit'

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
