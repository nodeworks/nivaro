export interface ItemActionDef {
  id: string
  label: string
  icon?: string
  /** Only shown for these collections. Omit for all. */
  collections?: string[]
  /** Hint for the admin: 'default' | 'destructive' | 'outline' */
  variant?: 'default' | 'destructive' | 'outline'
  /** When present, clients show a confirmation dialog before executing:
   *  body explains what will happen ("a draft addendum will be created"),
   *  input adds an optional/required free-text field delivered to execute()
   *  as payload.message. */
  confirm?: {
    title?: string
    body?: string
    confirm_label?: string
    input?: { label: string; placeholder?: string; required?: boolean }
  }
  execute(ctx: ItemActionContext): Promise<{ message: string; data?: unknown }>
  /** The action CREATES AN ADDENDUM: core enforces the addendum-create gates
   *  (collection toggle, role allow-list, pipeline-state allow-list) — the
   *  button hides when the caller couldn't create one, and execute 403s with
   *  the gate's reason. Declared, not implemented, so extensions never
   *  replicate core policy. */
  requires_addendum_create?: boolean
  /** Optional per-record gate: when present, /item-actions/registered?item=
   *  evaluates it and the client hides inapplicable buttons. Errors count as
   *  applicable — a broken check must not hide a working action. */
  applicable?(ctx: { collection: string; itemId: string | number }): Promise<boolean>
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
