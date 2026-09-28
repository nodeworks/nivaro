import type { ItemActionDef } from '@nivaro/extension-kit'

export type { ItemActionContext, ItemActionDef } from '@nivaro/extension-kit'

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
