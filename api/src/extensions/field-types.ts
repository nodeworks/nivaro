export interface FieldTypeDef {
  type: string
  label: string
  /** Hint for the admin field editor: which built-in interface to fall back to. */
  interface?: 'text' | 'textarea' | 'number' | 'boolean' | 'date' | 'json'
  /** JSON schema for validation. Applied server-side on create/update. */
  validationSchema?: Record<string, unknown>
  /** Transform the raw value before storing. */
  serialize?(value: unknown): unknown
  /** Transform the stored value before returning to clients. */
  deserialize?(value: unknown): unknown
}

class FieldTypeRegistry {
  private types = new Map<string, FieldTypeDef>()

  register(def: FieldTypeDef): void {
    if (this.types.has(def.type)) {
      throw new Error(`Field type "${def.type}" already registered`)
    }
    this.types.set(def.type, def)
  }

  unregister(type: string): void {
    this.types.delete(type)
  }

  list(): FieldTypeDef[] {
    return [...this.types.values()]
  }

  get(type: string): FieldTypeDef | undefined {
    return this.types.get(type)
  }

  serialize(type: string, value: unknown): unknown {
    return this.types.get(type)?.serialize?.(value) ?? value
  }

  deserialize(type: string, value: unknown): unknown {
    return this.types.get(type)?.deserialize?.(value) ?? value
  }
}

export const fieldTypeRegistry = new FieldTypeRegistry()
