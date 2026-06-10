export interface ItemActionDef {
  id: string
  label: string
  icon?: string
  /** Only shown for these collections. Omit for all. */
  collections?: string[]
  /** Hint for the admin: 'default' | 'destructive' | 'outline' */
  variant?: 'default' | 'destructive' | 'outline'
  execute(ctx: ItemActionContext): Promise<{ message: string; data?: unknown }>
}

export interface ItemActionContext {
  collection: string
  itemId: string | number
  payload?: Record<string, unknown>
  userId?: string
}

class ItemActionRegistry {
  private actions = new Map<string, ItemActionDef>()

  register(def: ItemActionDef): void {
    if (this.actions.has(def.id)) {
      throw new Error(`Item action "${def.id}" already registered`)
    }
    this.actions.set(def.id, def)
  }

  unregister(id: string): void {
    this.actions.delete(id)
  }

  list(collection?: string): ItemActionDef[] {
    const all = [...this.actions.values()]
    if (!collection) return all
    return all.filter((a) => !a.collections || a.collections.includes(collection))
  }

  get(id: string): ItemActionDef | undefined {
    return this.actions.get(id)
  }
}

export const itemActionRegistry = new ItemActionRegistry()
