import { db } from '../db/index.js'
import { currentTenantKey } from '../services/tenant-rooms.js'
import { deferEffect } from '../services/unit-of-work.js'
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

// Both caches are per app: a Hub shared-deployment process serves many apps (Hub phase 6).
type ChildWatch = { fk: string; parents: Set<string> }
type AutoState = {
  bound: { set: Set<string>; loadedAt: number } | null
  childWatch: { map: Map<string, ChildWatch[]>; loadedAt: number } | null
}
const autoStates = new Map<string, AutoState>()
function autoState(): AutoState {
  const key = currentTenantKey()
  let st = autoStates.get(key)
  if (!st) {
    st = { bound: null, childWatch: null }
    autoStates.set(key, st)
  }
  return st
}

async function boundCollections(): Promise<Set<string>> {
  const st = autoState()
  if (st.bound && Date.now() - st.bound.loadedAt < 60_000) {
    return st.bound.set
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
  st.bound = { set, loadedAt: Date.now() }
  return set
}

// child collection → [{ fk (column on the child pointing at the parent), parent collections }]
const RELATED_FIELD_RE = /^([A-Za-z_][A-Za-z0-9_]*):([A-Za-z_][A-Za-z0-9_]*)$/
const RELATED_OPS = new Set([
  'related_some',
  'related_none',
  'children_in_state',
  'children_not_in_state'
])

/** Drop the cached bindings and child watches (pipeline config changed): the current app's,
 *  or every app's when called outside one (a cache reset, another process's config change). */
export function bustWorkflowAutoCaches(): void {
  const key = currentTenantKey()
  if (key) autoStates.delete(key)
  else autoStates.clear()
}

async function childWatches(): Promise<Map<string, ChildWatch[]>> {
  const st = autoState()
  if (st.childWatch && Date.now() - st.childWatch.loadedAt < 60_000) {
    return st.childWatch.map
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
  st.childWatch = { map, loadedAt: Date.now() }
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
      void deferEffect('auto-transitions', () => runAutoTransitions(ctx.collection, item))
    }
    // Child-row write → re-evaluate the parent(s) it points at. previousData
    // covers deletes and FK moves (old parent may now satisfy related_none).
    const watches = (await childWatches()).get(ctx.collection)
    if (!watches) return
    for (const w of watches) {
      for (const parentId of fkValues(ctx, w.fk)) {
        for (const parent of w.parents)
          void deferEffect('auto-transitions:parent', () => runAutoTransitions(parent, parentId))
      }
    }
  }
  hooks.after('*', 'create', handler)
  hooks.after('*', 'update', handler)
  hooks.after('*', 'delete', handler)
}
