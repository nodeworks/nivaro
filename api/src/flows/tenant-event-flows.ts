import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import type { HookAction, HookContext, HookTiming } from '../hooks/registry.js'
import { hooks } from '../hooks/registry.js'
import { registerAppKeyed } from '../services/app-forget.js'
import { executeFlow } from '../services/flow-executor.js'
import { currentTenantKey } from '../services/tenant-rooms.js'
import { deferEffect } from '../services/unit-of-work.js'

/**
 * Event flows (trigger = 'event') per app on a Hub shared deployment (Hub phase 6, Task 13).
 *
 * Self-hosted, each active event flow is a hook of its own in the process-wide hook registry
 * (routes/flows.ts registerEventFlowHook). On a shared deployment one process serves many apps,
 * so a hook per flow would fire app A's flow on app B's writes. Here ONE before-hook and ONE
 * after-hook dispatch: on a record write they load the CURRENT app's active event flows (its own
 * database, through the tenant context), cached per app for 30 s, and run the ones that match.
 * A flow saved in an app busts that app's cache only (forgetTenantEventFlows). Outside an app
 * (no tenant) nothing runs.
 */

export interface EventFlowRow {
  id: string
  name: string
  trigger_options: string | null
}

interface EventTriggerOptions {
  timing?: HookTiming
  types?: string[]
  collections?: string[]
  return_payload?: boolean
}

export interface EventFlowSpec {
  flow: EventFlowRow
  timing: HookTiming
  actions: HookAction[]
  /** ['*'] = every collection. */
  collections: string[]
  /** A before-flow whose run result is merged back into the payload. */
  returnPayload: boolean
}

const ITEM_ACTIONS: HookAction[] = ['create', 'update', 'delete']

/** What an event flow listens to, from its trigger options. Throws on unreadable options. */
export function eventFlowSpec(flow: EventFlowRow): EventFlowSpec {
  const opts = flow.trigger_options ? (JSON.parse(flow.trigger_options) as EventTriggerOptions) : {}
  const timing: HookTiming = opts.timing ?? 'after'
  const rawTypes = (opts.types ?? []).filter((t) =>
    ITEM_ACTIONS.includes(t as HookAction)
  ) as HookAction[]
  return {
    flow,
    timing,
    actions: rawTypes.length ? rawTypes : ITEM_ACTIONS,
    collections: (opts.collections ?? []).length ? (opts.collections as string[]) : ['*'],
    returnPayload: timing === 'before' && (opts.return_payload ?? false)
  }
}

/** Whether a flow listens to this write. */
export function eventFlowMatches(spec: EventFlowSpec, timing: HookTiming, ctx: HookContext) {
  return (
    spec.timing === timing &&
    spec.actions.includes(ctx.action) &&
    (spec.collections.includes('*') || spec.collections.includes(ctx.collection))
  )
}

/** Run one event flow for one write — the body every event-flow hook shares. */
export async function runEventFlow(
  app: FastifyInstance,
  spec: EventFlowSpec,
  action: HookAction,
  ctx: HookContext
): Promise<void> {
  const { flow, timing, returnPayload } = spec
  // A rehearsed write runs only the flows that shape its payload, with their sending operations
  // in dry-run mode.
  if (ctx.dryRun && !returnPayload) return
  const execCtx = {
    flowId: flow.id,
    flowName: flow.name,
    trigger: `${timing}:${action}`,
    payload: {
      collection: ctx.collection,
      action: ctx.action,
      keys: ctx.keys ?? [],
      payload: ctx.payload ?? {},
      previousData: ctx.previousData ?? {}
    },
    log: app.log,
    userId: ctx.user?.id,
    ...(ctx.dryRun ? { dryRun: true } : {}),
    // The write waits for this run (review N7: a script step then waits ≤ 10 s, never minutes).
    ...(returnPayload ? { blocking: true } : {})
  }
  if (returnPayload) {
    try {
      const result = await executeFlow(execCtx)
      // Merge exec-script's returned payload back into ctx so the items service writes it
      if (ctx.payload && result?.payload && typeof result.payload === 'object') {
        Object.assign(ctx.payload, result.payload as Record<string, unknown>)
      }
    } catch (err) {
      // No slot for its script step in time: refuse the write (503 FLOW_SCRIPT_BUSY), never save
      // a payload the flow did not get to shape.
      if ((err as { code?: unknown } | null)?.code === 'FLOW_SCRIPT_BUSY') throw err
      app.log.error({ err, flowId: flow.id }, 'Before-event flow failed')
    }
    return
  }
  // "After — async, post-save processing": the writer never waits for the run. Inside a
  // create's unit of work it still starts only once the whole create has landed (and is dropped
  // when it is undone), but the create answers without it. The run records itself
  // (nivaro_flow_runs, its partner obligation, dead letters), so nothing is lost by not waiting.
  void deferEffect(
    `event-flow:${flow.id}`,
    () =>
      executeFlow(execCtx).catch((err) =>
        app.log.error({ err, flowId: flow.id }, 'Event flow execution failed')
      ),
    { detached: true }
  )
}

// ─── Per-app cache ───────────────────────────────────────────────────────────

const CACHE_TTL_MS = 30_000
const cache = registerAppKeyed(new Map<string, { at: number; specs: Promise<EventFlowSpec[]> }>())
let started: FastifyInstance | null = null

async function loadSpecs(log: FastifyInstance['log'] | null): Promise<EventFlowSpec[]> {
  const rows = (await db('nivaro_flows').where({ trigger: 'event', status: 'active' })) as
    | EventFlowRow[]
    | undefined
  const out: EventFlowSpec[] = []
  for (const row of Array.isArray(rows) ? rows : []) {
    try {
      out.push(eventFlowSpec(row))
    } catch (err) {
      log?.error({ err, flowId: row.id }, 'Event flow options unreadable, skipped')
    }
  }
  return out
}

/** The current app's active event flows (30 s per app). Empty outside an app. */
export function tenantEventFlows(): Promise<EventFlowSpec[]> {
  const key = currentTenantKey()
  if (!key) return Promise.resolve([])
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.specs
  const entry = { at: Date.now(), specs: Promise.resolve([] as EventFlowSpec[]) }
  entry.specs = loadSpecs(started?.log ?? null).catch((err) => {
    // A failed read is not remembered: the next write asks again.
    if (cache.get(key) === entry) cache.delete(key)
    started?.log.error({ err }, 'Event flows could not be read for this app')
    return [] as EventFlowSpec[]
  })
  cache.set(key, entry)
  return entry.specs
}

/** Drop one app's cached event flows (a flow was saved there), or every app's. */
export function forgetTenantEventFlows(tenantId?: string): void {
  if (tenantId === undefined) cache.clear()
  else cache.delete(tenantId)
}

/** Apps whose event flows are cached now (tests, diagnostics). */
export function cachedEventFlowTenants(): string[] {
  return [...cache.keys()]
}

/**
 * Start the per-app dispatcher: one before-hook and one after-hook on every collection.
 * Idempotent (a second call does nothing).
 */
export function startTenantEventFlows(app: FastifyInstance): void {
  if (started) return
  started = app
  for (const timing of ['before', 'after'] as const) {
    const dispatch = async (ctx: HookContext) => {
      if (!currentTenantKey()) return
      if (!ITEM_ACTIONS.includes(ctx.action)) return
      const specs = await tenantEventFlows()
      for (const spec of specs) {
        if (!eventFlowMatches(spec, timing, ctx)) continue
        await runEventFlow(app, spec, ctx.action, ctx)
      }
    }
    if (timing === 'before') hooks.before('*', '*', dispatch)
    else hooks.after('*', '*', dispatch)
  }
  app.log.info('Event flows: per-app dispatcher started (shared deployment)')
}
