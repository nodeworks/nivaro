/**
 * Environment refresh — each environment keeps its own outbound settings INSIDE flow steps (Rob,
 * 2026-11-16): a webhook step's URL, headers and secrets, an external-API step's path override,
 * any URL/endpoint/secret-looking option. Matched by flow name + step key (the step name when the
 * key is empty), for flows that exist on both sides. Everything else in the step's options (body,
 * conditions, templates) follows the source.
 *
 * Saved rows: `{flow_name, key, fields, outbound}` — `fields` names the kept options (shown on the
 * plan), `outbound` is their JSON (masked on the plan). On apply, a matched step loses EVERY
 * outbound option the source brought and gets the target's back, so a source secret never stays
 * on the target. Steps only the source has are reported (`new_from_source`); the safety pass
 * switches off flows the target never had that call out.
 */
import { SECRET_NAME_RE } from '../secret-columns.js'
import {
  type ApplyResult,
  keyOf,
  qtable,
  type SavedEntry,
  type SqlRunner,
  sqlError
} from './keep-set.js'

export const FLOW_OPS_ID = 'core:flow-op-endpoints'

/** Option keys that address or authenticate something outside the instance. */
export function isOutboundOptionKey(k: string): boolean {
  if (/^(url|urls|endpoint|base_url|path_override|headers|auth|auth_config|webhook)$/i.test(k))
    return true
  if (/(^|_)(url|urls|endpoint|webhook|host)$/i.test(k)) return true
  return SECRET_NAME_RE.test(k)
}

function parseOptions(v: unknown): Record<string, unknown> | null {
  if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>
  if (typeof v !== 'string' || !v.trim()) return null
  try {
    const o = JSON.parse(v)
    return o && typeof o === 'object' && !Array.isArray(o) ? o : null
  } catch {
    return null
  }
}

/** Pure: the outbound part of a step's options (null when there is none). */
export function outboundPart(options: unknown): Record<string, unknown> | null {
  const o = parseOptions(options)
  if (!o) return null
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(o)) if (isOutboundOptionKey(k)) out[k] = v
  return Object.keys(out).length ? out : null
}

/** Pure: the source step's options with its outbound part replaced by the target's. */
export function mergeOutbound(
  sourceOptions: unknown,
  targetOutbound: Record<string, unknown>
): string {
  const o = parseOptions(sourceOptions) ?? {}
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(o)) if (!isOutboundOptionKey(k)) out[k] = v
  return JSON.stringify({ ...out, ...targetOutbound })
}

const stepKey = (r: Record<string, unknown>) => {
  const k = typeof r.op_key === 'string' && r.op_key.trim() ? r.op_key : r.op_name
  return String(k ?? '')
}

async function readSteps(sql: SqlRunner, db: string) {
  return sql.raw(
    `SELECT o.[id] AS id, f.[name] AS flow_name, o.[key] AS op_key, o.[name] AS op_name, o.[options] AS options
       FROM ${qtable(db, 'nivaro_flow_operations')} o
       JOIN ${qtable(db, 'nivaro_flows')} f ON f.[id] = o.[flow]`
  )
}

/** Reads the target's outbound step options (SELECT only). */
export async function captureFlowOps(
  sql: SqlRunner,
  db: string,
  base: SavedEntry
): Promise<SavedEntry> {
  const rows: Array<Record<string, unknown>> = []
  for (const r of await readSteps(sql, db)) {
    const ob = outboundPart(r.options)
    if (!ob) continue
    rows.push({
      flow_name: String(r.flow_name ?? ''),
      key: stepKey(r),
      fields: Object.keys(ob).join(', '),
      outbound: JSON.stringify(ob)
    })
  }
  return {
    ...base,
    kind: 'columns',
    key: ['flow_name', 'key'],
    columns: ['fields', 'outbound'],
    rows,
    total: rows.length
  }
}

/** Writes the target's outbound options back onto the matching steps of the copy. */
export async function applyFlowOps(
  sql: SqlRunner,
  db: string,
  e: SavedEntry,
  r: ApplyResult
): Promise<void> {
  const KEY = ['flow_name', 'key']
  const saved = new Map<string, Record<string, unknown>>()
  const dup = new Set<string>()
  for (const row of e.rows) {
    const k = keyOf(row, KEY)
    if (saved.has(k)) dup.add(k)
    saved.set(k, row)
  }
  const steps: Array<Record<string, unknown>> = (await readSteps(sql, db)).map((s) => ({
    ...s,
    key: stepKey(s)
  }))
  const seen = new Map<string, number>()
  for (const s of steps) seen.set(keyOf(s, KEY), (seen.get(keyOf(s, KEY)) ?? 0) + 1)
  const matched = new Set<string>()
  for (const s of steps) {
    const k = keyOf(s, KEY)
    const mine = saved.get(k)
    if (!mine) {
      if (outboundPart(s.options)) r.new_from_source.push(`${s.flow_name} / ${s.key}`)
      continue
    }
    if (dup.has(k) || (seen.get(k) ?? 0) > 1) continue
    matched.add(k)
    let ob: Record<string, unknown>
    try {
      ob = JSON.parse(String(mine.outbound))
    } catch {
      r.errors.push(`${s.flow_name} / ${s.key}: the saved options could not be read`)
      continue
    }
    try {
      await sql.raw(
        `UPDATE ${qtable(db, 'nivaro_flow_operations')} SET [options] = ? WHERE [id] = ?`,
        [mergeOutbound(s.options, ob), s.id]
      )
      r.written++
    } catch (err) {
      if (r.errors.length < 20) r.errors.push(sqlError(err))
    }
  }
  r.skipped = e.rows.filter((row) => !matched.has(keyOf(row, KEY))).length
  const ambiguous = [...seen].filter(([k, n]) => n > 1 && saved.has(k)).length + dup.size
  if (ambiguous)
    r.notes.push(
      `${ambiguous} flow step(s) are not unique by flow + key — left as the source has them`
    )
}
