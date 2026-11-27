import type { FieldSpec } from './types.js'

/**
 * Words adapters put in a plan's `reason` (Task 3b item H): a resource type by its own label
 * ("VPC", "Vercel project") and the fields that change by their labels ("DNS resolution"), never
 * by the type key or a field key. Pure; adapters pass their own specs.
 */

/** "Create VPC hub-shared-2" style: the type label, then the name when there is one. */
export function typedName(label: string, name: string | null | undefined): string {
  const n = typeof name === 'string' ? name.trim() : ''
  return n ? `${label} ${n}` : label
}

/** The labels of the fields in `keys` (dotted paths use their first part), in order, once each. */
export function fieldWords(
  fields: FieldSpec[] | undefined,
  keys: Array<string | { field: string }>
): string {
  const out: string[] = []
  for (const k of keys) {
    const key = typeof k === 'string' ? k : k.field
    const head = key.split('.')[0] ?? key
    const word = fields?.find((f) => f.key === head)?.label ?? head.replace(/_/g, ' ')
    if (!out.includes(word)) out.push(word)
  }
  return out.join(', ')
}
