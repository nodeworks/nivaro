import { db } from '../db/index.js'
import { parseConditionRules } from '../services/workflow-conditions.js'
import { runAutoTransitions } from '../services/workflow-transitions.js'
import { hooks } from './registry.js'

// ─── Auto-transition hooks ───────────────────────────────────────────────────
// After any create/update on a workflow-bound collection, re-evaluate
// auto_trigger transitions for that item (condition rules may now pass —
// e.g. a schedule date edit bringing a record inside a within_days window).
//
// Auto transitions whose condition rules look at RELATED rows
// ('<child>:<fk>' related_some / related_none / children_*_state) are also
// re-evaluated when one of those child rows is written — a PO junction row
// landing on a workflow is the canonical case. The child → parent map is
// derived from the rules themselves, so new config needs no code.
//
// The hourly sweep in server.ts covers conditions that flip purely by time.

let boundCollectionsCache: { set: Set<string>; loadedAt: number } | null = null

async function boundCollections(): Promise<Set<string>> {
  if (boundCollectionsCache && Date.now() - boundCollectionsCache.loadedAt < 60_000) {
    return boundCollectionsCache.set
  }
  const set = new Set<string>()
  try {
    const rows = (await db('nivaro_workflow_bindings').select('collection')) as Array<{
      collection: string
    }>
    for (const r of rows) set.add(r.collection)
  } catch {
    /* table missing pre-migration */
  }
  boundCollectionsCache = { set, loadedAt: Date.now() }
  return set
}

// child collection → [{ fk (column on the child pointing at the parent), parent collections }]
type ChildWatch = { fk: string; parents: Set<string> }
const RELATED_FIELD_RE = /^([A-Za-z_][A-Za-z0-9_]*):([A-Za-z_][A-Za-z0-9_]*)$/
const RELATED_OPS = new Set([
  'related_some',
  'related_none',
  'children_in_state',
  'children_not_in_state'
])
let childWatchCache: { map: Map<string, ChildWatch[]>; loadedAt: number } | null = null

export function bustWorkflowAutoCaches(): void {
  boundCollectionsCache = null
  childWatchCache = null
}

async function childWatches(): Promise<Map<string, ChildWatch[]>> {
  if (childWatchCache && Date.now() - childWatchCache.loadedAt < 60_000) {
    return childWatchCache.map
  }
  const map = new Map<string, ChildWatch[]>()
  try {
    const rows = (await db('nivaro_workflow_transitions as t')
      .join('nivaro_workflow_bindings as b', 'b.template', 't.template')
      .where('t.auto_trigger', true)
      .whereNotNull('t.condition_rules')
      .select('t.condition_rules', 'b.collection')) as Array<{
      condition_rules: string | null
      collection: string
    }>
    for (const row of rows) {
      for (const rule of parseConditionRules(row.condition_rules) ?? []) {
        if (!rule || !RELATED_OPS.has(rule.op) || typeof rule.field !== 'string') continue
        const m = RELATED_FIELD_RE.exec(rule.field)
        if (!m) continue
        const [, child, fk] = m
        if (/^nivaro_/i.test(child)) continue
        const list = map.get(child) ?? []
        let entry = list.find((w) => w.fk === fk)
        if (!entry) {
          entry = { fk, parents: new Set() }
          list.push(entry)
        }
        entry.parents.add(row.collection)
        map.set(child, list)
      }
    }
  } catch {
    /* tables missing pre-migration */
  }
  childWatchCache = { map, loadedAt: Date.now() }
  return map
}

function fkValues(
  ctx: {
    payload?: Record<string, unknown>
    result?: unknown
    previousData?: Record<string, unknown>
  },
  fk: string
): string[] {
  const out = new Set<string>()
  const result = ctx.result as Record<string, unknown> | undefined
  for (const src of [result, ctx.payload, ctx.previousData]) {
    const v = src?.[fk]
    if (v !== null && v !== undefined && v !== '') out.add(String(v))
  }
  return [...out]
}

export function registerWorkflowAutoHooks(): void {
  const handler = async (ctx: {
    collection: string
    keys?: unknown[]
    payload?: Record<string, unknown>
    result?: unknown
    previousData?: Record<string, unknown>
  }) => {
    if (ctx.collection.startsWith('nivaro_')) return
    const item = ctx.keys?.[0] != null ? String(ctx.keys[0]) : null
    const bound = await boundCollections()
    if (item && bound.has(ctx.collection)) {
      // Fire-and-forget: automation must never fail or slow the write
      void runAutoTransitions(ctx.collection, item)
    }
    // Child-row write → re-evaluate the parent(s) it points at. previousData
    // covers deletes and FK moves (old parent may now satisfy related_none).
    const watches = (await childWatches()).get(ctx.collection)
    if (!watches) return
    for (const w of watches) {
      for (const parentId of fkValues(ctx, w.fk)) {
        for (const parent of w.parents) void runAutoTransitions(parent, parentId)
      }
    }
  }
  hooks.after('*', 'create', handler)
  hooks.after('*', 'update', handler)
  hooks.after('*', 'delete', handler)
}
