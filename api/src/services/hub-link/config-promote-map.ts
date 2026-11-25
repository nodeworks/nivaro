import { createHash } from 'node:crypto'
import { hashRow, type SnapshotRow } from '../config-inventory.js'

/**
 * Hub config promotion: rows are matched across environments by a NATURAL key, never by id —
 * two environments the Hub created have their own databases, so the same id is routinely a
 * different thing. Pure.
 *
 *   table                    natural key                        references (remapped)
 *   nivaro_roles             name                               workspace → workspace by name
 *   nivaro_policies          role + collection + action         role → role by name
 *   nivaro_flows             name
 *   nivaro_flow_operations   flow + step key (name if no key)   flow, resolve, reject → by key;
 *                                                               options: api_id / external_api →
 *                                                               external API by name, flow_id →
 *                                                               flow, run_as / user / owner →
 *                                                               person by email, role(s) → role
 *   nivaro_payload_templates key                                external_api → by name
 *   nivaro_settings          the one settings row
 *
 * A row the target has under the same natural key is updated in place (its own id); a row it
 * does not have is inserted with a NEW id (never the source's). Every reference is rewritten to
 * the target's id of the same thing; a raw id is never carried. Refusals (the plan answers them,
 * nothing is written):
 *   ROW_UNMATCHED  a row with no natural key, or two rows sharing one, or a new row whose new id
 *                  is already taken on the target
 *   REF_UNMAPPED   a reference the target has nothing for (an external API, person, role or
 *                  workspace of that name), or a literal id in step options the Hub cannot map
 * A step whose flow changed is a different natural key: a new step on the target (it never keeps
 * another step's URL).
 */

export type RefKind = 'role' | 'flow' | 'flow_op' | 'external_api' | 'user' | 'workspace'

export interface TableSpec {
  table: string
  idKind: 'uuid' | 'int'
  /** Natural key of a row; `nk(kind, id)` names a referenced row of this side. */
  natural(
    row: Record<string, unknown>,
    nk: (kind: RefKind, id: unknown) => string | null
  ): string | null
  refs: Record<string, RefKind>
  /** JSON columns whose ids are rewritten (flow step options). */
  jsonRefs?: string[]
  /** Permission JSON: role ids rewritten, any other uuid / id refused. */
  policyJson?: string[]
}

const low = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim().toLowerCase() : null)

export const SPECS: readonly TableSpec[] = [
  {
    table: 'nivaro_roles',
    idKind: 'uuid',
    natural: (r) => (low(r.name) ? `role:${low(r.name)}` : null),
    refs: { workspace: 'workspace' }
  },
  {
    table: 'nivaro_policies',
    idKind: 'int',
    natural: (r, nk) => {
      const role = nk('role', r.role)
      return role && low(r.collection) && low(r.action)
        ? `${role}|${low(r.collection)}|${low(r.action)}`
        : null
    },
    refs: { role: 'role' },
    policyJson: ['fields', 'permissions', 'presets', 'row_filter', 'validation']
  },
  {
    table: 'nivaro_flows',
    idKind: 'uuid',
    natural: (r) => (low(r.name) ? `flow:${low(r.name)}` : null),
    refs: {}
  },
  {
    table: 'nivaro_flow_operations',
    idKind: 'uuid',
    natural: (r, nk) => {
      const flow = nk('flow', r.flow)
      const step = low(r.key) ?? low(r.name)
      return flow && step ? `${flow}|${step}` : null
    },
    refs: { flow: 'flow', resolve: 'flow_op', reject: 'flow_op' },
    jsonRefs: ['options']
  },
  {
    table: 'nivaro_payload_templates',
    idKind: 'int',
    natural: (r) => (low(r.key) ? `tpl:${low(r.key)}` : null),
    refs: { external_api: 'external_api' }
  },
  {
    table: 'nivaro_settings',
    idKind: 'int',
    natural: () => 'settings',
    refs: {}
  }
]

export const SPEC_BY_TABLE = new Map(SPECS.map((s) => [s.table, s]))
const TABLE_OF: Partial<Record<RefKind, string>> = {
  role: 'nivaro_roles',
  flow: 'nivaro_flows',
  flow_op: 'nivaro_flow_operations'
}
/** The column a dictionary names a referenced row by. */
export const DICT_KINDS: readonly RefKind[] = ['external_api', 'user', 'workspace', 'role']

/** Step option keys that name another row, and what they name. */
export const OPTION_REFS: Record<string, RefKind> = {
  api_id: 'external_api',
  external_api: 'external_api',
  external_api_id: 'external_api',
  flow_id: 'flow',
  run_as: 'user',
  user: 'user',
  user_id: 'user',
  users: 'user',
  owner: 'user',
  owners: 'user',
  assignee: 'user',
  assignees: 'user',
  recipient: 'user',
  recipients: 'user',
  exclude: 'user',
  approver: 'user',
  approvers: 'user',
  notify_users: 'user',
  role: 'role',
  role_id: 'role',
  roles: 'role'
}
const RAW_ID_KEY = /(^|_)(id|ids)$|^items?$|^item_id$/i
/**
 * Option keys whose plain digits are a number, never a row (a timeout, a count, an HTTP status).
 * Any OTHER key holding a uuid or bare-integer string refuses the plan (REF_UNMAPPED) unless a
 * remap rule above handled it: an id never means the same row in two separately created databases.
 */
export const SAFE_NUMBER_KEYS = new Set([
  'timeout',
  'timeout_ms',
  'timeout_seconds',
  'limit',
  'retries',
  'retry',
  'max_retries',
  'delay',
  'delay_ms',
  'wait',
  'wait_ms',
  'interval',
  'interval_ms',
  'expect_status',
  'status_code',
  'port',
  'version',
  'priority',
  'sort',
  'days',
  'hours',
  'minutes',
  'seconds',
  'count',
  'max',
  'min',
  'size',
  'page',
  'page_size',
  'year',
  'month',
  'day',
  'decimals',
  'precision',
  'width',
  'height'
])
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** A literal id (never a template like {{ $trigger.key }}). */
export function isLiteralId(v: unknown): boolean {
  if (typeof v === 'number') return Number.isFinite(v)
  if (typeof v !== 'string') return false
  const t = v.trim()
  return /^\d+$/.test(t) || UUID_RE.test(t)
}

/** A string that is a list of literal ids ("a,b,c"): its parts, else null. */
export function idList(v: unknown): string[] | null {
  if (typeof v !== 'string' || !v.includes(',')) return null
  const parts = v
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)
  return parts.length && parts.every(isLiteralId) ? parts : null
}
export const isUuid = (v: unknown) => typeof v === 'string' && UUID_RE.test(v.trim())

export interface Refusal {
  code: 'ROW_UNMATCHED' | 'REF_UNMAPPED'
  table: string
  key: string
  label: string | null
  reason: string
}

/** A source / target dictionary: kind → id → name (source) or name → id (target). */
export type Dict = Partial<Record<RefKind, Record<string, string>>>
/** Target-dictionary markers: two rows share the name; the person's account cannot be used. */
export const DUPLICATE = '\u0000duplicate'
export const UNUSABLE = '\u0000unusable'

function labelOf(d: Record<string, unknown>): string | null {
  for (const k of ['name', 'label', 'key', 'collection']) {
    const v = d[k]
    if (typeof v === 'string' && v.trim()) return v.slice(0, 120)
  }
  return null
}

/** Ids a JSON value references, by kind (collect mode) — the source builds its dictionary. */
export function optionRefIds(v: unknown, out: Map<RefKind, Set<string>>): void {
  if (Array.isArray(v)) {
    for (const x of v) optionRefIds(x, out)
    return
  }
  if (!v || typeof v !== 'object') return
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    const kind = OPTION_REFS[k.toLowerCase()]
    if (kind) {
      for (const one of Array.isArray(x) ? x : (idList(x) ?? [x]))
        if (isLiteralId(one)) {
          const s = out.get(kind) ?? new Set<string>()
          s.add(String(one).trim())
          out.set(kind, s)
        }
    } else optionRefIds(x, out)
  }
}

/** Every id the source snapshot references outside its own tables, by kind. */
export function referencedIds(
  tables: Record<string, Record<string, SnapshotRow>>
): Map<RefKind, Set<string>> {
  const out = new Map<RefKind, Set<string>>()
  for (const spec of SPECS) {
    const rows = tables[spec.table]
    if (!rows) continue
    for (const row of Object.values(rows)) {
      for (const [col, kind] of Object.entries(spec.refs)) {
        const v = row.data[col]
        if (v == null || v === '' || (TABLE_OF[kind] && tables[TABLE_OF[kind] as string])) continue
        const s = out.get(kind) ?? new Set<string>()
        s.add(String(v))
        out.set(kind, s)
      }
      for (const col of spec.jsonRefs ?? []) {
        const v = row.data[col]
        const parsed = typeof v === 'string' ? safeParse(v) : v
        optionRefIds(parsed, out)
      }
    }
  }
  return out
}

function safeParse(v: string): unknown {
  try {
    return JSON.parse(v)
  } catch {
    return null
  }
}

function newUuid(table: string, nk: string, runKey: string): string {
  const h = createHash('sha256').update(`hub-config:${runKey}:${table}:${nk}`).digest('hex')
  // RFC 4122 shape (version 4 bits, variant 10) — a fresh id, never the source's.
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${((Number.parseInt(h[16], 16) & 3) | 8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`
}

export interface MapInput {
  source: Record<string, Record<string, SnapshotRow>>
  target: Record<string, Record<string, SnapshotRow>>
  /** Source: kind → id → name (external API name, person email, role / workspace name). */
  sourceDict: Dict
  /** Target: kind → lower-case name → id. */
  targetDict: Dict
  runKey: string
}

export interface MapOutput {
  tables: Record<string, Record<string, SnapshotRow>>
  refusals: Refusal[]
  /** source id → target id, per table (the flow steps' own bookkeeping uses it). */
  ids: Record<string, Map<string, string>>
  /** target ids of rows that are new on the target, per table. */
  inserted: Record<string, Set<string>>
}

/** Natural keys of one side, per table (dup = refusal). */
function naturalKeys(
  tables: Record<string, Record<string, SnapshotRow>>,
  side: 'source' | 'target',
  refusals: Refusal[] | null
): Record<string, { byId: Map<string, string>; byNk: Map<string, string>; dup: Set<string> }> {
  const out: Record<
    string,
    { byId: Map<string, string>; byNk: Map<string, string>; dup: Set<string> }
  > = {}
  const nk = (kind: RefKind, id: unknown): string | null => {
    const t = TABLE_OF[kind]
    if (!t || id == null) return null
    return out[t]?.byId.get(String(id)) ?? null
  }
  for (const spec of SPECS) {
    const rows = tables[spec.table]
    if (!rows) continue
    const byId = new Map<string, string>()
    const byNk = new Map<string, string>()
    const dup = new Set<string>()
    for (const [key, row] of Object.entries(rows)) {
      const k = spec.natural(row.data, nk)
      if (!k) {
        if (!refusals) continue
        refusals.push({
          code: 'ROW_UNMATCHED',
          table: spec.table,
          key,
          label: labelOf(row.data),
          reason: `The ${side} row has no ${spec.table === 'nivaro_flow_operations' ? 'flow and step key' : 'name or key'} to match it by`
        })
        continue
      }
      if (byNk.has(k)) dup.add(k)
      byId.set(key, k)
      byNk.set(k, key)
    }
    for (const k of dup) {
      for (const [key, v] of byId)
        if (v === k && refusals)
          refusals.push({
            code: 'ROW_UNMATCHED',
            table: spec.table,
            key,
            label: labelOf(rows[key]?.data ?? {}),
            reason: `More than one ${side} row is called ${k.replace(/^[a-z]+:/, '')} — the Hub cannot tell which one is meant`
          })
      byNk.delete(k)
    }
    out[spec.table] = { byId, byNk, dup }
  }
  return out
}

/** The source snapshot rewritten to the target's ids. Pure. */
export function mapToTarget(input: MapInput): MapOutput {
  const refusals: Refusal[] = []
  const src = naturalKeys(input.source, 'source', refusals)
  const tgt = naturalKeys(input.target, 'target', null)
  const ids: Record<string, Map<string, string>> = {}
  const inserted: Record<string, Set<string>> = {}
  // 1. ids: matched by natural key, else a new one.
  for (const spec of SPECS) {
    const rows = input.source[spec.table]
    if (!rows) continue
    const m = new Map<string, string>()
    const ins = new Set<string>()
    const live = input.target[spec.table] ?? {}
    let next =
      spec.idKind === 'int'
        ? Math.max(
            0,
            ...Object.keys(live)
              .map((k) => Number(k))
              .filter(Number.isFinite)
          ) + 1
        : 0
    const order = [...(src[spec.table]?.byId ?? new Map()).entries()].sort((a, b) =>
      a[1].localeCompare(b[1])
    )
    for (const [srcId, nk] of order) {
      if (spec.table === 'nivaro_settings') {
        const one = Object.keys(live).sort((a, b) => Number(a) - Number(b))[0]
        if (one) m.set(srcId, one)
        else {
          m.set(srcId, '1')
          ins.add('1')
        }
        break
      }
      if (tgt[spec.table]?.dup.has(nk)) {
        refusals.push({
          code: 'ROW_UNMATCHED',
          table: spec.table,
          key: srcId,
          label: labelOf(rows[srcId]?.data ?? {}),
          reason: `The target has more than one row called ${nk.replace(/^[a-z]+:/, '')} — the Hub cannot tell which one to update`
        })
        continue
      }
      const hit = tgt[spec.table]?.byNk.get(nk)
      if (hit) {
        m.set(srcId, hit)
        continue
      }
      const id = spec.idKind === 'uuid' ? newUuid(spec.table, nk, input.runKey) : String(next++)
      if (live[id]) {
        refusals.push({
          code: 'ROW_UNMATCHED',
          table: spec.table,
          key: srcId,
          label: labelOf(rows[srcId]?.data ?? {}),
          reason: `The id the Hub would give this new row is taken on the target`
        })
        continue
      }
      m.set(srcId, id)
      ins.add(id)
    }
    ids[spec.table] = m
    inserted[spec.table] = ins
  }

  const mapRef = (
    kind: RefKind,
    v: unknown,
    where: { table: string; key: string; label: string | null; what: string }
  ): { ok: true; value: unknown } | { ok: false } => {
    if (v == null || v === '') return { ok: true, value: v }
    const t = TABLE_OF[kind]
    if (t && input.source[t]) {
      const hit = ids[t]?.get(String(v))
      if (hit) return { ok: true, value: hit }
      refusals.push({
        code: 'REF_UNMAPPED',
        ...where,
        reason: `${where.what} points at a ${kind.replace('_', ' ')} that is not in this promotion`
      })
      return { ok: false }
    }
    const name = input.sourceDict[kind]?.[String(v)]
    const id = name ? input.targetDict[kind]?.[name.toLowerCase()] : undefined
    if (id === DUPLICATE) {
      refusals.push({
        code: 'REF_UNMAPPED',
        ...where,
        reason: `${where.what} points at “${name}”, and the target has more than one ${kind.replace('_', ' ')} of that name`
      })
      return { ok: false }
    }
    if (id === UNUSABLE) {
      refusals.push({
        code: 'REF_UNMAPPED',
        ...where,
        reason: `${where.what} points at “${name}”, whose account on the target is suspended, redacted or a machine account`
      })
      return { ok: false }
    }
    if (id != null) return { ok: true, value: typeof v === 'number' ? Number(id) : id }
    refusals.push({
      code: 'REF_UNMAPPED',
      ...where,
      reason: name
        ? `${where.what} points at ${kind === 'user' ? 'the person' : `the ${kind.replace('_', ' ')}`} “${name}”, which the target does not have`
        : `${where.what} points at a ${kind.replace('_', ' ')} the source could not name`
    })
    return { ok: false }
  }

  const mapOptions = (
    v: unknown,
    where: { table: string; key: string; label: string | null },
    path: string
  ): unknown => {
    if (Array.isArray(v)) return v.map((x, i) => mapOptions(x, where, `${path}[${i}]`))
    if (!v || typeof v !== 'object') return v
    const out: Record<string, unknown> = {}
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      const p = path ? `${path}.${k}` : k
      const kind = OPTION_REFS[k.toLowerCase()]
      if (kind) {
        const one = (y: unknown) =>
          isLiteralId(y)
            ? mapRef(kind, y, { ...where, what: `Step option ${p}` })
            : { ok: true, value: y }
        const list = idList(x)
        if (list) {
          out[k] = list
            .map((y) => {
              const r = one(y)
              return r.ok ? String((r as { value: unknown }).value) : y
            })
            .join(',')
        } else if (Array.isArray(x)) {
          out[k] = x.map((y) => {
            const r = one(y)
            return r.ok ? (r as { value: unknown }).value : y
          })
        } else {
          const r = one(x)
          out[k] = r.ok ? (r as { value: unknown }).value : x
        }
        continue
      }
      const literalString = (y: unknown) => typeof y === 'string' && (isLiteralId(y) || !!idList(y))
      const unsafe =
        (RAW_ID_KEY.test(k) && (isLiteralId(x) || (Array.isArray(x) && x.some(isLiteralId)))) ||
        (!SAFE_NUMBER_KEYS.has(k.toLowerCase()) &&
          (literalString(x) || (Array.isArray(x) && x.some(literalString)))) ||
        isUuid(x)
      if (unsafe) {
        refusals.push({
          code: 'REF_UNMAPPED',
          ...where,
          reason: `Step option ${p} holds a literal id the Hub cannot map to the target (use a template, or set it on the target)`
        })
        out[k] = x
        continue
      }
      out[k] = mapOptions(x, where, p)
    }
    return out
  }

  /** Permission JSON: a role id is rewritten to the target's role; any other uuid or id refuses. */
  /**
   * Permission JSON: a role id is rewritten to the target's role. ANY other uuid or literal
   * integer leaf refuses (REF_UNMAPPED) — whatever key holds it, operators included
   * (`{ owner: { _eq: 42 } }`, `_in` lists, nested `_and` / `_or`) — unless the nearest field
   * above it is a known number (SAFE_NUMBER_KEYS). `field` = that nearest non-operator key.
   */
  const mapPolicy = (
    v: unknown,
    where: { table: string; key: string; label: string | null },
    path: string,
    field: string | null
  ): unknown => {
    if (Array.isArray(v)) return v.map((x, i) => mapPolicy(x, where, `${path}[${i}]`, field))
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {}
      for (const [k, x] of Object.entries(v as Record<string, unknown>))
        out[k] = mapPolicy(x, where, path ? `${path}.${k}` : k, k.startsWith('_') ? field : k)
      return out
    }
    const on = field ? ` (field ${field})` : ''
    if (isUuid(v)) {
      const role = ids.nivaro_roles?.get(String(v).trim())
      if (role) return role
      refusals.push({
        code: 'REF_UNMAPPED',
        ...where,
        reason: `Permission rule ${path}${on} holds an id (${String(v).slice(0, 8)}…) the Hub cannot map to the target — use $CURRENT_USER / $CURRENT_ROLE, or set it on the target`
      })
      return v
    }
    const integer =
      (typeof v === 'number' && Number.isInteger(v)) ||
      (typeof v === 'string' && /^\s*\d+\s*$/.test(v))
    if (integer && !(field && SAFE_NUMBER_KEYS.has(field.toLowerCase())))
      refusals.push({
        code: 'REF_UNMAPPED',
        ...where,
        reason: `Permission rule ${path}${on} holds a literal id (${String(v).slice(0, 20)}) the Hub cannot map to the target — use $CURRENT_USER / $CURRENT_ROLE, or set the rule on the target`
      })
    return v
  }

  // 2. rows rewritten: their own id, every reference, step option ids.
  const tables: Record<string, Record<string, SnapshotRow>> = {}
  for (const spec of SPECS) {
    const rows = input.source[spec.table]
    if (!rows) continue
    const out: Record<string, SnapshotRow> = {}
    for (const [srcId, row] of Object.entries(rows)) {
      const id = ids[spec.table]?.get(srcId)
      if (!id) continue
      const where = { table: spec.table, key: srcId, label: labelOf(row.data) }
      const data: Record<string, unknown> = {
        ...row.data,
        id: spec.idKind === 'int' ? Number(id) : id
      }
      for (const [col, kind] of Object.entries(spec.refs)) {
        if (!(col in data)) continue
        const r = mapRef(kind, data[col], { ...where, what: col })
        if (r.ok) data[col] = (r as { value: unknown }).value
      }
      for (const col of spec.policyJson ?? []) {
        const v = data[col]
        if (typeof v !== 'string' || !v.trim()) continue
        const parsed = safeParse(v)
        if (parsed && typeof parsed === 'object')
          data[col] = JSON.stringify(mapPolicy(parsed, where, col, null))
      }
      for (const col of spec.jsonRefs ?? []) {
        const v = data[col]
        if (typeof v !== 'string' || !v.trim()) continue
        const parsed = safeParse(v)
        if (parsed && typeof parsed === 'object')
          data[col] = JSON.stringify(mapOptions(parsed, where, ''))
      }
      out[id] = { hash: hashRow(data), data }
    }
    tables[spec.table] = out
  }
  return { tables, refusals, ids, inserted }
}
