export interface BulkActionDef {
  id: string
  label: string
  /** Optional icon name from lucide (informational — admin renders it). */
  icon?: string
  /** If provided, only shown for these collections. Omit for all. */
  collections?: string[]
  /** Called by the API route. Return a message shown in the admin toast. */
  execute(ctx: BulkActionContext): Promise<{ message: string }>
}

export interface BulkActionContext {
  collection: string
  ids: (string | number)[]
  payload?: Record<string, unknown>
  userId?: string
}

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
