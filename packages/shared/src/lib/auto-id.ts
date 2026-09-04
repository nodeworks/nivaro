// Client twin of api/src/services/auto-ids.ts resolveAutoIdPattern — an auto_id
// config may carry `variants: [{when, pattern}]`; the first variant whose
// condition matches the record's values wins, else the base pattern.

export interface AutoIdVariant {
  when: { field: string; op?: 'eq' | 'neq' | 'in' | 'null' | 'nnull'; value?: unknown }
  pattern: string
}

export interface AutoIdConfigLike {
  pattern?: string
  padding?: number
  variants?: AutoIdVariant[]
}

function variantMatches(v: AutoIdVariant, values: Record<string, unknown>): boolean {
  const w = v?.when
  if (!w?.field) return false
  const actual = values[w.field]
  const empty = actual === null || actual === undefined || actual === ''
  switch (w.op ?? 'eq') {
    case 'eq':
      return !empty && String(actual) === String(w.value ?? '')
    case 'neq':
      return empty || String(actual) !== String(w.value ?? '')
    case 'in': {
      const list = Array.isArray(w.value) ? w.value : String(w.value ?? '').split(',')
      return !empty && list.map((x) => String(x).trim()).includes(String(actual))
    }
    case 'null':
      return empty
    case 'nnull':
      return !empty
    default:
      return false
  }
}

export function resolveAutoIdPattern(
  config: AutoIdConfigLike | null | undefined,
  values: Record<string, unknown>
): string | undefined {
  if (!config) return undefined
  for (const v of config.variants ?? []) {
    if (typeof v?.pattern === 'string' && variantMatches(v, values)) return v.pattern
  }
  return config.pattern
}

/** Record columns the variant conditions read (preview deps). */
export function autoIdVariantFields(config: AutoIdConfigLike | null | undefined): string[] {
  return [...new Set((config?.variants ?? []).map((v) => v?.when?.field).filter(Boolean))]
}
