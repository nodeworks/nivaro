import type { User } from '../types.js'
import { assertFilterReadable, FieldAccessError, readableFieldSet } from './ai-aggregate-guard.js'
import { conditionsToChatFilter, linkLabels, matchViewName, visibleSavedViews } from './ai-panel.js'

/**
 * Ask AI panel tools: ask_choice (#1937), saved_view (#1942) and compare
 * (#1890). All three run as the asker and lean on the existing guarded tools
 * (aggregate, query_items) or on readItems / readOne directly, so a row, a
 * label or a figure the asker cannot read never comes back. None is in
 * REPLAYABLE_TOOLS (ai-conversations.ts): an answer that used one stays
 * private to its author, like proposals and the asker's own lists.
 */

export interface ChoiceOption {
  label: string
  /** The raw value or record id. */
  value: string
  /** The text sent as the next question when this option is picked. */
  send: string
}

export interface ChoiceResult {
  question: string
  options: ChoiceOption[]
  collection?: string
  field?: string
}

const MAX_OPTIONS = 12
const oneLine = (s: unknown, n: number) =>
  String(s ?? '')
    .replace(/[`\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, n)

/** Aggregate/query tool results may arrive wrapped by the access note. */
function unwrap(result: unknown): { value: unknown; note: string | null } {
  if (result && typeof result === 'object' && !Array.isArray(result)) {
    const r = result as Record<string, unknown>
    if ('access_note' in r) {
      const note = typeof r.access_note === 'string' ? r.access_note : null
      if ('rows' in r) return { value: r.rows, note }
      const { access_note: _drop, ...rest } = r
      return { value: rest, note }
    }
  }
  return { value: result, note: null }
}

export async function executePanelTool(
  user: User,
  name: string,
  input: Record<string, unknown>
): Promise<{ result: unknown; summary: string }> {
  if (name === 'ask_choice') return askChoice(user, input)
  if (name === 'saved_view') return savedView(user, input)
  if (name === 'compare') return compare(user, input)
  throw new Error(`Unknown tool: ${name}`)
}

// ── ask_choice ───────────────────────────────────────────────────────────────

async function askChoice(
  user: User,
  input: Record<string, unknown>
): Promise<{ result: ChoiceResult; summary: string }> {
  const question = oneLine(input.question, 160)
  if (!question) throw new Error('ask_choice needs a question')
  const { executeChatTool, chatAssertCollection, chatLabelColumn, chatFieldSet } = await import(
    './ai-chat.js'
  )

  const src = input.source
  if (src && typeof src === 'object' && !Array.isArray(src)) {
    const s = src as Record<string, unknown>
    const collection = chatAssertCollection(s.collection)
    const limit = Math.min(MAX_OPTIONS, Math.max(2, Number(s.limit) || MAX_OPTIONS))
    const field = typeof s.field === 'string' ? s.field.trim() : ''
    if (field) {
      // Distinct values via the guarded aggregate: field access, row filters and scopes bind.
      const agg = await executeChatTool(user, 'aggregate', {
        collection,
        op: 'count',
        group_by: field,
        filter: s.filter
      })
      const rows = unwrap(agg.result).value
      const groups = (Array.isArray(rows) ? rows : []) as Array<Record<string, unknown>>
      const live = groups.filter((g) => g[field] != null && g[field] !== '').slice(0, limit)
      const labels = await linkLabels(
        user,
        collection,
        field,
        live.map((g) => g[field])
      )
      const options = live.map((g) => {
        const value = String(g[field])
        const label =
          labels.get(value) ?? (labels.size || isLinkId(value) ? `#${value}` : oneLine(value, 80))
        return {
          label,
          value,
          send: labels.has(value) || isLinkId(value) ? `${label} (${field} = ${value})` : label
        }
      })
      if (options.length < 2)
        throw new Error('Fewer than two options to choose from — answer directly.')
      return {
        result: { question, options, collection, field },
        summary: `${options.length} option(s) from ${collection}.${field}`
      }
    }
    // Records: query_items as the asker.
    const valid = await chatFieldSet(collection)
    const col = await chatLabelColumn(collection)
    const labelCol = valid.has(col) ? col : null
    const res = await executeChatTool(user, 'query_items', {
      collection,
      search: s.search,
      filter: s.filter,
      fields: labelCol ? ['id', labelCol] : ['id'],
      limit
    })
    const rows = (unwrap(res.result).value as { rows?: Array<Record<string, unknown>> })?.rows ?? []
    const options = rows.slice(0, limit).map((r) => {
      const raw = labelCol ? r[labelCol] : null
      const text =
        typeof raw === 'string'
          ? raw
          : raw && typeof raw === 'object' && 'label' in raw
            ? String((raw as { label: unknown }).label)
            : ''
      const label = text.trim() ? oneLine(text, 80) : `#${String(r.id)}`
      return {
        label,
        value: String(r.id),
        send: `${label} (${collection} #${String(r.id)})`
      }
    })
    if (options.length < 2)
      throw new Error('Fewer than two options to choose from — answer directly.')
    return {
      result: { question, options, collection },
      summary: `${options.length} option(s) from ${collection}`
    }
  }

  const raw = Array.isArray(input.options) ? input.options : []
  const seen = new Set<string>()
  const options: ChoiceOption[] = []
  for (const o of raw) {
    const label = oneLine(o, 60)
    if (!label || seen.has(label.toLowerCase())) continue
    seen.add(label.toLowerCase())
    options.push({ label, value: label, send: label })
    if (options.length >= 8) break
  }
  if (options.length < 2) throw new Error('ask_choice needs at least two options or a source')
  return { result: { question, options }, summary: `${options.length} option(s)` }
}

const isLinkId = (v: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(v)

// ── saved_view ───────────────────────────────────────────────────────────────

const VIEW_OPS = new Set([
  '_eq',
  '_neq',
  '_gt',
  '_gte',
  '_lt',
  '_lte',
  '_contains',
  '_ncontains',
  '_starts_with',
  '_ends_with',
  '_in',
  '_nin',
  '_null',
  '_nnull'
]) // prettier-ignore

async function savedView(
  user: User,
  input: Record<string, unknown>
): Promise<{ result: unknown; summary: string }> {
  const {
    chatAssertCollection,
    chatReadableCollections,
    chatLabelForeignKeys,
    chatRelationsFor,
    chatFieldSet
  } = await import('./ai-chat.js')
  const wantCollection = typeof input.collection === 'string' ? input.collection : undefined
  const name = typeof input.name === 'string' ? input.name.trim() : ''
  const readable = new Set((await chatReadableCollections(user)).map((c) => c.collection))
  const all = (await visibleSavedViews(user, { collection: wantCollection })).filter((v) =>
    readable.has(v.collection)
  )

  if (!name) {
    const views = all.slice(0, 50).map((v) => ({
      name: oneLine(v.name, 80),
      collection: v.collection,
      shared: !!v.is_shared
    }))
    return { result: { views }, summary: `${views.length} saved view(s)` }
  }

  const { match, candidates } = matchViewName(all, name)
  if (!match) {
    return {
      result: {
        found: false,
        candidates: candidates.slice(0, 8).map((v) => ({
          name: oneLine(v.name, 80),
          collection: v.collection
        })),
        note: candidates.length
          ? 'More than one view fits — ask which one (ask_choice) or pick the closest.'
          : 'No saved view of that name is visible to the asker.'
      },
      summary: candidates.length ? `${candidates.length} views fit "${name}"` : `no view "${name}"`
    }
  }

  const collection = chatAssertCollection(match.collection)
  let stored: unknown = []
  try {
    stored = match.filters ? JSON.parse(match.filters) : []
  } catch {
    stored = []
  }
  const { compileViewConditions } = await import('./view-subscriptions.js')
  const conds = compileViewConditions(
    Array.isArray(stored) ? (stored as Parameters<typeof compileViewConditions>[0]) : []
  )
  const filter = conditionsToChatFilter(conds, VIEW_OPS)

  // The view's own filter goes through the same guard as an aggregate filter:
  // a field the asker cannot read is refused, never silently dropped.
  const allFields = await chatFieldSet(collection)
  const valid = await readableFieldSet(user, collection, allFields)
  const hidden = new Set([...allFields].filter((f) => !valid.has(f)))
  try {
    await assertFilterReadable(
      user,
      collection,
      conds.map((c) => c.path),
      hidden,
      chatRelationsFor
    )
  } catch (err) {
    if (err instanceof FieldAccessError) {
      throw new Error(
        `The view "${oneLine(match.name, 80)}" filters on something you cannot read: ${err.message}`
      )
    }
    throw err
  }

  const limit = Math.min(25, Math.max(1, Number(input.limit) || 10))
  let cols: unknown = []
  try {
    cols = match.columns ? JSON.parse(match.columns) : []
  } catch {
    cols = []
  }
  const wanted = (Array.isArray(cols) ? cols : [])
    .map((c) => (typeof c === 'string' ? c : (c as { key?: string })?.key))
    .filter((c): c is string => typeof c === 'string' && valid.has(c))
    .slice(0, 8)
  let sort: string[] | undefined
  try {
    const s = match.sort ? JSON.parse(match.sort) : null
    const one =
      typeof s === 'string'
        ? s
        : s && typeof s === 'object'
          ? (s as { field?: string; dir?: string })
          : null
    if (typeof one === 'string' && valid.has(one.replace(/^-/, ''))) sort = [one]
    else if (one && typeof one === 'object' && one.field && valid.has(one.field))
      sort = [`${one.dir === 'desc' ? '-' : ''}${one.field}`]
  } catch {
    sort = undefined
  }

  const { readItems } = await import('./items.js')
  const fakeReq = {
    query: conds.length ? { conditions: JSON.stringify(conds) } : {}
  } as never
  const res = (await readItems(
    user,
    collection,
    {
      fields: wanted.length ? ['id', ...wanted.filter((c) => c !== 'id')] : undefined,
      sort,
      limit
    },
    fakeReq
  )) as { data?: unknown[]; total?: number }
  const rel = await chatRelationsFor(collection)
  const rows = await chatLabelForeignKeys(res.data ?? [], rel)
  const total = typeof res.total === 'number' ? res.total : rows.length
  return {
    result: {
      found: true,
      view: { name: oneLine(match.name, 80), collection, shared: !!match.is_shared },
      filter,
      total,
      rows
    },
    summary: `view "${oneLine(match.name, 60)}": ${rows.length} of ${total} row(s) from ${collection}`
  }
}

// ── compare ──────────────────────────────────────────────────────────────────

export interface CompareRow {
  group: string
  a: number | null
  b: number | null
  delta: number | null
  pct: number | null
}

/** Merge two grouped (or single) aggregate results into value + delta rows (b relative to a). */
export function compareGroups(
  a: Array<{ group: string; value: number | null }>,
  b: Array<{ group: string; value: number | null }>
): CompareRow[] {
  const am = new Map(a.map((r) => [r.group, r.value]))
  const bm = new Map(b.map((r) => [r.group, r.value]))
  const keys = [...new Set([...am.keys(), ...bm.keys()])]
  const rows = keys.map((group) => {
    const av = am.get(group) ?? null
    const bv = bm.get(group) ?? null
    const delta = av != null && bv != null ? bv - av : bv != null ? bv : av != null ? -av : null
    const pct = av != null && bv != null && av !== 0 ? ((bv - av) / Math.abs(av)) * 100 : null
    return { group, a: av, b: bv, delta, pct }
  })
  return rows.sort((x, y) => Math.abs(y.delta ?? 0) - Math.abs(x.delta ?? 0))
}

function toGroups(
  value: unknown,
  groupBy: string | null
): Array<{ group: string; value: number | null }> {
  const num = (v: unknown) => (v == null || Number.isNaN(Number(v)) ? null : Number(v))
  if (groupBy) {
    const rows = (Array.isArray(value) ? value : []) as Array<Record<string, unknown>>
    return rows.map((r) => ({
      group: r[groupBy] == null ? '(none)' : String(r[groupBy]),
      value: num(r.value)
    }))
  }
  const row = (Array.isArray(value) ? value[0] : value) as Record<string, unknown> | undefined
  return [{ group: 'Total', value: num(row?.value) }]
}

async function compare(
  user: User,
  input: Record<string, unknown>
): Promise<{ result: unknown; summary: string }> {
  const { executeChatTool, chatAssertCollection } = await import('./ai-chat.js')
  if (input.mode === 'records') {
    const refs = (Array.isArray(input.records) ? input.records : []).slice(0, 4) as Array<{
      collection?: unknown
      id?: unknown
    }>
    if (refs.length < 2) throw new Error('records mode needs two to four records')
    const { readOne } = await import('./items.js')
    const loaded: Array<{ ref: string; row: Record<string, unknown> }> = []
    for (const r of refs) {
      const collection = chatAssertCollection(r.collection)
      const id = String(r.id ?? '')
      if (!/^[\w-]{1,64}$/.test(id)) throw new Error('Invalid record id')
      const row = (await readOne(user, collection, id)) as Record<string, unknown> | null
      // null = missing or not the asker's to see: the same answer either way.
      if (!row) throw new Error(`${collection} #${id} was not found (or you cannot open it).`)
      loaded.push({ ref: `${collection} #${id}`, row })
    }
    const only = Array.isArray(input.fields) ? new Set(input.fields.map(String)) : null
    const keys = [...new Set(loaded.flatMap((l) => Object.keys(l.row)))].filter(
      (k) => !k.startsWith('_') && !k.startsWith('$') && (!only || only.has(k))
    )
    const cell = (v: unknown) =>
      v == null
        ? null
        : typeof v === 'object'
          ? oneLine(JSON.stringify(v), 120)
          : typeof v === 'string'
            ? oneLine(v, 120)
            : v
    const rows = keys.map((field) => {
      const values = loaded.map((l) => cell(l.row[field]))
      const differs = new Set(values.map((v) => JSON.stringify(v))).size > 1
      return { field, values, differs }
    })
    rows.sort((x, y) => Number(y.differs) - Number(x.differs))
    const shown = rows.slice(0, 40)
    return {
      result: { records: loaded.map((l) => l.ref), rows: shown, cut: rows.length > shown.length },
      summary: `${loaded.length} records, ${rows.filter((r) => r.differs).length} differing field(s)`
    }
  }

  if (input.mode !== 'sets') throw new Error('mode must be "sets" or "records"')
  const collection = chatAssertCollection(input.collection)
  const base = {
    collection,
    op: input.op,
    ...(input.field ? { field: input.field } : {}),
    ...(input.group_by ? { group_by: input.group_by } : {})
  }
  const sides = [input.a, input.b].map((s) =>
    s && typeof s === 'object' ? (s as { label?: unknown; filter?: unknown }) : {}
  )
  const groupBy = input.group_by ? String(input.group_by) : null
  const notes: string[] = []
  const grouped: Array<Array<{ group: string; value: number | null }>> = []
  for (const side of sides) {
    const out = await executeChatTool(user, 'aggregate', { ...base, filter: side.filter })
    const { value, note } = unwrap(out.result)
    if (note && !notes.includes(note)) notes.push(note)
    grouped.push(toGroups(value, groupBy))
  }
  // Name the groups of a link column once, as the asker.
  let rows = compareGroups(grouped[0], grouped[1])
  if (groupBy) {
    const labels = await linkLabels(
      user,
      collection,
      groupBy,
      rows.map((r) => r.group)
    )
    if (labels.size) rows = rows.map((r) => ({ ...r, group: labels.get(r.group) ?? `#${r.group}` }))
  }
  const labelA = oneLine((sides[0] as { label?: unknown }).label, 40) || 'A'
  const labelB = oneLine((sides[1] as { label?: unknown }).label, 40) || 'B'
  const capped = rows.slice(0, 30)
  return {
    result: {
      collection,
      op: input.op,
      field: input.field ?? null,
      group_by: groupBy,
      a_label: labelA,
      b_label: labelB,
      rows: capped,
      truncated: rows.length > capped.length,
      delta_is: `${labelB} minus ${labelA}`,
      ...(notes.length ? { access_note: notes.join('; ') } : {})
    },
    summary: `${labelA} vs ${labelB}: ${capped.length} row(s)`
  }
}
