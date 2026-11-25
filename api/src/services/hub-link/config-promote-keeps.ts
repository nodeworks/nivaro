import { type ConfigSnapshot, hashRow, type SnapshotRow } from '../config-inventory.js'
import type { EnvKeepEntry } from '../env-refresh/registry.js'
import {
  exportStepOptions,
  mergeOwn,
  newInboundAuth,
  parseJsonObject,
  stepTop,
  triggerTop
} from './config-promote-secrets.js'

/**
 * Hub config promotion — what the TARGET keeps, pure. Rows arrive already matched by natural key
 * and keyed by the target's ids (config-promote-map), so "the same row" here is truly the same
 * thing on both sides.
 *
 *  - keep registry (core + extensions): `table` / `rows` / `delegate` entries refuse the table;
 *    `columns` entries take those columns off every incoming row. A row new here: switch columns
 *    arrive off; any other kept column holds the row back (named on the plan).
 *  - flow steps: a matched step gets the target's own outbound options and nested secrets back
 *    (mergeOwn); a new step has none. A step that needs this environment's values (the source
 *    stripped an outbound part the target does not have) switches its flow OFF and is named in
 *    `needs_setup` — new flows and existing active ones alike.
 *  - flow triggers: the webhook inbound-auth group is the target's own; a webhook flow new here
 *    (or a flow that becomes a webhook here) gets bearer auth with a fresh secret and arrives off.
 */

const FLOW_OPS = 'nivaro_flow_operations'
const FLOWS = 'nivaro_flows'
const FLOW_OPS_KEEP = 'core:flow-op-endpoints'

/** A switch column and the value a row new to this environment gets (off). */
export function switchOff(table: string, column: string): { value: unknown } | null {
  if (/^(enabled|is_active|active)$/.test(column)) return { value: false }
  if (column === 'status' && table === FLOWS) return { value: 'inactive' }
  return null
}

const rehash = (data: Record<string, unknown>): SnapshotRow => ({ hash: hashRow(data), data })

/** Every column the keep registry marks secret, per table. */
export function secretColumnsByTable(keeps: readonly EnvKeepEntry[]): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>()
  for (const k of keeps) {
    if (!k.secret_columns?.length) continue
    const set = out.get(k.table) ?? new Set<string>()
    for (const c of k.secret_columns) set.add(c)
    out.set(k.table, set)
  }
  return out
}

/**
 * Keep-registry columns that are a PART of a column ("pseudo-columns"), with how each is taken
 * off a row: `nivaro_flow_operations.outbound` = the outbound options inside a step's options;
 * `.fields` names them (no value). A rule naming neither a real column nor one of these fails the
 * guard test, and stripKeepSecrets throws on the source.
 */
export const KEEP_PSEUDO_COLUMNS: Record<
  string,
  Record<string, (data: Record<string, unknown>) => Record<string, unknown>>
> = {
  [FLOW_OPS]: {
    outbound: (d) => ('options' in d ? { ...d, options: exportStepOptions(d.options).options } : d),
    fields: (d) => d
  }
}

/**
 * The snapshot without any column (or pseudo-column) the keep registry calls a secret. `strict`
 * (the source, reading its own rows: every column is there unless the snapshot redaction dropped
 * it — `redacted`) throws on a secret name it cannot apply; the target is lenient (an older
 * source may not have a newer column).
 */
export function stripKeepSecrets(
  snap: ConfigSnapshot,
  keeps: readonly EnvKeepEntry[],
  opts: { strict?: boolean; redacted?: (table: string, column: string) => boolean } = {}
): ConfigSnapshot {
  const secrets = secretColumnsByTable(keeps)
  const tables: ConfigSnapshot['tables'] = {}
  for (const [table, rows] of Object.entries(snap.tables)) {
    const drop = secrets.get(table)
    if (!drop?.size) {
      tables[table] = rows
      continue
    }
    const pseudo = KEEP_PSEUDO_COLUMNS[table] ?? {}
    const list = Object.values(rows)
    if (opts.strict && list.length)
      for (const c of drop) {
        if (pseudo[c] || opts.redacted?.(table, c)) continue
        if (!list.some((r) => c in r.data))
          throw new Error(
            `The keep rule for ${table} names ${c}, which is neither a column of its rows nor a part this promotion knows how to strip`
          )
      }
    const out: Record<string, SnapshotRow> = {}
    for (const [key, row] of Object.entries(rows)) {
      let data: Record<string, unknown> = {}
      for (const [c, v] of Object.entries(row.data)) if (!drop.has(c) || pseudo[c]) data[c] = v
      for (const c of drop) if (pseudo[c]) data = pseudo[c](data)
      out[key] = rehash(data)
    }
    tables[table] = out
  }
  return { ...snap, tables }
}

export interface KeptNote {
  table: string
  label: string
  columns: string[]
}
export interface HeldRow {
  table: string
  key: string
  label: string | null
  reason: string
}
export interface SetupNote {
  flow: string | null
  step: string | null
  reason: string
}
export interface Prepared {
  tables: ConfigSnapshot['tables']
  refused: Array<{ table: string; reason: string }>
  kept: KeptNote[]
  held: HeldRow[]
  switched_off: Array<{ table: string; key: string; label: string | null }>
  needs_setup: SetupNote[]
}

function rowLabel(data: Record<string, unknown> | undefined): string | null {
  for (const k of ['name', 'label', 'title', 'key', 'collection']) {
    const v = data?.[k]
    if (typeof v === 'string' && v.trim()) return v.slice(0, 120)
  }
  return null
}

/** The keep registry over rows keyed by the target's ids. `live` = the target's rows. Pure. */
export function applyTargetKeeps(
  tablesIn: ConfigSnapshot['tables'],
  keeps: readonly EnvKeepEntry[],
  live: ConfigSnapshot['tables']
): Prepared {
  const refused: Prepared['refused'] = []
  const kept: KeptNote[] = []
  const held: HeldRow[] = []
  const switched: Prepared['switched_off'] = []
  const whole = new Map<string, EnvKeepEntry>()
  const columnKeeps = new Map<string, EnvKeepEntry[]>()
  for (const k of keeps) {
    if (k.kind === 'table' || k.kind === 'rows' || k.kind === 'delegate') {
      for (const t of [k.table, ...(k.kind === 'delegate' ? (k.tables ?? []) : [])])
        if (!whole.has(t)) whole.set(t, k)
    } else if (k.kind === 'columns')
      columnKeeps.set(k.table, [...(columnKeeps.get(k.table) ?? []), k])
  }
  const tables: ConfigSnapshot['tables'] = {}
  for (const [table, rows] of Object.entries(tablesIn)) {
    const w = whole.get(table)
    if (w) {
      refused.push({ table, reason: `This environment keeps its own: ${w.label}` })
      continue
    }
    const entries = columnKeeps.get(table) ?? []
    const keptCols = new Set<string>()
    for (const e of entries) {
      if (e.id === FLOW_OPS_KEEP) continue
      for (const c of e.columns ?? []) keptCols.add(c)
    }
    if (keptCols.size || entries.some((e) => e.id === FLOW_OPS_KEEP))
      kept.push({
        table,
        label: entries.map((e) => e.label).join('; '),
        columns: [
          ...keptCols,
          ...(entries.some((e) => e.id === FLOW_OPS_KEEP) ? ['options (outbound part)'] : [])
        ]
      })
    if (!keptCols.size) {
      tables[table] = rows
      continue
    }
    const here = live[table] ?? {}
    const out: Record<string, SnapshotRow> = {}
    for (const [key, row] of Object.entries(rows)) {
      const isNew = !here[key]
      const data: Record<string, unknown> = {}
      for (const [c, v] of Object.entries(row.data)) if (!keptCols.has(c)) data[c] = v
      if (isNew) {
        const blocking = [...keptCols].filter(
          (c) => row.data[c] !== undefined && !switchOff(table, c)
        )
        if (blocking.length) {
          held.push({
            table,
            key,
            label: rowLabel(row.data),
            reason: `New here; set ${blocking.join(', ')} on this environment first (they are not copied)`
          })
          continue
        }
        let off = false
        for (const c of keptCols) {
          const sw = switchOff(table, c)
          if (sw && row.data[c] !== undefined) {
            data[c] = sw.value
            off = true
          }
        }
        if (off) switched.push({ table, key, label: rowLabel(row.data) })
      }
      out[key] = rehash(data)
    }
    tables[table] = out
  }
  return { tables, refused, kept, held, switched_off: switched, needs_setup: [] }
}

/**
 * Flow steps and triggers (see the header). `stripped` = per TARGET step id, the outbound keys the
 * source took off; `live` = the target's rows. Mutates and answers `p`. Pure.
 */
export function applyFlowKeeps(
  p: Prepared,
  live: ConfigSnapshot['tables'],
  stripped: Record<string, string[]>,
  o: { sessionSecret: string; runKey: string }
): Prepared {
  const flows = p.tables[FLOWS]
  const ops = p.tables[FLOW_OPS]
  const liveFlows = live[FLOWS] ?? {}
  const liveOps = live[FLOW_OPS] ?? {}
  const offFlows = new Map<string, string>()
  const flowName = (id: unknown) => {
    const k = String(id ?? '')
    const d = flows?.[k]?.data ?? liveFlows[k]?.data
    return typeof d?.name === 'string' ? d.name : null
  }
  if (ops)
    for (const [key, row] of Object.entries(ops)) {
      const own = liveOps[key]?.data
      const data = { ...row.data }
      if ('options' in data) data.options = mergeOwn(data.options, own?.options, stepTop)
      const top = (stripped[key] ?? []).filter((k) => !k.includes('.') && !k.startsWith('('))
      const ownTop = parseJsonObject(own?.options) ?? {}
      const missing = top.filter((k) => !(k in ownTop))
      if (missing.length) {
        const flowId = String(data.flow ?? '')
        const step = typeof data.name === 'string' ? data.name : String(data.key ?? key)
        p.needs_setup.push({
          flow: flowName(flowId),
          step,
          reason: `Set ${missing.join(', ')} for this step on this environment, then switch the flow on`
        })
        offFlows.set(flowId, step)
      }
      ops[key] = rehash(data)
    }
  if (flows)
    for (const [key, row] of Object.entries(flows)) {
      const own = liveFlows[key]?.data
      const data = { ...row.data }
      const becomesWebhook =
        data.trigger === 'webhook' && (!own || String(own.trigger ?? '') !== 'webhook')
      if (becomesWebhook) {
        const base = parseJsonObject(data.trigger_options) ?? {}
        const auth = newInboundAuth(o.sessionSecret, o.runKey, String(data.name ?? key))
        data.trigger_options = JSON.stringify({ ...base, ...auth })
        if (own) offFlows.set(key, offFlows.get(key) ?? 'its webhook trigger')
        p.needs_setup.push({
          flow: typeof data.name === 'string' ? data.name : null,
          step: null,
          reason: `${own ? 'This flow becomes a webhook here' : 'A webhook flow new here'}: it gets bearer auth with a new secret (read it on the flow page and give it to the caller), then switch it on`
        })
      } else if ('trigger_options' in data)
        data.trigger_options = mergeOwn(data.trigger_options, own?.trigger_options, triggerTop)
      if (offFlows.has(key)) data.status = 'inactive'
      flows[key] = rehash(data)
    }
  // A step that needs setup in a flow the promotion does not carry: switch that flow off too.
  for (const flowId of offFlows.keys()) {
    if (flows?.[flowId] || !liveFlows[flowId]) continue
    const data = { ...liveFlows[flowId].data, status: 'inactive' }
    p.tables[FLOWS] = { ...(p.tables[FLOWS] ?? {}), [flowId]: rehash(data) }
  }
  return p
}
