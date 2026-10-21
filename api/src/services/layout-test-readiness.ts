import type { ReadinessResult } from '@nivaro/extension-kit'
import { db } from '../db/index.js'
import { NIVARO_VERSION } from '../version.js'
import { type RoleFieldAccess, roleFieldAccess } from './layout-field-access.js'
import { parseConditions, parseRecordConditions } from './layout-patch.js'
import { getReadinessRedis, registerReadinessCheck } from './readiness.js'
import { currentTenantKey } from './tenant-rooms.js'

/**
 * Test records as a readiness check (#2720). The records an admin pinned to a
 * form (#2646, `conditions.testing.records`) are opened the way the live
 * resolver would open them — which form, and which fields that form shows
 * them and whether their role may edit each — once per run. The first run on
 * a new API version compares with what the previous version recorded, so a
 * deploy (or a form change since) that changes what a test record sees is a
 * warning that names the record and the change. "Accept" makes the current
 * view the one compared with.
 *
 * The view is judged as /active serves the form: the placements left visible,
 * sections hidden from the role dropped, the role's field permissions and
 * sections locked for it. Show-when rules on tabs are not judged (they follow
 * the record's values, not the deploy).
 *
 * The record of what was seen is kept in Redis per tenant (no table); without
 * Redis it lives in this process only.
 */

export interface PinRef {
  layout_id: number
  layout_name: string
  collection: string
  item: string
  role_id: string | null
}

export type SeenView =
  | { state: 'ok'; form_id: number; form_name: string; fields: string[] }
  | { state: 'missing' }
  | { state: 'no_access' }
  | { state: 'no_form' }

export interface SeenState {
  version: string
  at: string
  seen: Record<string, SeenView>
  prev_version: string | null
  prev: Record<string, SeenView> | null
}

export const pinKey = (p: { layout_id: number; item: string; role_id: string | null }) =>
  `${p.layout_id}|${p.item}|${(p.role_id ?? '').toUpperCase()}`

const RO = ':ro'

/** "12 · Field Tech" / "12 · as an administrator". */
function who(p: PinRef, roleName: (id: string) => string): string {
  return `${p.collection} ${p.item} ${p.role_id ? `as ${roleName(p.role_id)}` : 'as an administrator'}`
}

const list = (xs: string[], max = 4) =>
  xs.length <= max ? xs.join(', ') : `${xs.slice(0, max).join(', ')} and ${xs.length - max} more`

/** One plain line per pinned record whose view changed (empty when none did). */
export function diffSeen(
  pins: PinRef[],
  prev: Record<string, SeenView>,
  now: Record<string, SeenView>,
  roleName: (id: string) => string = (id) => id
): string[] {
  const out: string[] = []
  for (const p of pins) {
    const k = pinKey(p)
    const a = prev[k]
    const b = now[k]
    if (!a || !b) continue
    const head = `“${p.layout_name}” test record ${who(p, roleName)}`
    if (a.state !== 'ok' || b.state !== 'ok') {
      if (a.state === b.state) continue
      const say = (v: SeenView) =>
        v.state === 'ok'
          ? `opens “${v.form_name}”`
          : v.state === 'missing'
            ? 'is not found'
            : v.state === 'no_access'
              ? 'cannot be read by its role'
              : 'opens no form'
      out.push(`${head}: now ${say(b)} (before: ${say(a)})`)
      continue
    }
    if (a.form_id !== b.form_id) {
      out.push(`${head}: now opens “${b.form_name}” (was “${a.form_name}”)`)
      continue
    }
    const field = (f: string) => (f.endsWith(RO) ? f.slice(0, -RO.length) : f)
    const aMap = new Map(a.fields.map((f) => [field(f), f.endsWith(RO)]))
    const bMap = new Map(b.fields.map((f) => [field(f), f.endsWith(RO)]))
    const gained = [...bMap.keys()].filter((f) => !aMap.has(f))
    const lost = [...aMap.keys()].filter((f) => !bMap.has(f))
    const nowRo = [...bMap.keys()].filter((f) => aMap.get(f) === false && bMap.get(f) === true)
    const nowRw = [...bMap.keys()].filter((f) => aMap.get(f) === true && bMap.get(f) === false)
    const parts: string[] = []
    if (lost.length) parts.push(`no longer shows ${list(lost)}`)
    if (gained.length) parts.push(`now shows ${list(gained)}`)
    if (nowRo.length) parts.push(`can no longer edit ${list(nowRo)}`)
    if (nowRw.length) parts.push(`can now edit ${list(nowRw)}`)
    if (parts.length) out.push(`${head}: ${parts.join('; ')}`)
  }
  return out
}

/** Every pinned test record on record forms (conditions.testing.records). */
export function pinsOf(
  layouts: Array<{ id: unknown; name?: unknown; collection?: unknown; conditions?: unknown }>
): PinRef[] {
  const out: PinRef[] = []
  for (const l of layouts) {
    const c = parseConditions(l.conditions) as Record<string, unknown> | null
    const t = c?.testing as { records?: unknown } | undefined
    if (!t || !Array.isArray(t.records)) continue
    const seen = new Set<string>()
    for (const r of t.records.slice(0, 5) as Array<{ item?: unknown; role_id?: unknown }>) {
      if (r?.item == null || r.item === '') continue
      const pin: PinRef = {
        layout_id: Number(l.id),
        layout_name: String(l.name ?? l.id),
        collection: String(l.collection),
        item: String(r.item).slice(0, 64),
        role_id: r.role_id ? String(r.role_id) : null
      }
      const k = pinKey(pin)
      if (seen.has(k)) continue
      seen.add(k)
      out.push(pin)
    }
  }
  return out
}

/**
 * The next stored state after a run on `version`: a new version moves what
 * the previous one saw into `prev`; the same version keeps its `prev`.
 */
export function nextState(
  state: SeenState | null,
  version: string,
  seen: Record<string, SeenView>,
  at: string
): SeenState {
  if (!state) return { version, at, seen, prev_version: null, prev: null }
  if (state.version !== version)
    return { version, at, seen, prev_version: state.version, prev: state.seen }
  return { ...state, at, seen }
}

// ─── The form a record sees ─────────────────────────────────────────────────

type Row = Record<string, unknown>

const roleListed = (raw: unknown, roleId: string | null) => {
  if (!roleId || raw == null || raw === '') return false
  try {
    const v = typeof raw === 'string' ? JSON.parse(raw) : raw
    return Array.isArray(v) && v.some((r) => String(r).toUpperCase() === roleId.toUpperCase())
  } catch {
    return false
  }
}

const off = (v: unknown) => v === false || v === 0 || v === '0'

/**
 * The fields a form shows a role, `field` or `field:ro`, sorted. `access`
 * null = an administrator (everything visible is editable).
 */
export function formFields(
  groups: Row[],
  assignments: Row[],
  roleId: string | null,
  access: RoleFieldAccess | null
): string[] {
  const byId = new Map(groups.map((g) => [Number(g.id), g]))
  const byKey = new Map(groups.map((g) => [String(g.key), g]))
  const chain = (key: unknown): Row[] => {
    const out: Row[] = []
    let g = key == null ? undefined : byKey.get(String(key))
    const seen = new Set<number>()
    while (g && !seen.has(Number(g.id))) {
      out.push(g)
      seen.add(Number(g.id))
      g = g.container_id == null ? undefined : byId.get(Number(g.container_id))
    }
    return out
  }
  const admin = !access || access.role.admin_access
  const hidden = new Set(admin ? [] : access.hidden_fields)
  const readonly = new Set(admin ? [] : access.readonly_fields)
  const out = new Set<string>()
  for (const a of assignments) {
    const field = String(a.field ?? '')
    if (!field || field.startsWith('__') || off(a.is_visible)) continue
    const groupsOf = chain(a.group_key)
    if (!admin && groupsOf.some((g) => roleListed(g.hidden_for_roles, roleId))) continue
    if (hidden.has(field)) continue
    const ro =
      !admin &&
      (!access.can_update ||
        readonly.has(field) ||
        groupsOf.some((g) => roleListed(g.locked_for_roles, roleId)))
    out.add(ro ? `${field}${RO}` : field)
  }
  return [...out].sort()
}

export interface TestReadinessDeps {
  /** The live resolver (pickBestLayoutTraced). */
  pick(
    candidates: Row[],
    userRoleId: string | null,
    record: Row | null,
    isAdmin: boolean
  ): Row | null
  /** The record-form candidates of a collection, in /active order. */
  candidates(collection: string): Promise<Row[]>
}

async function formRows(layout: Row): Promise<{ groups: Row[]; assignments: Row[] }> {
  const load = (id: number) =>
    Promise.all([
      db('nivaro_field_groups')
        .where({ layout_id: id })
        .select('id', 'key', 'container_id', 'hidden_for_roles', 'locked_for_roles') as Promise<
        Row[]
      >,
      db('nivaro_layout_field_assignments')
        .where({ layout_id: id })
        .select('field', 'group_key', 'is_visible') as Promise<Row[]>
    ])
  let [groups, assignments] = await load(Number(layout.id))
  // Layout inheritance, as /active: parent rows fill in what the child lacks.
  if (layout.parent_layout_id) {
    const [pg, pa] = await load(Number(layout.parent_layout_id)).catch(
      () => [[], []] as [Row[], Row[]]
    )
    const haveF = new Set(assignments.map((a) => String(a.field)))
    const haveG = new Set(groups.map((g) => String(g.key)))
    assignments = [...assignments, ...pa.filter((a) => !haveF.has(String(a.field)))]
    groups = [...groups, ...pg.filter((g) => !haveG.has(String(g.key)))]
  }
  return { groups, assignments }
}

/** What every pinned record sees now. */
export async function seenNow(
  pins: PinRef[],
  deps: TestReadinessDeps
): Promise<{ seen: Record<string, SeenView>; roles: Map<string, string> }> {
  const seen: Record<string, SeenView> = {}
  const roleIds = [...new Set(pins.flatMap((p) => (p.role_id ? [p.role_id] : [])))]
  const roleRows = roleIds.length
    ? ((await db('nivaro_roles')
        .whereIn('id', roleIds)
        .select('id', 'name', 'admin_access')) as Array<{
        id: string
        name: string
        admin_access: unknown
      }>)
    : []
  const roles = new Map(roleRows.map((r) => [String(r.id).toUpperCase(), r]))
  const byCollection = new Map<string, PinRef[]>()
  for (const p of pins)
    byCollection.set(p.collection, [...(byCollection.get(p.collection) ?? []), p])

  for (const [collection, list] of byCollection) {
    const registered = await db('nivaro_collections').where({ collection }).first('collection')
    if (!registered) {
      for (const p of list) seen[pinKey(p)] = { state: 'missing' }
      continue
    }
    const candidates = await deps.candidates(collection)
    const ruleFields = new Set<string>()
    for (const c of candidates)
      for (const r of parseRecordConditions(c.record_conditions) ?? [])
        if (typeof r.field === 'string' && /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(r.field))
          ruleFields.add(r.field)
    const info = (await db(collection)
      .columnInfo()
      .catch(() => ({}))) as Record<string, unknown>
    const physical = new Map(Object.keys(info).map((c) => [c.toLowerCase(), c]))
    const columns = [
      ...new Set(
        ['id', ...ruleFields].flatMap((f) => {
          const col = physical.get(f.toLowerCase())
          return col ? [col] : []
        })
      )
    ]
    const records = new Map<string, Row>()
    if (columns.length) {
      const rows = (await db(collection)
        .whereIn(
          'id',
          list.map((p) => p.item)
        )
        .select(columns)
        .catch(() => [])) as Row[]
      for (const r of rows) records.set(String(r.id).toUpperCase(), r)
    }
    const allFields = (await db('nivaro_fields').where({ collection }).pluck('field')) as string[]
    const accessCache = new Map<string, RoleFieldAccess>()
    const formCache = new Map<number, { groups: Row[]; assignments: Row[] }>()
    for (const p of list) {
      const k = pinKey(p)
      const record = records.get(p.item.toUpperCase()) ?? null
      if (!record) {
        seen[k] = { state: 'missing' }
        continue
      }
      const role = p.role_id ? (roles.get(p.role_id.toUpperCase()) ?? null) : null
      const isAdmin = role ? !!role.admin_access : true
      const roleId = role ? String(role.id) : null
      let access: RoleFieldAccess | null = null
      if (role && !isAdmin) {
        const ak = String(role.id).toUpperCase()
        if (!accessCache.has(ak))
          accessCache.set(ak, await roleFieldAccess(collection, role, allFields))
        access = accessCache.get(ak) ?? null
        if (access && !access.can_read) {
          seen[k] = { state: 'no_access' }
          continue
        }
      }
      const form = deps.pick(candidates, isAdmin ? null : roleId, record, isAdmin)
      if (!form) {
        seen[k] = { state: 'no_form' }
        continue
      }
      const id = Number(form.id)
      if (!formCache.has(id)) formCache.set(id, await formRows(form))
      const rows = formCache.get(id) as { groups: Row[]; assignments: Row[] }
      seen[k] = {
        state: 'ok',
        form_id: id,
        form_name: String(form.name ?? id),
        fields: formFields(rows.groups, rows.assignments, roleId, access)
      }
    }
  }
  return { seen, roles: new Map(roleRows.map((r) => [String(r.id).toUpperCase(), r.name])) }
}

// ─── Store ──────────────────────────────────────────────────────────────────

const memory = new Map<string, SeenState>()
const storeKey = () => `nvr:layout-test-seen:v1:${currentTenantKey()}`
const KEEP_S = 180 * 86_400

async function readState(): Promise<SeenState | null> {
  const redis = getReadinessRedis()
  if (redis) {
    try {
      const raw = await redis.get(storeKey())
      if (raw) {
        const v = JSON.parse(raw) as SeenState
        if (v && typeof v.version === 'string' && v.seen) return v
      }
      return null
    } catch {
      // fall through to this process's copy
    }
  }
  return memory.get(storeKey()) ?? null
}

async function writeState(state: SeenState): Promise<void> {
  memory.set(storeKey(), state)
  const redis = getReadinessRedis()
  if (!redis) return
  try {
    await redis.set(storeKey(), JSON.stringify(state), 'EX', KEEP_S)
  } catch {
    // kept in this process
  }
}

async function loadPins(): Promise<PinRef[]> {
  const rows = (await db('nivaro_collection_layouts')
    .where((b) => b.where({ layout_type: 'grouped' }).orWhereNull('layout_type'))
    .where('conditions', 'like', '%"testing"%')
    .select('id', 'name', 'collection', 'conditions')) as Row[]
  return pinsOf(rows as Array<{ id: unknown; name?: unknown; collection?: unknown }>)
}

/** One run: what pinned records see now against what the previous version saw. */
export async function runTestRecordsCheck(
  deps: TestReadinessDeps,
  version: string = NIVARO_VERSION
): Promise<ReadinessResult> {
  const pins = await loadPins()
  if (pins.length === 0)
    return {
      status: 'skip',
      detail:
        'No form has pinned test records. Pin some in the layout editor (Test) to check them after each deploy.'
    }
  const { seen, roles } = await seenNow(pins, deps)
  const state = nextState(await readState(), version, seen, new Date().toISOString())
  await writeState(state)
  const forms = new Set(pins.map((p) => p.layout_id)).size
  const counted = `${pins.length} test record${pins.length === 1 ? '' : 's'} on ${forms} form${forms === 1 ? '' : 's'}`
  if (!state.prev)
    return {
      status: 'pass',
      detail: `Recorded what ${counted} see; the next deploy is compared with it.`
    }
  const lines = diffSeen(pins, state.prev, seen, (id) => roles.get(id.toUpperCase()) ?? id)
  const since = state.prev_version ? `version ${state.prev_version}` : 'the last accepted check'
  if (lines.length === 0)
    return { status: 'pass', detail: `${counted} see the same as on ${since}.` }
  return {
    status: 'warn',
    detail: `${lines.length} of ${counted} see something different from ${since}. Check each form, then accept.`,
    blockers: lines.slice(0, 10)
  }
}

/** "Accept": what records see now becomes the view later runs compare with. */
export async function acceptTestRecords(
  deps: TestReadinessDeps,
  version: string = NIVARO_VERSION
): Promise<{ detail: string }> {
  const pins = await loadPins()
  const { seen } = await seenNow(pins, deps)
  const at = new Date().toISOString()
  await writeState({ version, at, seen, prev_version: null, prev: seen })
  return { detail: `Accepted what ${pins.length} test record(s) see now.` }
}

let registered = false

/** Registered once, by the layouts routes (they own the resolver). */
export function registerTestRecordsReadiness(deps: TestReadinessDeps): void {
  if (registered) return
  registered = true
  registerReadinessCheck({
    id: 'layout-test-records',
    label: 'Pinned test records still see their forms as before',
    group: 'Configuration',
    description:
      'Each record pinned to a form in the layout editor is opened as its role would open it: which form, which fields it shows and which the role may edit. After a deploy this is compared with what the previous version showed.',
    cost: 'heavy',
    ttlMs: 30 * 60_000,
    run: () => runTestRecordsCheck(deps),
    remediation: {
      label: 'Accept what test records see now',
      run: () => acceptTestRecords(deps)
    }
  })
}
