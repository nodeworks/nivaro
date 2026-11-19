/**
 * Ready-to-send board (idea 37): every OPEN record whose next manual move would push to a
 * partner, checked the way the record's own Push readiness chip checks one record
 * (integration-preview `preflightTransitionRow`), so problems are fixed before someone presses
 * the button.
 *
 * Batched: records are read per collection in chunks with ONE previewErpActions cache — the
 * record rows, each context lookup and each API's last landed pushes are seeded from set reads
 * (one statement per chunk, capped per record in SQL), and everything that does not depend on
 * the record (the API, its secrets and contract, the template's lookups) is read once for the
 * whole run. What stays per record: a step's requirements dialog check and its condition record
 * (both only when the transition has them) and context lookups keyed on `$record.<field>`.
 *
 * Read-only: nothing is sent, written back, journaled or opened on the obligation ledger. The
 * result is stored in the job's own nivaro_job_runs.progress (no table).
 */
import { db } from '../../db/index.js'
import { collectionLabels } from '../command-center/flow.js'
import { selectInChunks, whereInList } from '../db-batch.js'
import {
  hasPushes,
  type InstanceRow,
  type PreflightIssue,
  type PreflightResult,
  preflightTransitionRow,
  type StateRow,
  type TransitionRow
} from '../integration-preview.js'
import { resolveStateOwnersBatch } from '../pipeline-engine.js'
import { ADDENDUM_COLLECTION } from '../pipeline-subject.js'
import {
  buildContextBatch,
  notConfiguredField,
  parseActions,
  pickLastLanded,
  previewApiId,
  previewContextDefs,
  previewCtxKey,
  previewLastKey,
  previewRecordKey,
  type TransitionActionDef
} from '../workflow-actions.js'
import { fetchRecordForConditions } from '../workflow-conditions.js'
import { resolveFriendlyIds } from '../workflow-transitions.js'
import {
  COMPLETE_PREFIX,
  parseProgress,
  parseResult,
  progressJson,
  READY_JOB_ID,
  type ReadyEntry,
  type ReadyResult,
  serializeResult,
  summarizeResult,
  worstOf
} from './board.js'
import { forgetChunkReads, memoDb } from './memo-db.js'

/** Records read together per collection (one chunk = one set of set-reads, then dropped). */
export const READY_CHUNK = 100
/** The job's watchdog: a run checks every open record, however long that takes, up to this. */
export const READY_WATCHDOG_MS = 6 * 3_600_000
/** A run row still 'running' after this long was cut short (deploy, restart, watchdog). */
export const READY_STALE_MS = READY_WATCHDOG_MS + 2 * 3_600_000
/** Line rows kept per issue on a stored entry (the record page lists them all). */
const ROWS_PER_ISSUE = 10

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/
const truthy = (v: unknown) => v === true || v === 1 || v === '1'

export interface Candidate {
  collection: string
  item: string
  instance: InstanceRow & { collection: string; item: string }
  transitions: TransitionRow[]
}

export interface Catalog {
  transitionsByTemplate: Map<string, TransitionRow[]>
  stateById: Map<string, StateRow>
}

const TRANSITION_COLS = [
  'id',
  'label',
  'from_state',
  'to_state',
  'actions',
  'auto_trigger',
  'condition_rules',
  'requirements',
  'sort',
  'template'
]

/** Manual transitions (people press them) that carry at least one partner push. */
async function loadCatalog(): Promise<Catalog> {
  const rows = (await db('nivaro_workflow_transitions')
    .where('actions', 'like', '%erp_submit%')
    .orderBy('sort')
    .select(TRANSITION_COLS)) as Array<TransitionRow & { template: string }>
  const transitionsByTemplate = new Map<string, TransitionRow[]>()
  for (const t of rows) {
    if (truthy(t.auto_trigger) || !hasPushes(t.actions)) continue
    const k = String(t.template).toUpperCase()
    transitionsByTemplate.set(k, [...(transitionsByTemplate.get(k) ?? []), t])
  }
  const templates = [...transitionsByTemplate.keys()]
  const states = (await selectInChunks(templates, 1000, (chunk) =>
    whereInList(db('nivaro_workflow_states'), 'template', chunk).select(
      'id',
      'key',
      'label',
      'external_label'
    )
  )) as StateRow[]
  return {
    transitionsByTemplate,
    stateById: new Map(states.map((s) => [String(s.id).toUpperCase(), s]))
  }
}

/** Pure: the candidate transitions out of a record's current state. */
export function movesFrom(
  transitions: TransitionRow[],
  currentState: string | null
): TransitionRow[] {
  const cur = String(currentState ?? '').toUpperCase()
  return transitions.filter(
    (t) => t.from_state == null || String(t.from_state).toUpperCase() === cur
  )
}

/** Open records whose next manual move pushes: newest instance per record, newest first. */
export async function findCandidates(
  catalog: Catalog,
  only?: { collection: string; item: string }
): Promise<Candidate[]> {
  const templates = [...catalog.transitionsByTemplate.keys()]
  if (templates.length === 0) return []
  const anyFrom = templates.filter((tpl) =>
    (catalog.transitionsByTemplate.get(tpl) ?? []).some((t) => t.from_state == null)
  )
  const fromStates = [
    ...new Set(
      templates.flatMap((tpl) =>
        (catalog.transitionsByTemplate.get(tpl) ?? [])
          .filter((t) => t.from_state != null)
          .map((t) => String(t.from_state))
      )
    )
  ]
  const cols = [
    'id',
    'template',
    'collection',
    'item',
    'current_state',
    'completed_at',
    'started_at'
  ]
  const scoped = (q: ReturnType<typeof db>) =>
    only ? q.where({ collection: only.collection, item: String(only.item) }) : q
  const reads: Array<Promise<unknown[]>> = []
  if (anyFrom.length > 0)
    reads.push(
      selectInChunks(anyFrom, 1000, (chunk) =>
        whereInList(scoped(db('nivaro_workflow_instances')), 'template', chunk)
          .whereNull('completed_at')
          .select(cols)
      )
    )
  if (fromStates.length > 0)
    reads.push(
      selectInChunks(fromStates, 1000, (chunk) =>
        whereInList(scoped(db('nivaro_workflow_instances')), 'current_state', chunk)
          .whereNull('completed_at')
          .select(cols)
      )
    )
  const rows = (await Promise.all(reads)).flat() as Array<
    InstanceRow & { collection: string; item: string; started_at: Date | string | null }
  >
  // Newest open instance per record (what the record page's preflight reads).
  const newest = new Map<string, (typeof rows)[number]>()
  for (const r of rows) {
    if (!IDENT.test(String(r.collection)) || r.collection === ADDENDUM_COLLECTION) continue
    const k = `${r.collection}:${String(r.item).toLowerCase()}`
    const prev = newest.get(k)
    if (!prev || new Date(r.started_at ?? 0) > new Date(prev.started_at ?? 0)) newest.set(k, r)
  }
  const out: Candidate[] = []
  for (const inst of newest.values()) {
    const moves = movesFrom(
      catalog.transitionsByTemplate.get(String(inst.template).toUpperCase()) ?? [],
      inst.current_state
    )
    if (moves.length === 0) continue
    out.push({
      collection: inst.collection,
      item: String(inst.item),
      instance: inst,
      transitions: moves
    })
  }
  // Newest records first: a capped run checks what was started most recently.
  const startedAt = (c: Candidate) =>
    new Date((c.instance as { started_at?: Date | string | null }).started_at ?? 0).getTime()
  out.sort((a, b) => startedAt(b) - startedAt(a))
  return out
}

/** A push that can reach its partner from this record: not "not for this record"
 *  (skip_when_empty / skip_unless_any) and not left out by the integration's own send rule. */
const pushReaches = (p: { status: string }) =>
  p.status !== 'not_applicable' && p.status !== 'send_skip'

/**
 * Pure: which of a record's checked moves are its "next send". A move whose pushes are all not
 * for this record (skip_when_empty / skip_unless_any) is not a send move here; when some send
 * moves' conditions hold, a move whose conditions do not is a branch the record is not taking.
 */
export function sendMoves(
  results: Array<{ t: TransitionRow; r: PreflightResult }>
): Array<{ t: TransitionRow; r: PreflightResult }> {
  const sending = results.filter((x) => x.r.pushes.some(pushReaches))
  const open = sending.filter((x) => !x.r.issues.some((i) => i.kind === 'condition'))
  return open.length > 0 ? open : sending
}

/**
 * Pure: an issue as the board shows it. Line rows are capped. A push that waits on a value an
 * earlier push on the same step writes back (the first partner's order number, used by the
 * second) is expected to be empty beforehand: it reads as "asks on send", never as a problem —
 * otherwise every record on such a step would be listed.
 */
export function boardIssue(i: PreflightIssue): PreflightIssue {
  const capped =
    i.rows && i.rows.length > ROWS_PER_ISSUE ? { ...i, rows: i.rows.slice(0, ROWS_PER_ISSUE) } : i
  if (!capped.after_earlier_push || capped.severity === 'ask') return capped
  const guard =
    /^(.+) will not be sent: (.+) is empty \(an earlier push on this step may fill it\)$/.exec(
      capped.message
    )
  return {
    ...capped,
    severity: 'ask',
    message: guard
      ? `${guard[1]} goes once an earlier send on this step fills ${guard[2]}`
      : capped.message
  }
}

/** Seed the cache with set reads for one chunk of one collection's records. */
async function prefetchChunk(
  collection: string,
  chunk: Candidate[],
  cache: Map<string, Promise<unknown>>,
  userId: string | null
): Promise<void> {
  const ids = chunk.map((c) => c.item)
  // 1. The records (select * — the same row previewErpActions reads one at a time).
  let records = new Map<string, Record<string, unknown>>()
  try {
    const rows = (await whereInList(db(collection), 'id', ids).select('*')) as Array<
      Record<string, unknown>
    >
    records = new Map(rows.map((r) => [String(r.id).toUpperCase(), r]))
  } catch {
    /* unreadable: each record reads on its own (and finds the same) */
    return
  }
  const items = chunk.map((c) => ({
    item: c.item,
    record: records.get(c.item.toUpperCase()) ?? ({} as Record<string, unknown>)
  }))
  for (const it of items)
    cache.set(previewRecordKey(collection, it.item), Promise.resolve(it.record))

  // 2. The push actions this chunk's moves carry, resolved once (shared cache).
  const actions: TransitionActionDef[] = []
  const seen = new Set<string>()
  for (const c of chunk)
    for (const t of c.transitions)
      if (!seen.has(t.id)) {
        seen.add(t.id)
        for (const a of parseActions(t.actions)) if (a.type === 'erp_submit') actions.push(a)
      }
  const endpointsByApi = new Map<number, Set<string>>()
  const defsSets = new Map<string, TransitionActionDef['context']>()
  for (const a of actions) {
    const apiId = a.external_api ? await previewApiId(a.external_api, cache) : null
    if (notConfiguredField(a, apiId)) continue
    const set = endpointsByApi.get(apiId as number) ?? new Set<string>()
    set.add(a.endpoint_path)
    endpointsByApi.set(apiId as number, set)
    const defs = await previewContextDefs(a, cache)
    defsSets.set(JSON.stringify(defs ?? {}), defs)
  }

  // 3. Each API's newest landed pushes for every record: one statement per API, 25 per record.
  for (const [apiId, endpoints] of endpointsByApi) {
    try {
      const inner = whereInList(
        db('nivaro_erp_submissions')
          .where({ collection, external_api: apiId })
          .whereIn('status', ['accepted', 'pending']),
        'item',
        ids
      ).select(
        'id',
        'item',
        'status',
        'created_at',
        'payload',
        'change_signature',
        db.raw('ROW_NUMBER() OVER (PARTITION BY item ORDER BY created_at DESC) AS __nvr_rn')
      )
      const rows = (await db
        .select('*')
        .from(inner.as('nvr_last'))
        .where('__nvr_rn', '<=', 25)
        .orderBy('item')
        .orderBy('__nvr_rn')) as Array<{
        id: number
        item: string
        status: string
        created_at: Date | string
        payload: string | null
        change_signature: string | null
      }>
      const byItem = new Map<string, typeof rows>()
      for (const r of rows) {
        const k = String(r.item).toUpperCase()
        byItem.set(k, [...(byItem.get(k) ?? []), r])
      }
      for (const id of ids) {
        const mine = byItem.get(id.toUpperCase()) ?? []
        for (const ep of endpoints)
          cache.set(
            previewLastKey(collection, id, apiId, ep),
            Promise.resolve(pickLastLanded(mine, ep))
          )
      }
    } catch {
      /* history unreadable: each record reads its own */
    }
  }

  // 4. Context lookups: one statement per lookup for the whole chunk where it can be.
  for (const defs of defsSets.values()) {
    try {
      const built = await buildContextBatch(defs, items, userId)
      for (const it of items)
        cache.set(
          previewCtxKey(collection, it.item, defs),
          Promise.resolve(built.get(String(it.item)) ?? {})
        )
    } catch {
      /* each record reads its own */
    }
  }
}

/** Drop the per-record keys once a chunk is done (the shared ones stay for the whole run). */
function forgetRecords(cache: Map<string, Promise<unknown>>): void {
  for (const k of [...cache.keys()])
    if (
      k.startsWith('rec:') ||
      k.startsWith('ctx:') ||
      k.startsWith('last:') ||
      k.startsWith('cond:')
    )
      cache.delete(k)
}

export interface CheckOptions {
  userId: string | null
  /** Probes only: stop after this many records. The nightly run checks every record. */
  maxRecords?: number
  now?: () => number
  /** A person's name for entries from "Check again". */
  checkedBy?: string | null
  /** Records per chunk (tests). */
  chunkSize?: number
  /** Called after every chunk: how far the run is (the job stores it as it goes). */
  onChunk?: (p: { checked: number; total: number; entries: number }) => Promise<void> | void
}

export interface CheckOutcome {
  entries: ReadyEntry[]
  checked: number
  ready: number
  errors: number
}

/** Let the event loop serve requests between chunks. */
const yieldToRequests = () => new Promise<void>((resolve) => setImmediate(resolve))

/**
 * Check candidates collection by collection, chunk by chunk, with one shared cache. Memory stays
 * bounded: a chunk's records, context rows and last pushes are dropped once it is done; what is
 * kept is the compact entries of records with something in the way (issue rows capped at 10).
 */
export async function checkCandidates(
  candidates: Candidate[],
  catalog: Catalog,
  opts: CheckOptions
): Promise<CheckOutcome> {
  const size = Math.max(1, opts.chunkSize ?? READY_CHUNK)
  const cache = new Map<string, Promise<unknown>>()
  // The requirements evaluator's reads, memoized (metadata for the run, the rest per chunk).
  const reads = memoDb(cache)
  const out: CheckOutcome = { entries: [], checked: 0, ready: 0, errors: 0 }
  const todo = candidates.slice(0, opts.maxRecords ?? candidates.length)
  const byCollection = new Map<string, Candidate[]>()
  for (const c of todo) {
    const list = byCollection.get(c.collection)
    if (list) list.push(c)
    else byCollection.set(c.collection, [c])
  }
  for (const [collection, list] of byCollection) {
    for (let i = 0; i < list.length; i += size) {
      const chunk = list.slice(i, i + size)
      await prefetchChunk(collection, chunk, cache, opts.userId)
      const found: Array<{ c: Candidate; t: TransitionRow; r: PreflightResult }> = []
      for (const c of chunk) {
        try {
          const results: Array<{ t: TransitionRow; r: PreflightResult }> = []
          // One condition read per record, over every move's rules (not one per move).
          const ruleSets = c.transitions.map((t) => t.condition_rules).filter(Boolean)
          const conditionRecord =
            ruleSets.length > 0
              ? fetchRecordForConditions(collection, c.item, ruleSets).catch(
                  () => ({}) as Record<string, unknown>
                )
              : undefined
          for (const t of c.transitions) {
            const to = t.to_state
              ? (catalog.stateById.get(String(t.to_state).toUpperCase()) ?? null)
              : null
            results.push({
              t,
              r: await preflightTransitionRow(collection, c.item, t, to, opts.userId, cache, {
                database: reads,
                conditionRecord
              })
            })
          }
          out.checked++
          const moves = sendMoves(results)
          const withIssues = moves.filter((m) => m.r.issues.length > 0)
          if (withIssues.length === 0) out.ready++
          for (const m of withIssues) found.push({ c, t: m.t, r: m.r })
        } catch {
          out.checked++
          out.errors++
        }
      }
      out.entries.push(...(await describe(collection, found, catalog, opts)))
      forgetRecords(cache)
      forgetChunkReads(cache)
      if (opts.onChunk) {
        try {
          await opts.onChunk({
            checked: out.checked,
            total: todo.length,
            entries: out.entries.length
          })
        } catch {
          /* progress bookkeeping never stops the run */
        }
      }
      await yieldToRequests()
    }
  }
  return out
}

/** Labels, current step and its owners for the records with problems (set reads). */
async function describe(
  collection: string,
  found: Array<{ c: Candidate; t: TransitionRow; r: PreflightResult }>,
  catalog: Catalog,
  opts: CheckOptions
): Promise<ReadyEntry[]> {
  if (found.length === 0) return []
  const ids = [...new Set(found.map((f) => f.c.item))]
  const labels = await resolveFriendlyIds(collection, ids).catch(() => new Map<string, string>())
  let owners = new Map<string, Array<{ id: string; name: string }>>()
  try {
    const reqs = [...new Map(found.map((f) => [f.c.item, f.c])).values()]
      .filter((c) => c.instance.current_state)
      .map((c) => ({
        key: c.item,
        stateId: String(c.instance.current_state),
        instanceId: String(c.instance.id),
        collection,
        itemId: c.item
      }))
    const resolved = await resolveStateOwnersBatch(reqs)
    owners = new Map(
      [...resolved.entries()].map(([k, list]) => [
        k,
        list.slice(0, 6).map((o) => ({
          id: String(o.id),
          name: [o.first_name, o.last_name].filter(Boolean).join(' ') || o.email || 'Someone'
        }))
      ])
    )
  } catch {
    /* owners are decoration */
  }
  const at = new Date((opts.now ?? Date.now)()).toISOString()
  return found.map(({ c, t, r }) => {
    const issues = r.issues.map(boardIssue)
    const state = c.instance.current_state
      ? (catalog.stateById.get(String(c.instance.current_state).toUpperCase())?.label ?? null)
      : null
    return {
      collection,
      item: c.item,
      label: labels.get(c.item) ?? c.item,
      state,
      transition: { id: String(t.id), label: t.label },
      partners: [...new Set(r.pushes.filter(pushReaches).map((p) => p.api_name))],
      owners: owners.get(c.item) ?? [],
      issues,
      worst: worstOf(issues) ?? 'ask',
      checked_at: at,
      ...(opts.checkedBy ? { checked_by: opts.checkedBy } : {})
    }
  })
}

const SEVERITY_ORDER = { block: 0, warn: 1, ask: 2 } as const

/** The whole board: every candidate checked, chunk by chunk → a stored-shape result. */
export async function buildReadyResult(opts: {
  trigger: string
  userId?: string | null
  /** Probes only. */
  maxRecords?: number
  onChunk?: CheckOptions['onChunk']
}): Promise<ReadyResult> {
  const started = Date.now()
  const catalog = await loadCatalog()
  const candidates = await findCandidates(catalog)
  const outcome = await checkCandidates(candidates, catalog, {
    userId: opts.userId ?? null,
    maxRecords: opts.maxRecords,
    onChunk: opts.onChunk
  })
  const collections = [...new Set(outcome.entries.map((e) => e.collection))]
  const labels = await collectionLabels(collections).catch(() => new Map<string, string>())
  return {
    kind: 'ready-to-send',
    generated_at: new Date().toISOString(),
    trigger: opts.trigger,
    candidates: candidates.length,
    checked: outcome.checked,
    ready: outcome.ready,
    errors: outcome.errors,
    collections: Object.fromEntries(labels),
    entries: outcome.entries.sort(
      (a, b) => SEVERITY_ORDER[a.worst] - SEVERITY_ORDER[b.worst] || a.label.localeCompare(b.label)
    ),
    duration_ms: Date.now() - started
  }
}

/** "Check again" for one record, as the person asking: its send moves' entries now. Null = the
 *  record's next manual move does not push (or it has no open instance). */
export async function checkOneRecord(
  collection: string,
  item: string,
  userId: string | null,
  checkedBy: string | null
): Promise<{ entries: ReadyEntry[]; collection_label: string } | null> {
  const catalog = await loadCatalog()
  const candidates = await findCandidates(catalog, { collection, item })
  if (candidates.length === 0) return null
  const outcome = await checkCandidates(candidates.slice(0, 1), catalog, { userId, checkedBy })
  if (outcome.errors > 0) throw new Error('The check could not finish for this record')
  const labels = await collectionLabels([collection]).catch(() => new Map<string, string>())
  return { entries: outcome.entries, collection_label: labels.get(collection) ?? collection }
}

// ── Storage: the job's own nivaro_job_runs row ───────────────────────────────

async function ownRunRow(): Promise<number | null> {
  try {
    const row = (await db('nivaro_job_runs')
      .where({ job_id: READY_JOB_ID, status: 'running' })
      .where('started_at', '>', new Date(Date.now() - READY_STALE_MS))
      .orderBy('id', 'desc')
      .first('id')) as { id: number } | undefined
    return row ? Number(row.id) : null
  } catch {
    return null
  }
}

/**
 * The `ready-to-send` cron body (nightly tick and Run now, both through the CronManager, which
 * owns the job row, the heavy slot and the background pool). Every open record is checked —
 * no cap, no time box. After each chunk the row's progress says how far it got (counts only);
 * the finished board replaces it at the end. A run cut short (deploy, restart, watchdog) leaves
 * its counts behind: the board keeps the last COMPLETE result and says where that run stopped;
 * the next run starts from the beginning.
 */
export async function readyToSendTick(trigger = 'cron'): Promise<ReadyResult> {
  const rowId = await ownRunRow()
  const startedAt = new Date().toISOString()
  const result = await buildReadyResult({
    trigger,
    onChunk: async (p) => {
      if (rowId == null) return
      await db('nivaro_job_runs')
        .where('id', rowId)
        .update({ progress: progressJson({ ...p, started_at: startedAt }) })
    }
  })
  if (rowId != null) {
    await db('nivaro_job_runs')
      .where('id', rowId)
      .update({ progress: serializeResult(result) })
    await summarizeOlderRuns(rowId)
  }
  return result
}

/** Older runs keep their counts only: the Background Jobs list reads whole rows. */
async function summarizeOlderRuns(keepId: number): Promise<void> {
  try {
    const older = (await db('nivaro_job_runs')
      .where({ job_id: READY_JOB_ID })
      .where('id', '<', keepId)
      .where('progress', 'like', '{"kind":"ready-to-send",%')
      .select('id')) as Array<{ id: number }>
    for (const o of older) {
      const row = (await db('nivaro_job_runs').where('id', o.id).first('progress')) as
        | { progress: string | null }
        | undefined
      const r = parseResult(row?.progress)
      if (r)
        await db('nivaro_job_runs')
          .where('id', o.id)
          .update({ progress: summarizeResult(r) })
    }
  } catch {
    /* bookkeeping */
  }
}

export interface StoredRun {
  id: number
  status: string
  started_at: string | null
  finished_at: string | null
  result: ReadyResult
}

export interface RunRowHead {
  id: number
  status: string
  started_at: Date | string | null
  /** The first characters of progress — enough for its kind and a counts blob. */
  head: string | null
}

/**
 * Pure: from the job's newest rows (newest first), whether a run is going and how far it is,
 * and whether the last run that ended was cut short before writing its board. A row still
 * 'running' past READY_STALE_MS was killed (deploy / restart) and counts as stopped.
 */
export function boardRunState(
  rows: RunRowHead[],
  now = Date.now()
): {
  running: { checked: number; total: number } | null
  stopped: { checked: number; total: number | null; at: string | null } | null
} {
  const fresh = (r: RunRowHead) =>
    r.status === 'running' &&
    r.started_at != null &&
    now - new Date(r.started_at).getTime() < READY_STALE_MS
  let running: { checked: number; total: number } | null = null
  let stopped: { checked: number; total: number | null; at: string | null } | null = null
  for (const [n, r] of rows.entries()) {
    if (n === 0 && fresh(r)) {
      const p = parseProgress(r.head)
      running = { checked: p?.checked ?? 0, total: p?.total ?? 0 }
      continue
    }
    if (r.head?.startsWith(COMPLETE_PREFIX)) break
    const p = parseProgress(r.head)
    stopped = {
      checked: p?.checked ?? 0,
      total: p?.total ?? null,
      at: r.started_at ? new Date(r.started_at).toISOString() : null
    }
    break
  }
  return { running, stopped }
}

/** The newest complete board, whether a run is going (and how far), and whether the last run
 *  stopped short. */
export async function latestReadyResult(): Promise<{
  run: StoredRun | null
  running: boolean
  progress: { checked: number; total: number } | null
  stopped: { checked: number; total: number | null; at: string | null } | null
}> {
  const [heads, row] = await Promise.all([
    db('nivaro_job_runs')
      .where({ job_id: READY_JOB_ID })
      .orderBy('id', 'desc')
      .limit(5)
      .select(
        'id',
        'status',
        'started_at',
        db.raw('SUBSTRING(progress, 1, 400) AS head')
      ) as Promise<RunRowHead[]>,
    db('nivaro_job_runs')
      .where({ job_id: READY_JOB_ID })
      .where('progress', 'like', `${COMPLETE_PREFIX}%`)
      .orderBy('id', 'desc')
      .first('id', 'status', 'started_at', 'finished_at', 'progress') as Promise<
      | {
          id: number
          status: string
          started_at: Date | string | null
          finished_at: Date | string | null
          progress: string | null
        }
      | undefined
    >
  ])
  const state = boardRunState(heads)
  const result = row ? parseResult(row.progress) : null
  return {
    running: !!state.running,
    progress: state.running,
    stopped: state.stopped,
    run:
      row && result
        ? {
            id: Number(row.id),
            status: String(row.status),
            started_at: row.started_at ? new Date(row.started_at).toISOString() : null,
            finished_at: row.finished_at ? new Date(row.finished_at).toISOString() : null,
            result
          }
        : null
  }
}

/** Write a changed result back onto its row (Check again). */
export async function storeResult(rowId: number, result: ReadyResult): Promise<void> {
  await db('nivaro_job_runs')
    .where({ id: rowId, job_id: READY_JOB_ID })
    .update({ progress: serializeResult(result) })
}
