// Auto-ID pattern machinery: parse/validate/render for `options.auto_id` fields.
// Pure functions live here; DB-touching resolution is added in Task 2.

export interface AutoIdConfig {
  pattern: string
  padding?: number
}

export type AutoIdToken =
  | { raw: string; kind: 'date'; name: 'YY' | 'YYYY' | 'MM' }
  | { raw: string; kind: 'seq'; name: 'seq' | 'seq4' | 'seq6' }
  | { raw: string; kind: 'relation'; path: string[]; firstIsMany: boolean; mod: number | null }

export interface ParsedAutoIdPattern {
  tokens: AutoIdToken[]
  literals: string[]
  separator: string
}

const DATE_NAMES = new Set(['YY', 'YYYY', 'MM'])
const SEQ_NAMES = new Set(['seq', 'seq4', 'seq6'])
const TOKEN_RE = /\{([^{}]+)\}/g

export function parseAutoIdPattern(pattern: string): ParsedAutoIdPattern {
  const tokens: AutoIdToken[] = []
  const literals: string[] = []
  let last = 0
  for (const m of pattern.matchAll(TOKEN_RE)) {
    literals.push(pattern.slice(last, m.index))
    last = (m.index ?? 0) + m[0].length
    const inner = m[1].trim()
    if (DATE_NAMES.has(inner)) {
      tokens.push({ raw: m[0], kind: 'date', name: inner as 'YY' | 'YYYY' | 'MM' })
      continue
    }
    if (SEQ_NAMES.has(inner)) {
      tokens.push({ raw: m[0], kind: 'seq', name: inner as 'seq' | 'seq4' | 'seq6' })
      continue
    }
    // Relation token: `path` or `path % N`
    const [pathPart, modPart] = inner.split('%').map((s) => s.trim())
    let mod: number | null = null
    if (modPart !== undefined) {
      mod = Number(modPart)
      if (!Number.isInteger(mod) || mod <= 0) {
        throw new Error(`Invalid modulo in token ${m[0]}`)
      }
    }
    const segs = pathPart.split('.')
    if (segs.some((s) => !s.length)) throw new Error(`Malformed token ${m[0]}`)
    const firstIsMany = segs[0].endsWith('[0]')
    const path = segs.map((s, i) => (i === 0 && firstIsMany ? s.slice(0, -3) : s))
    if (path.some((s) => !/^[A-Za-z0-9_]+$/.test(s))) throw new Error(`Malformed token ${m[0]}`)
    tokens.push({ raw: m[0], kind: 'relation', path, firstIsMany, mod })
  }
  literals.push(pattern.slice(last))

  const seqIdxs = tokens.flatMap((t, i) => (t.kind === 'seq' ? [i] : []))
  if (seqIdxs.length !== 1) throw new Error('Pattern must contain exactly one {seq} token')
  const seqIdx = seqIdxs[0]
  if (seqIdx !== tokens.length - 1) throw new Error('{seq} must be the final token')
  const before = literals[seqIdx]
  const sep = before.slice(-1)
  if (!sep || /\d/.test(sep)) {
    throw new Error('A non-digit literal (e.g. "-") must immediately precede {seq}')
  }
  return { tokens, literals, separator: sep }
}

export function validateAutoIdPattern(pattern: string): string | null {
  try {
    parseAutoIdPattern(pattern)
    return null
  } catch (e) {
    return (e as Error).message
  }
}

export function renderAutoIdPattern(parsed: ParsedAutoIdPattern, tokenValues: string[]): string {
  let out = ''
  for (let i = 0; i < parsed.tokens.length; i++) out += parsed.literals[i] + (tokenValues[i] ?? '')
  return out + parsed.literals[parsed.tokens.length]
}

export function extractSuffix(parsed: ParsedAutoIdPattern, currentValue: string): string | null {
  const idx = currentValue.lastIndexOf(parsed.separator)
  if (idx < 0) return null
  return currentValue.slice(idx + 1)
}

export interface RelRow {
  many_collection: string
  many_field: string
  one_collection: string | null
  one_field: string | null
  junction_field: string | null
}

export interface AutoIdLookups {
  relationsFor(collection: string): Promise<RelRow[]>
  readRow(
    collection: string,
    id: unknown,
    fields: string[]
  ): Promise<Record<string, unknown> | null>
  firstJunctionValue(
    junction: string,
    fkField: string,
    parentId: unknown,
    valueField: string
  ): Promise<unknown>
}

async function resolveRelationToken(
  token: Extract<AutoIdToken, { kind: 'relation' }>,
  ctx: {
    collection: string
    values: Record<string, unknown>
    recordId?: unknown
    lookups: AutoIdLookups
  }
): Promise<string> {
  try {
    const seg0 = token.path[0]
    let value: unknown = ctx.values[seg0]
    if (Array.isArray(value)) value = value[0]
    let currentCollection = ctx.collection

    if (token.firstIsMany && (value === undefined || value === null)) {
      // No draft value — resolve first junction value from the DB (needs recordId)
      if (ctx.recordId === undefined || ctx.recordId === null) return ''
      const rels = await ctx.lookups.relationsFor(ctx.collection)
      const alias = rels.find(
        (r) =>
          r.one_collection === ctx.collection &&
          r.junction_field != null &&
          (r.one_field === seg0 || r.many_collection === seg0)
      )
      if (!alias) return ''
      value = await ctx.lookups.firstJunctionValue(
        alias.many_collection,
        alias.many_field,
        ctx.recordId,
        alias.junction_field as string
      )
    }
    if (value === undefined || value === null || value === '') return ''

    // Walk remaining segments as M2O hops. The value at each step is a FK id;
    // the segment names the FK field on the *current* collection for step > 0.
    for (let i = 1; i < token.path.length; i++) {
      const seg = token.path[i]
      const rels = await ctx.lookups.relationsFor(currentCollection)
      const hopField = i === 1 && !token.firstIsMany ? seg0 : token.path[i - 1]
      const rel = rels.find(
        (r) =>
          r.many_collection === currentCollection &&
          r.many_field === hopField &&
          r.junction_field == null
      )
      if (!rel?.one_collection) return ''
      const row = await ctx.lookups.readRow(rel.one_collection, value, [seg])
      if (!row) return ''
      value = row[seg]
      currentCollection = rel.one_collection
      if (value === undefined || value === null) return ''
    }

    if (token.mod != null) {
      const n = Number(value)
      if (!Number.isFinite(n)) return ''
      value = n % token.mod
    }
    return String(value)
  } catch {
    return ''
  }
}

export async function resolveAutoIdTokens(
  parsed: ParsedAutoIdPattern,
  ctx: {
    collection: string
    values: Record<string, unknown>
    recordId?: unknown
    lookups: AutoIdLookups
    seqValue: string
  }
): Promise<string> {
  const now = new Date()
  const tokenValues: string[] = []
  for (const t of parsed.tokens) {
    if (t.kind === 'date') {
      if (t.name === 'YY') tokenValues.push(String(now.getFullYear()).slice(-2))
      else if (t.name === 'YYYY') tokenValues.push(String(now.getFullYear()))
      else tokenValues.push(String(now.getMonth() + 1).padStart(2, '0'))
    } else if (t.kind === 'seq') {
      tokenValues.push(ctx.seqValue)
    } else {
      tokenValues.push(await resolveRelationToken(t, ctx))
    }
  }
  return renderAutoIdPattern(parsed, tokenValues)
}
