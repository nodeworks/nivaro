import type { BulkActionDef } from '@nivaro/extension-kit'

export type { BulkActionAccess, BulkActionContext, BulkActionDef } from '@nivaro/extension-kit'

class BulkActionRegistry {
  private actions = new Map<string, BulkActionDef>()

  register(def: BulkActionDef): void {
    if (this.actions.has(def.id)) {
      throw new Error(`Bulk action "${def.id}" already registered`)
    }
    this.actions.set(def.id, def)
  }

  unregister(id: string): void {
    this.actions.delete(id)
  }

  list(collection?: string): BulkActionDef[] {
    const all = [...this.actions.values()]
    if (!collection) return all
    return all.filter((a) => !a.collections || a.collections.includes(collection))
  }

  get(id: string): BulkActionDef | undefined {
    return this.actions.get(id)
  }
}

export const bulkActionRegistry = new BulkActionRegistry()
