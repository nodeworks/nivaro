import type { ConditionRule, Field, ListSpec, MapSpec, ValueSpec } from '../api'

// ─── Pure operations on a field-map spec ─────────────────────────────────────
// Every edit the field map makes goes through one of these. They never mutate:
// they copy only the path from the root to the changed row (structural
// sharing), so a memoized row whose field object did not change does not
// re-render. Refusals (locked keys, a move past the end of a group) return the
// SAME spec object with a reason, so callers can tell "nothing changed".
//
// Ids are random and never derived from a position (a reorder or an undo must
// not re-point a problem or a preview value at another row).

export type OpResult = { ok: true; spec: MapSpec } | { ok: false; spec: MapSpec; reason: string }

export type FieldType = Field['type']

export const SCALAR_TYPES: FieldType[] = ['text', 'number', 'boolean', 'date', 'json']

export function isGroupType(t: FieldType): boolean {
  return t === 'object' || t === 'list'
}

/** A short random row id (nanoid-sized, from the platform's CSPRNG). */
export function newFieldId(): string {
  const c = globalThis.crypto
  if (c?.randomUUID) return c.randomUUID().replace(/-/g, '').slice(0, 16)
  // Very old browsers only — still random, never positional.
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`
}

export interface Located {
  field: Field
  /** The group row holding this field; null at the top level. */
  parent: Field | null
  siblings: Field[]
  index: number
  depth: number
  /** Output path of keys from the root (`lines.sku`). */
  path: string
}

export function findField(spec: MapSpec, id: string): Located | null {
  const walk = (
    fields: Field[],
    parent: Field | null,
    depth: number,
    prefix: string
  ): Located | null => {
    for (let i = 0; i < fields.length; i++) {
      const field = fields[i]
      const path = prefix ? `${prefix}.${field.key}` : field.key
      if (field.id === id) return { field, parent, siblings: fields, index: i, depth, path }
      if (field.children?.length) {
        const hit = walk(field.children, field, depth + 1, path)
        if (hit) return hit
      }
    }
    return null
  }
  return walk(spec.fields ?? [], null, 0, '')
}

/** Replace the sibling array that holds `id` (or the root list) — copies the path to it. */
function mapSiblings(
  spec: MapSpec,
  id: string,
  fn: (siblings: Field[], index: number) => Field[] | null
): MapSpec | null {
  const walk = (fields: Field[]): Field[] | null => {
    const i = fields.findIndex((x) => x.id === id)
    if (i >= 0) return fn(fields, i)
    for (let j = 0; j < fields.length; j++) {
      const kids = fields[j].children
      if (!kids?.length) continue
      const next = walk(kids)
      if (next) {
        const copy = fields.slice()
        copy[j] = { ...fields[j], children: next }
        return copy
      }
    }
    return null
  }
  const next = walk(spec.fields ?? [])
  return next ? { ...spec, fields: next } : null
}

/** Replace one field (found by id) with `fn(field)`. Unknown id → same spec. */
function mapField(spec: MapSpec, id: string, fn: (f: Field) => Field): MapSpec {
  const next = mapSiblings(spec, id, (siblings, i) => {
    const updated = fn(siblings[i])
    if (updated === siblings[i]) return null
    const copy = siblings.slice()
    copy[i] = updated
    return copy
  })
  return next ?? spec
}

// ─── Locks ───────────────────────────────────────────────────────────────────

/** `lines[].sku`, `lines[0].sku` and `lines.sku` all mean the same output path. */
function normPath(p: string): string {
  return p.replace(/\[\d*\]/g, '').trim()
}

export interface LockInfo {
  /** This row's own key is locked. */
  self: boolean
  /** A row inside this group is locked (the group can't be removed, renamed or retyped). */
  inside: boolean
}

/**
 * Latch each locked output path onto ONE row, by identity: the row flagged
 * `locked: true`, else (per path) the row already latched in `prev` if it
 * still sits on that path, else the first row on it in display order.
 *
 * Locks follow the row, never the name: a row that is only now typed into a
 * locked name is not locked, and a duplicate of a locked key stays free to be
 * renamed or removed.
 */
export function latchLocks(
  spec: MapSpec,
  lockedKeys: string[],
  prev?: ReadonlySet<string>
): Set<string> {
  const paths = new Set(lockedKeys.map(normPath).filter(Boolean))
  const out = new Set<string>()
  const onPath = new Map<string, string[]>()
  const walk = (fields: Field[], prefix: string) => {
    for (const f of fields) {
      const path = prefix ? `${prefix}.${f.key}` : f.key
      if (f.locked) out.add(f.id)
      if (paths.has(path)) {
        const list = onPath.get(path)
        if (list) list.push(f.id)
        else onPath.set(path, [f.id])
      }
      if (f.children?.length) walk(f.children, path)
    }
  }
  walk(spec.fields ?? [], '')
  for (const ids of onPath.values()) {
    if (ids.some((id) => out.has(id))) continue
    out.add(ids.find((id) => prev?.has(id)) ?? ids[0])
  }
  return out
}

/** Rows that are locked (`self`) or hold a locked row (`inside`), from latched ids. */
export function lockState(spec: MapSpec, locked: ReadonlySet<string>): Map<string, LockInfo> {
  const out = new Map<string, LockInfo>()
  const walk = (fields: Field[]): boolean => {
    let any = false
    for (const f of fields) {
      const self = locked.has(f.id)
      const inside = f.children?.length ? walk(f.children) : false
      if (self || inside) out.set(f.id, { self, inside })
      any = any || self || inside
    }
    return any
  }
  walk(spec.fields ?? [])
  return out
}

function lockReason(
  spec: MapSpec,
  id: string,
  locked: ReadonlySet<string>,
  verb: string
): string | null {
  const at = findField(spec, id)
  if (!at) return null
  const info = lockState(spec, locked).get(id)
  if (!info) return null
  if (info.self) return `“${at.path}” is read back by Nivaro — it can't be ${verb}.`
  return `“${at.path}” holds a field Nivaro reads back — it can't be ${verb}.`
}

// ─── Ops ─────────────────────────────────────────────────────────────────────

export function blankField(type: FieldType = 'text', id: string = newFieldId()): Field {
  const f: Field = { id, key: '', type, include: 'always' }
  if (type === 'object') f.children = []
  else if (type === 'list') {
    f.children = []
    f.list = { source: '', item: 'line' }
  } else f.value = { source: 'fixed', value: type === 'boolean' ? false : '' }
  return f
}

export interface AddFieldArgs {
  /** Insert right after this row (same group). */
  after?: string
  /** Append to this group row's children (ignored when `after` is set). */
  parent?: string | null
  key?: string
  type?: FieldType
}

/** Insert a new row; returns the new spec and the new row's id. */
export function addField(
  spec: MapSpec,
  args: AddFieldArgs,
  idGen: () => string = newFieldId
): { spec: MapSpec; id: string } {
  const field = blankField(args.type ?? 'text', idGen())
  if (args.key) field.key = args.key
  if (args.after) {
    const next = mapSiblings(spec, args.after, (siblings, i) => {
      const copy = siblings.slice()
      copy.splice(i + 1, 0, field)
      return copy
    })
    if (next) return { spec: next, id: field.id }
  }
  if (args.parent) {
    const next = mapField(spec, args.parent, (g) => ({
      ...g,
      children: [...(g.children ?? []), field]
    }))
    if (next !== spec) return { spec: next, id: field.id }
  }
  return { spec: { ...spec, fields: [...(spec.fields ?? []), field] }, id: field.id }
}

/** The row is the one field of a plain-values list (which must keep exactly one). */
export function inScalarList(spec: MapSpec, id: string): boolean {
  const at = findField(spec, id)
  return !!at?.parent && at.parent.type === 'list' && !!at.parent.list?.scalar
}

export const SCALAR_ONE_FIELD =
  'A plain-values list has exactly one field. Turn off “Plain values” in the list settings first.'

export function removeField(spec: MapSpec, id: string, locked: ReadonlySet<string>): OpResult {
  const reason = lockReason(spec, id, locked, 'removed')
  if (reason) return { ok: false, spec, reason }
  if (inScalarList(spec, id)) return { ok: false, spec, reason: SCALAR_ONE_FIELD }
  const next = mapSiblings(spec, id, (siblings, i) => siblings.filter((_, j) => j !== i))
  return next ? { ok: true, spec: next } : { ok: false, spec, reason: 'That field is gone.' }
}

export function renameKey(
  spec: MapSpec,
  id: string,
  key: string,
  locked: ReadonlySet<string>
): OpResult {
  const at = findField(spec, id)
  if (!at) return { ok: false, spec, reason: 'That field is gone.' }
  if (at.field.key === key) return { ok: true, spec }
  const reason = lockReason(spec, id, locked, 'renamed')
  if (reason) return { ok: false, spec, reason }
  return { ok: true, spec: mapField(spec, id, (f) => ({ ...f, key })) }
}

/** Change a row's type, reshaping value/children/list to fit it. */
export function setType(
  spec: MapSpec,
  id: string,
  type: FieldType,
  locked: ReadonlySet<string>
): OpResult {
  const at = findField(spec, id)
  if (!at) return { ok: false, spec, reason: 'That field is gone.' }
  if (at.field.type === type) return { ok: true, spec }
  const reason = lockReason(spec, id, locked, 'retyped')
  if (reason) return { ok: false, spec, reason }
  const next = mapField(spec, id, (f) => {
    const { value, children, list, ...rest } = f
    if (type === 'object') return { ...rest, type, children: children ?? [] }
    if (type === 'list')
      return { ...rest, type, children: children ?? [], list: list ?? { source: '', item: 'line' } }
    let v: ValueSpec | undefined = value
    if (!v) v = { source: 'fixed', value: type === 'boolean' ? false : '' }
    else if (v.source === 'fixed' && type === 'boolean' && typeof v.value !== 'boolean')
      v = { ...v, value: v.value === 'true' || v.value === 1 }
    return { ...rest, type, value: v }
  })
  return { ok: true, spec: next }
}

/** Merge a patch into a row. Key/type changes must go through renameKey/setType. */
export function updateField(
  spec: MapSpec,
  id: string,
  patch: Partial<Omit<Field, 'id' | 'key' | 'type'>>
): MapSpec {
  return mapField(spec, id, (f) => {
    const next: Field = { ...f, ...patch }
    for (const k of Object.keys(patch) as (keyof Field)[])
      if (patch[k as keyof typeof patch] === undefined) delete next[k]
    return next
  })
}

/** Set a row's value source. Locked rows may change it (only the key is fixed). */
export function updateValue(spec: MapSpec, id: string, value: ValueSpec | undefined): MapSpec {
  return updateField(spec, id, { value })
}

export function updateList(spec: MapSpec, id: string, patch: Partial<ListSpec>): MapSpec {
  return mapField(spec, id, (f) => {
    const list: ListSpec = { ...(f.list ?? { source: '', item: 'line' }), ...patch }
    for (const k of Object.keys(patch) as (keyof ListSpec)[])
      if (patch[k] === undefined || patch[k] === '' || (patch[k] as unknown) === false)
        if (k !== 'source' && k !== 'item') delete list[k]
    let children = f.children
    // A plain-values list has exactly one child whose value is the item.
    if (list.scalar && !(children ?? []).length) {
      children = [{ ...blankField('text'), value: { source: 'path', path: list.item || 'line' } }]
    }
    return { ...f, list, children }
  })
}

/** Names the render scope already uses — a list item called one of these would hide it. */
export const RESERVED_ALIASES = new Set([
  'record',
  'context',
  'state',
  'responses',
  'response',
  'acting_user',
  'list',
  'secrets'
])

function rewritePath(p: string, from: string, to: string): string {
  if (p === from) return to
  if (p.startsWith(`${from}.`) || p.startsWith(`${from}[`)) return to + p.slice(from.length)
  return p
}

function rewriteRules(rules: ConditionRule[] | undefined, from: string, to: string) {
  return rules?.map((r) => ({ ...r, field: rewritePath(r.field, from, to) }))
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function rewriteValue(v: ValueSpec | undefined, from: string, to: string): ValueSpec | undefined {
  if (!v) return v
  let out: ValueSpec = { ...v }
  if (out.source === 'path') out = { ...out, path: rewritePath(out.path, from, to) }
  else if (out.source === 'formula') {
    // `line.x` / `line[0]` in Liquid, never `xline.` or `a.line.`
    const re = new RegExp(`(^|[^\\w.])${escapeRe(from)}(?=[.\\[])`, 'g')
    out = { ...out, liquid: out.liquid.replace(re, `$1${to}`) }
  } else if (out.source === 'switch') {
    out = {
      ...out,
      cases: (out.cases ?? []).map((c) => ({
        when: rewriteRules(c.when, from, to) ?? [],
        value: rewriteValue(c.value, from, to) as ValueSpec
      })),
      ...(out.else ? { else: rewriteValue(out.else, from, to) } : {})
    }
  }
  if (v.fallbacks?.length)
    out.fallbacks = v.fallbacks.map((f) => rewriteValue(f, from, to) as ValueSpec)
  return out
}

function rewriteSort(sort: string, from: string, to: string): string {
  const desc = sort.startsWith('-')
  const out = rewritePath(desc ? sort.slice(1) : sort, from, to)
  return desc ? `-${out}` : out
}

function rewriteField(f: Field, from: string, to: string): Field {
  const out: Field = { ...f }
  if (f.value) out.value = rewriteValue(f.value, from, to)
  if (f.include && typeof f.include === 'object')
    out.include = { when: rewriteRules(f.include.when, from, to) ?? [] }
  if (f.list) {
    // The source is read in the outer scope; filter, sort and children in the inner one.
    out.list = { ...f.list, source: rewritePath(f.list.source, from, to) }
    // A nested list that names its rows `from` shadows ours: inside it, `from` is its own row.
    if ((f.list.item || 'line') === from) return out
    if (f.list.where) out.list.where = rewriteRules(f.list.where, from, to)
    if (f.list.sort) out.list.sort = rewriteSort(f.list.sort, from, to)
  }
  if (f.children) out.children = f.children.map((c) => rewriteField(c, from, to))
  return out
}

/** Names a list's rows can't take: scope roots, and the row names of the lists around and inside it. */
export function aliasConflict(spec: MapSpec, id: string, name: string): string | null {
  const n = name.trim()
  if (!n) return null
  if (RESERVED_ALIASES.has(n)) return `“${n}” is already a name in the payload`
  const outer: string[] = []
  const walk = (fields: Field[], aliases: string[]): boolean => {
    for (const f of fields) {
      if (f.id === id) {
        outer.push(...aliases)
        const inner: string[] = []
        const down = (fs: Field[]) => {
          for (const c of fs) {
            if (c.type === 'list') inner.push(c.list?.item || 'line')
            if (c.children?.length) down(c.children)
          }
        }
        down(f.children ?? [])
        outer.push(...inner)
        return true
      }
      const next = f.type === 'list' ? [...aliases, f.list?.item || 'line'] : aliases
      if (f.children?.length && walk(f.children, next)) return true
    }
    return false
  }
  walk(spec.fields ?? [], [])
  return outer.includes(n) ? `“${n}” already names the rows of another list here` : null
}

/**
 * Rename a list's item alias and every path inside the list that reads it
 * (`line.qty` → `row.qty`): values, fallbacks, If/then rules, include rules,
 * nested list sources/filters/sorts (not inside a nested list that reuses the
 * name), the list's own filter and sort, and Liquid formulas.
 *
 * A name that would capture other paths (`record`, `context`, another list's
 * row name — see aliasConflict) only sets `item`; nothing is rewritten and
 * `rewrote` is false, so the caller keeps rewriting from the last safe name.
 */
export function renameListAlias(
  spec: MapSpec,
  id: string,
  from: string,
  to: string
): { spec: MapSpec; rewrote: boolean } {
  const unsafe = !from || !to || from === to || !!aliasConflict(spec, id, to)
  const next = mapField(spec, id, (f) => {
    const list: ListSpec = { ...(f.list ?? { source: '', item: from }), item: to }
    if (unsafe) return { ...f, list }
    if (list.where) list.where = rewriteRules(list.where, from, to)
    if (list.sort) list.sort = rewriteSort(list.sort, from, to)
    return { ...f, list, children: f.children?.map((c) => rewriteField(c, from, to)) }
  })
  return { spec: next, rewrote: !unsafe }
}

/** Move a row one place up (-1) or down (+1) inside its own group. */
export function moveField(spec: MapSpec, id: string, delta: -1 | 1): OpResult {
  const at = findField(spec, id)
  if (!at) return { ok: false, spec, reason: 'That field is gone.' }
  const to = at.index + delta
  if (to < 0 || to >= at.siblings.length)
    return {
      ok: false,
      spec,
      reason: delta < 0 ? 'Already first in its group.' : 'Already last in its group.'
    }
  const next = mapSiblings(spec, id, (siblings, i) => arrayMove(siblings, i, to))
  return next ? { ok: true, spec: next } : { ok: false, spec, reason: 'That field is gone.' }
}

/** Drag-and-drop: put `id` where `overId` is. Both must share a group. */
export function moveFieldTo(spec: MapSpec, id: string, overId: string): OpResult {
  if (id === overId) return { ok: false, spec, reason: 'Same place.' }
  const a = findField(spec, id)
  const b = findField(spec, overId)
  if (!a || !b) return { ok: false, spec, reason: 'That field is gone.' }
  if (a.siblings !== b.siblings)
    return { ok: false, spec, reason: 'Fields move within their own group.' }
  const next = mapSiblings(spec, id, (siblings, i) => arrayMove(siblings, i, b.index))
  return next ? { ok: true, spec: next } : { ok: false, spec, reason: 'That field is gone.' }
}

export function arrayMove<T>(arr: T[], from: number, to: number): T[] {
  const copy = arr.slice()
  const [item] = copy.splice(from, 1)
  copy.splice(to, 0, item)
  return copy
}

function cloneWithIds(f: Field, idGen: () => string): Field {
  const { locked: _locked, ...rest } = f
  const copy: Field = JSON.parse(JSON.stringify(rest))
  copy.id = idGen()
  if (f.children) copy.children = f.children.map((c) => cloneWithIds(c, idGen))
  return copy
}

/** Copy a row (and its children) right below it, with fresh ids and a free key. */
export function duplicateField(
  spec: MapSpec,
  id: string,
  idGen: () => string = newFieldId
): { spec: MapSpec; id: string } {
  const at = findField(spec, id)
  if (!at) return { spec, id }
  const copy = cloneWithIds(at.field, idGen)
  const taken = new Set(at.siblings.map((s) => s.key))
  let key = `${at.field.key}_copy`
  for (let n = 2; taken.has(key); n++) key = `${at.field.key}_copy_${n}`
  copy.key = key
  const next = mapSiblings(spec, id, (siblings, i) => {
    const out = siblings.slice()
    out.splice(i + 1, 0, copy)
    return out
  })
  return { spec: next ?? spec, id: copy.id }
}

// ─── Structural checks (client-side shape only — never evaluation) ───────────

export type IssueCode =
  | 'empty_key'
  | 'duplicate_key'
  | 'key_spaces'
  | 'list_no_source'
  | 'alias_reserved'
  | 'bad_pattern'

export interface Issue {
  code: IssueCode
  message: string
}

/** Codes that are about the key itself (the key input turns red). */
export const KEY_ISSUES: ReadonlySet<IssueCode> = new Set([
  'empty_key',
  'duplicate_key',
  'key_spaces'
])

/** Shape problems per row id: empty / duplicate key, stray spaces, list without source, bad pattern. */
export function structuralIssues(spec: MapSpec): Map<string, Issue[]> {
  const out = new Map<string, Issue[]>()
  const add = (id: string, code: IssueCode, message: string) => {
    const list = out.get(id)
    if (list) list.push({ code, message })
    else out.set(id, [{ code, message }])
  }
  const walk = (fields: Field[], scalarParent: boolean) => {
    const seen = new Map<string, number>()
    if (!scalarParent) for (const f of fields) seen.set(f.key, (seen.get(f.key) ?? 0) + 1)
    for (const f of fields) {
      if (!scalarParent) {
        if (!f.key.trim())
          add(f.id, 'empty_key', 'Give this field a key — the partner reads it by name.')
        else {
          if ((seen.get(f.key) ?? 0) > 1)
            add(
              f.id,
              'duplicate_key',
              `Another field here is already called “${f.key}”. Keys must be unique.`
            )
          if (f.key !== f.key.trim())
            add(
              f.id,
              'key_spaces',
              'This key has a space at the start or end — the partner will not match it.'
            )
        }
      }
      if (f.type === 'list' && !f.list?.source?.trim())
        add(f.id, 'list_no_source', 'Choose what this list comes from.')
      if (f.type === 'list' && f.list?.item && RESERVED_ALIASES.has(f.list.item.trim()))
        add(
          f.id,
          'alias_reserved',
          `“${f.list.item}” is already a name in the payload — call each row something else.`
        )
      if (f.rules?.pattern) {
        try {
          new RegExp(f.rules.pattern)
        } catch {
          add(f.id, 'bad_pattern', 'The pattern rule is not a valid pattern.')
        }
      }
      if (f.children?.length) walk(f.children, f.type === 'list' && !!f.list?.scalar)
    }
  }
  walk(spec.fields ?? [], false)
  return out
}

/** Every visible row id in display order (skipping collapsed groups' children). */
export function visibleRowIds(spec: MapSpec, collapsed: ReadonlySet<string>): string[] {
  const out: string[] = []
  const walk = (fields: Field[]) => {
    for (const f of fields) {
      out.push(f.id)
      if (f.children?.length && !collapsed.has(f.id)) walk(f.children)
    }
  }
  walk(spec.fields ?? [])
  return out
}

/** Count rows (all depths) — for the summary line. */
export function countFields(fields: Field[] | undefined): number {
  let n = 0
  for (const f of fields ?? []) n += 1 + countFields(f.children)
  return n
}
