/** Who may run an action: everyone with update permission, admins, or listed role ids. */
export type BulkActionAccess = {
  mode: 'everyone' | 'admin' | 'roles'
  role_ids?: string[]
}

export interface BulkActionDef {
  id: string
  label: string
  /** Optional icon name from lucide (informational — admin renders it). */
  icon?: string
  /** If provided, only shown for these collections. Omit for all. */
  collections?: string[]
  /** 'danger' renders red (destructive). */
  variant?: 'default' | 'danger'
  /** Defaults to everyone (with update permission on the collection). */
  access?: BulkActionAccess
  /** The bar prompts for a reason and passes it as ctx.reason. */
  require_reason?: boolean
  /** Confirm text shown before running. */
  confirm?: string
  /** Called by the API route. Return a message shown in the admin toast. */
  execute(ctx: BulkActionContext): Promise<{ message: string }>
}

export interface BulkActionContext {
  collection: string
  ids: (string | number)[]
  payload?: Record<string, unknown>
  reason?: string | null
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
