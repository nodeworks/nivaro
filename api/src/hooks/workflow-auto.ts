import { db } from '../db/index.js'
import { runAutoTransitions } from '../services/workflow-transitions.js'
import { hooks } from './registry.js'

// ─── Auto-transition hooks ───────────────────────────────────────────────────
// After any create/update on a workflow-bound collection, re-evaluate
// auto_trigger transitions for that item (condition rules may now pass —
// e.g. a schedule date edit bringing a record inside a within_days window).
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

export function registerWorkflowAutoHooks(): void {
  const handler = async (ctx: { collection: string; keys?: unknown[] }) => {
    if (ctx.collection.startsWith('nivaro_')) return
    const item = ctx.keys?.[0] != null ? String(ctx.keys[0]) : null
    if (!item) return
    const bound = await boundCollections()
    if (!bound.has(ctx.collection)) return
    // Fire-and-forget: automation must never fail or slow the write
    void runAutoTransitions(ctx.collection, item)
  }
  hooks.after('*', 'create', handler)
  hooks.after('*', 'update', handler)
}
