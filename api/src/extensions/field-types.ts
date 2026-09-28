import type { FieldTypeDef } from '@nivaro/extension-kit'

export type { FieldTypeDef } from '@nivaro/extension-kit'

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
