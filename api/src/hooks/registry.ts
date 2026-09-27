import type { FastifyRequest } from 'fastify'
import type { Database } from '../db/index.js'
import { span } from '../services/request-trace.js'
import type { User } from '../types.js'

export type HookAction = 'create' | 'update' | 'delete' | 'read'
export type HookTiming = 'before' | 'after'

export interface HookContext {
  collection: string
  action: HookAction
  keys?: Array<string | number>
  payload?: Record<string, unknown>
  result?: unknown
  previousData?: Record<string, unknown>
  /** Caller-supplied justification for this write (change-reason config) —
   *  stored on the activity row, never written to a column. */
  changeReason?: string
  user?: User
  database: Database
  req?: FastifyRequest
}

type HookFn = (ctx: HookContext) => void | Promise<void>

interface HookEntry {
  collection: string | '*'
  action: HookAction | '*'
  fn: HookFn
  extensionId?: string
  disabled?: boolean
  /** The file that registered the hook — most core hooks are unnamed arrows. */
  source?: string
  /** The newest run times in ms, oldest first, capped. */
  times?: number[]
  runs?: number
  errors?: number
}

export interface HookTimingStats {
  timing: HookTiming
  collection: string
  action: string
  owner: string
  name: string | null
  runs: number
  errors: number
  p50_ms: number | null
  p95_ms: number | null
  max_ms: number | null
}

const SAMPLE_CAP = 200

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null
  const i = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))
  return Math.round(sorted[i] * 10) / 10
}

/** The registering file, plus the function's own name when it has a telling one. */
function labelOf(e: HookEntry): string | null {
  const fn = e.fn.name && e.fn.name !== 'handler' && e.fn.name !== 'anonymous' ? e.fn.name : ''
  if (e.source) return fn ? `${e.source}:${fn}` : e.source
  return fn || null
}

function statsOf(timing: HookTiming, e: HookEntry): HookTimingStats {
  const sorted = [...(e.times ?? [])].sort((x, y) => x - y)
  return {
    timing,
    collection: e.collection,
    action: e.action,
    owner: e.extensionId ?? 'core',
    name: labelOf(e),
    runs: e.runs ?? 0,
    errors: e.errors ?? 0,
    p50_ms: percentile(sorted, 50),
    p95_ms: percentile(sorted, 95),
    max_ms: sorted.length ? Math.round(sorted[sorted.length - 1] * 10) / 10 : null
  }
}

/** The file that called `hooks.before/after`, from the stack. Boot-time only. */
function callerFile(): string | undefined {
  const lines = (new Error().stack ?? '').split('\n').slice(1)
  for (const line of lines) {
    if (line.includes('hooks/registry')) continue
    const m = /([\w.-]+?)\.(?:ts|js|mjs)(?::\d+){1,2}\)?\s*$/.exec(line.trim())
    if (m) return m[1]
  }
  return undefined
}

function record(entry: HookEntry, ms: number, failed: boolean): void {
  const times = entry.times ?? []
  entry.times = times
  times.push(ms)
  if (times.length > SAMPLE_CAP) times.shift()
  entry.runs = (entry.runs ?? 0) + 1
  if (failed) entry.errors = (entry.errors ?? 0) + 1
}

class HookRegistry {
  private beforeHooks: HookEntry[] = []
  private afterHooks: HookEntry[] = []

  before(
    collection: string | '*',
    action: HookAction | '*',
    fn: HookFn,
    opts?: { extensionId?: string }
  ) {
    this.beforeHooks.push({
      collection,
      action,
      fn,
      extensionId: opts?.extensionId,
      source: callerFile()
    })
  }

  after(
    collection: string | '*',
    action: HookAction | '*',
    fn: HookFn,
    opts?: { extensionId?: string }
  ) {
    this.afterHooks.push({
      collection,
      action,
      fn,
      extensionId: opts?.extensionId,
      source: callerFile()
    })
  }

  setExtensionEnabled(extensionId: string, enabled: boolean) {
    for (const entry of [...this.beforeHooks, ...this.afterHooks]) {
      if (entry.extensionId === extensionId) {
        entry.disabled = !enabled
      }
    }
  }

  /** #40 — what an extension registered, for the registry page. */
  listForExtension(
    extensionId: string
  ): Array<{ timing: HookTiming; collection: string; action: string; disabled: boolean }> {
    const out: Array<{
      timing: HookTiming
      collection: string
      action: string
      disabled: boolean
    }> = []
    for (const e of this.beforeHooks)
      if (e.extensionId === extensionId)
        out.push({
          timing: 'before',
          collection: e.collection,
          action: e.action,
          disabled: !!e.disabled
        })
    for (const e of this.afterHooks)
      if (e.extensionId === extensionId)
        out.push({
          timing: 'after',
          collection: e.collection,
          action: e.action,
          disabled: !!e.disabled
        })
    return out
  }

  /** How long each hook takes, since this process started. `owner` = an
   *  extension id, 'core', or undefined for every hook. */
  timings(owner?: string): HookTimingStats[] {
    const out: HookTimingStats[] = []
    for (const [timing, list] of [
      ['before', this.beforeHooks],
      ['after', this.afterHooks]
    ] as Array<[HookTiming, HookEntry[]]>)
      for (const e of list) {
        const s = statsOf(timing, e)
        if (owner === undefined || s.owner === owner) out.push(s)
      }
    return out
  }

  removeExtensionHooks(extensionId: string) {
    this.beforeHooks = this.beforeHooks.filter((e) => e.extensionId !== extensionId)
    this.afterHooks = this.afterHooks.filter((e) => e.extensionId !== extensionId)
  }

  async trigger(timing: HookTiming, ctx: HookContext) {
    // Hook firehose (#283): dev observability — a payload PEEK (key names,
    // never values) streams to watchers of the firehose room. Zero cost when
    // nobody watches (membership checked inside emitFirehose).
    void import('../services/flow-executor.js')
      .then(({ emitFirehose }) =>
        emitFirehose('hook', {
          timing,
          collection: ctx.collection,
          action: ctx.action,
          payload_keys: Object.keys(ctx.payload ?? {}).slice(0, 30)
        })
      )
      .catch(() => {})
    const list = timing === 'before' ? this.beforeHooks : this.afterHooks
    for (const entry of list) {
      if (entry.disabled) continue
      const collectionMatch = entry.collection === '*' || entry.collection === ctx.collection
      const actionMatch = entry.action === '*' || entry.action === ctx.action
      if (!collectionMatch || !actionMatch) continue
      const started = performance.now()
      try {
        // Named in the request trace, so a slow write says which hook cost it.
        await span(
          `hook:${entry.extensionId ?? entry.source ?? 'core'}:${ctx.collection}:${ctx.action}:${timing}`,
          async () => {
            await entry.fn(ctx)
          },
          labelOf(entry) ?? undefined
        )
        record(entry, performance.now() - started, false)
      } catch (err) {
        record(entry, performance.now() - started, true)
        // Before-hooks may intentionally block the operation by throwing an
        // error that carries an HTTP statusCode (e.g. AI validation 422).
        // Such errors propagate to the caller; everything else stays non-fatal.
        if (
          timing === 'before' &&
          typeof (err as { statusCode?: unknown })?.statusCode === 'number'
        ) {
          throw err
        }
        console.error({ err, timing, collection: ctx.collection, action: ctx.action }, 'Hook error')
      }
    }
  }
}

export const hooks = new HookRegistry()
