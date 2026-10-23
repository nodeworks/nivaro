import { createHash } from 'node:crypto'
import {
  type ArgumentNode,
  DirectiveLocation,
  type DirectiveNode,
  type DocumentNode,
  type ExecutionResult,
  execute,
  type FieldNode,
  GraphQLDirective,
  GraphQLError,
  type GraphQLInputType,
  GraphQLInt,
  type GraphQLSchema,
  getNamedType,
  getNullableType,
  getOperationAST,
  isInputObjectType,
  isListType,
  isObjectType,
  Kind,
  type SelectionSetNode,
  TypeInfo,
  type ValueNode,
  visit,
  visitWithTypeInfo
} from 'graphql'
import { pubsub, topics } from '../graphql/pubsub.js'
import type { User } from '../types.js'
import { isRealtimeRole } from './process-role.js'
import { withReadGate } from './read-gate.js'

/**
 * Live GraphQL queries (#2126).
 *
 * A query operation marked `@live` (over graphql-ws or the SSE transport) answers with its
 * result now, then again whenever a write touches what that result read. The server works out
 * what a result read from the document and the result itself:
 *
 * - every list (a root list, a nested to-many, `_metadata` / `_aggregated`, an M2M/M2A link
 *   row) and every collection named inside a `filter` argument is read "as a whole": any write
 *   in that collection re-runs the query (a create, or an update that moves a row into the
 *   filter, changes a list without touching a row it held);
 * - a single record (a `_by_id` root field, a nested M2O) is read "by id": only writes to the
 *   records the result actually held — or the id it asked for — re-run it.
 *
 * Re-runs are ALWAYS executed as the subscriber, never as the writer: the identity is read
 * fresh before each run (role, API key scopes and row restrictions), and the run goes through
 * the same resolvers, permission checks, row filters and user scopes as an ordinary query. A
 * subscriber who loses access gets the errors / empty result their own query now gives; one
 * whose sign-in ends (logout, revoked session or key, inactive account) gets SESSION_ENDED and
 * the live query completes. Write events carry ids and field names only (item-events.ts) and
 * are per tenant, so a live query hears its own tenant's writes only.
 *
 * Re-runs are debounced (`@live(throttle: ms)`, default 500), coalesce bursts, and a result is
 * only sent when it differs from the last one sent. Concurrent live queries are capped per
 * person (per tenant) and per process.
 */

export interface LiveTypeInfo {
  /** The collections an object of this type is read from. */
  collections: string[]
  /** True: any write in those collections may change it (lists, page facts, link rows,
   *  filter inputs). False: only writes to the record ids the result held. */
  any: boolean
}

export const LiveDirective = new GraphQLDirective({
  name: 'live',
  description:
    'Over a subscription transport (graphql-ws, /api/graphql/stream): keep the query open and send its new result whenever a write changes what it read. Ignored on POST /api/graphql.',
  locations: [DirectiveLocation.QUERY],
  args: {
    throttle: {
      type: GraphQLInt,
      description: 'Minimum milliseconds between results (100–60000, default 500).'
    }
  }
})

const liveTypesBySchema = new WeakMap<GraphQLSchema, Map<string, LiveTypeInfo>>()

/** Called by the schema builder: the collections behind each output and filter type. */
export function setLiveTypes(schema: GraphQLSchema, types: Map<string, LiveTypeInfo>): void {
  liveTypesBySchema.set(schema, types)
}

const DEFAULT_THROTTLE_MS = 500
const MIN_THROTTLE_MS = 100
const MAX_THROTTLE_MS = 60_000
/** How often a quiet live query re-checks that its sign-in still holds. */
const RECHECK_MS = 30_000
const T_KEY = '_nvr_live_t'
const ID_KEY = '_nvr_live_id'

function envInt(name: string, fallback: number): number {
  const n = Number(process.env[name])
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback
}

/** Is this operation a `@live` query? With the throttle it asked for. */
export function liveOperation(
  document: DocumentNode,
  operationName: string | null | undefined,
  variables?: Record<string, unknown> | null
): { throttleMs: number } | null {
  const op = getOperationAST(document, operationName ?? undefined)
  if (op?.operation !== 'query') return null
  const live = op.directives?.find((d: DirectiveNode) => d.name.value === 'live')
  if (!live) return null
  const raw = live.arguments?.find((a: ArgumentNode) => a.name.value === 'throttle')?.value
  const asked = raw ? Number(literalOrVariable(raw, variables)) : Number.NaN
  const throttleMs = Number.isFinite(asked)
    ? Math.min(MAX_THROTTLE_MS, Math.max(MIN_THROTTLE_MS, Math.floor(asked)))
    : DEFAULT_THROTTLE_MS
  return { throttleMs }
}

function literalOrVariable(
  node: ValueNode,
  variables: Record<string, unknown> | null | undefined
): unknown {
  switch (node.kind) {
    case Kind.VARIABLE:
      return variables?.[node.name.value]
    case Kind.INT:
    case Kind.FLOAT:
      return Number(node.value)
    case Kind.STRING:
    case Kind.ENUM:
      return node.value
    case Kind.BOOLEAN:
      return node.value
    case Kind.NULL:
      return null
    case Kind.LIST:
      return node.values.map((v) => literalOrVariable(v, variables))
    case Kind.OBJECT:
      return Object.fromEntries(
        node.fields.map((f) => [f.name.value, literalOrVariable(f.value, variables)])
      )
  }
}

// ─── What a query reads ─────────────────────────────────────────────────────

export interface LivePlan {
  /** The document with `_nvr_live_t` / `_nvr_live_id` read on every record object. */
  document: DocumentNode
  /** Collections read as a whole: any write there re-runs the query. */
  anyCollections: Set<string>
  /** Record ids asked for by argument (`orders_by_id(id: 5)`), per collection. */
  argIds: Map<string, Set<string>>
  /** Output type name → the collections its objects come from (record types only). */
  recordTypes: Map<string, string[]>
}

function normId(v: unknown): string {
  return String(v).toLowerCase()
}

function addId(map: Map<string, Set<string>>, collection: string, id: unknown): void {
  if (id == null || id === '') return
  let set = map.get(collection)
  if (!set) {
    set = new Set()
    map.set(collection, set)
  }
  set.add(normId(id))
}

const marker = (alias: string, name: string): FieldNode => ({
  kind: Kind.FIELD,
  alias: { kind: Kind.NAME, value: alias },
  name: { kind: Kind.NAME, value: name }
})

/** Collect the collections named by an input value (filters), walking it along its type. */
function inputCollections(
  type: GraphQLInputType,
  value: unknown,
  types: Map<string, LiveTypeInfo>,
  out: Set<string>,
  depth = 0
): void {
  if (depth > 32 || value == null) return
  const named = getNamedType(type)
  const info = types.get(named.name)
  if (info) for (const c of info.collections) out.add(c)
  const inner = getNullableType(type)
  if (isListType(inner)) {
    if (Array.isArray(value))
      for (const v of value) inputCollections(inner.ofType, v, types, out, depth + 1)
    return
  }
  if (!isInputObjectType(named) || typeof value !== 'object') return
  const fields = named.getFields()
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const f = fields[k]
    if (f) inputCollections(f.type, v, types, out, depth + 1)
  }
}

/** Work out what a `@live` query reads and mark every record object it returns. */
export function planLiveQuery(
  schema: GraphQLSchema,
  document: DocumentNode,
  variables?: Record<string, unknown> | null
): LivePlan {
  const types = liveTypesBySchema.get(schema) ?? new Map<string, LiveTypeInfo>()
  const anyCollections = new Set<string>()
  const argIds = new Map<string, Set<string>>()
  const recordTypes = new Map<string, string[]>()
  for (const [name, info] of types) if (!info.any) recordTypes.set(name, info.collections)

  const typeInfo = new TypeInfo(schema)
  const marked = visit(
    document,
    visitWithTypeInfo(typeInfo, {
      Field(node: FieldNode) {
        const fieldType = typeInfo.getType()
        const def = typeInfo.getFieldDef()
        if (!fieldType || !def) return
        const info = types.get(getNamedType(fieldType).name)
        if (info) {
          if (info.any || isListType(getNullableType(fieldType)))
            for (const c of info.collections) anyCollections.add(c)
          else {
            // A single record asked for by id: a create or a change to THAT id re-runs.
            const idArg = node.arguments?.find((a) => a.name.value === 'id')
            if (idArg && def.args.some((a) => a.name === 'id')) {
              const id = literalOrVariable(idArg.value, variables)
              for (const c of info.collections) addId(argIds, c, id)
            }
          }
        }
        // Filters name the collections they read through relations.
        for (const arg of node.arguments ?? []) {
          const argDef = def.args.find((a) => a.name === arg.name.value)
          if (!argDef) continue
          inputCollections(
            argDef.type,
            literalOrVariable(arg.value, variables),
            types,
            anyCollections
          )
        }
      },
      SelectionSet(node: SelectionSetNode) {
        const parent = typeInfo.getParentType()
        if (!isObjectType(parent) || !recordTypes.has(parent.name)) return
        const extra = [marker(T_KEY, '__typename')]
        if (parent.getFields().id) extra.push(marker(ID_KEY, 'id'))
        return { ...node, selections: [...node.selections, ...extra] }
      }
    })
  )
  return { document: marked, anyCollections, argIds, recordTypes }
}

/**
 * The record ids a result held, per collection — and the result with the markers removed
 * (the subscriber gets exactly the shape they asked for).
 */
export function touchedIds(data: unknown, recordTypes: Map<string, string[]>) {
  const touched = new Map<string, Set<string>>()
  const walk = (v: unknown, depth: number): void => {
    if (v == null || typeof v !== 'object' || depth > 64) return
    if (Array.isArray(v)) {
      for (const x of v) walk(x, depth + 1)
      return
    }
    const o = v as Record<string, unknown>
    if (T_KEY in o) {
      const collections = recordTypes.get(String(o[T_KEY]))
      if (collections && o[ID_KEY] != null)
        for (const c of collections) addId(touched, c, o[ID_KEY])
      delete o[T_KEY]
      delete o[ID_KEY]
    }
    for (const x of Object.values(o)) walk(x, depth + 1)
  }
  walk(data, 0)
  return touched
}

/** Does a write event change what the last result read? */
export function eventTouches(
  plan: Pick<LivePlan, 'anyCollections' | 'argIds'>,
  touched: Map<string, Set<string>>,
  ev: { collection: string; item: string }
): boolean {
  if (plan.anyCollections.has(ev.collection)) return true
  const held = touched.get(ev.collection)
  const asked = plan.argIds.get(ev.collection)
  if (!held && !asked) return false
  // A raw bulk write (#1875) names no record: it may have touched any of them.
  if (ev.item === '*') return true
  const id = normId(ev.item)
  return !!held?.has(id) || !!asked?.has(id)
}

/** The collections a live query listens to: everything it read, as a whole or by id. */
function watchedCollections(plan: LivePlan, touched: Map<string, Set<string>>): Set<string> {
  return new Set([...plan.anyCollections, ...touched.keys(), ...plan.argIds.keys()])
}

// ─── Caps ───────────────────────────────────────────────────────────────────

const perUser = new Map<string, number>()
let total = 0

/** Live queries open on this process, and per person (diagnostics, tests). */
export function liveQueryStats(): { total: number; people: number } {
  return { total, people: perUser.size }
}

function acquire(key: string): string | null {
  const maxTotal = envInt('LIVE_QUERY_MAX', 500)
  const maxUser = envInt('LIVE_QUERY_MAX_PER_USER', 10)
  if (total >= maxTotal) return `This server has its maximum of ${maxTotal} live queries open`
  const mine = perUser.get(key) ?? 0
  if (mine >= maxUser) return `You already have ${maxUser} live queries open`
  perUser.set(key, mine + 1)
  total++
  return null
}

function release(key: string): void {
  const mine = (perUser.get(key) ?? 1) - 1
  if (mine <= 0) perUser.delete(key)
  else perUser.set(key, mine)
  total = Math.max(0, total - 1)
}

// ─── The live query ─────────────────────────────────────────────────────────

export interface LiveIdentity {
  user: User
  isAdmin: boolean
}

export interface LiveQueryArgs {
  schema: GraphQLSchema
  document: DocumentNode
  variableValues?: Record<string, unknown> | null
  operationName?: string | null
  throttleMs?: number
  /** The tenant the transport resolved ('' self-hosted) — write events are per tenant. */
  tenantKey: string
  /** Run inside the subscriber's tenant (cloud). */
  withTenant?: <T>(fn: () => Promise<T>) => Promise<T>
  /** The subscriber's identity, read fresh; null = the sign-in ended. */
  identity: () => Promise<LiveIdentity | null>
  /** Person key for the per-person cap (the user id at open). */
  userId: string
}

function errorResult(message: string, code: string): ExecutionResult {
  return { errors: [new GraphQLError(message, { extensions: { code } })] }
}

/** One error result, then done (a refused live query). */
function oneShot(result: ExecutionResult): AsyncIterableIterator<ExecutionResult> {
  let sent = false
  return {
    async next() {
      if (sent) return { value: undefined, done: true }
      sent = true
      return { value: result, done: false }
    },
    async return() {
      sent = true
      return { value: undefined, done: true }
    },
    async throw(e: unknown) {
      sent = true
      throw e
    },
    [Symbol.asyncIterator]() {
      return this
    }
  }
}

/**
 * Open a live query. The iterator yields the first result, then each changed result; it ends
 * when the transport calls `return()` (socket closed, client completed) or the sign-in ends.
 */
export function liveQuery(args: LiveQueryArgs): AsyncIterableIterator<ExecutionResult> {
  const capKey = `${args.tenantKey}\u0000${String(args.userId).toUpperCase()}`
  const refused = acquire(capKey)
  if (refused) return oneShot(errorResult(refused, 'LIVE_QUERY_LIMIT'))

  const throttleMs = args.throttleMs ?? DEFAULT_THROTTLE_MS
  const inTenant = <T>(fn: () => Promise<T>) => (args.withTenant ? args.withTenant(fn) : fn())
  const plan = planLiveQuery(args.schema, args.document, args.variableValues)

  const queue: ExecutionResult[] = []
  const waiters: Array<(r: IteratorResult<ExecutionResult>) => void> = []
  let touched = new Map<string, Set<string>>()
  const listening = new Map<string, () => void>()
  let stopped = false
  let finishing = false
  let running = false
  let dirty = false
  let timer: ReturnType<typeof setTimeout> | null = null
  let lastRunAt = 0
  let lastHash: string | null = null
  let revision = 0

  const push = (r: ExecutionResult): void => {
    if (stopped) return
    const w = waiters.shift()
    if (w) w({ value: r, done: false })
    else queue.push(r)
  }

  const stop = (): void => {
    if (stopped) return
    stopped = true
    if (timer) clearTimeout(timer)
    timer = null
    clearInterval(recheck)
    for (const off of listening.values()) off()
    listening.clear()
    release(capKey)
    for (const w of waiters.splice(0)) w({ value: undefined, done: true })
  }

  /** Send a last result, then end once the subscriber has read it. */
  const finish = (r: ExecutionResult): void => {
    if (stopped || finishing) return
    finishing = true
    push(r)
    if (timer) clearTimeout(timer)
    timer = null
    clearInterval(recheck)
    for (const off of listening.values()) off()
    listening.clear()
  }

  const onEvent = (payload: unknown): void => {
    if (stopped || finishing) return
    const ev = (payload as { itemMutated?: { collection?: string; item?: string } }).itemMutated
    if (!ev?.collection || ev.item == null) return
    if (!eventTouches(plan, touched, { collection: ev.collection, item: String(ev.item) })) return
    schedule()
  }

  const relisten = (): void => {
    const want = watchedCollections(plan, touched)
    for (const [c, off] of listening) {
      if (!want.has(c)) {
        off()
        listening.delete(c)
      }
    }
    for (const c of want) {
      if (listening.has(c)) continue
      listening.set(c, pubsub.on(topics.itemMutated(c, '*', args.tenantKey), onEvent))
    }
  }

  const ended = (): ExecutionResult =>
    errorResult('Your sign-in ended, so this live query stopped', 'SESSION_ENDED')

  const run = async (): Promise<void> => {
    if (stopped || finishing) return
    running = true
    dirty = false
    lastRunAt = Date.now()
    try {
      const who = await inTenant(args.identity)
      if (stopped || finishing) return
      if (!who) {
        finish(ended())
        return
      }
      const runOnce = async () =>
        execute({
          schema: args.schema,
          document: plan.document,
          variableValues: args.variableValues ?? undefined,
          operationName: args.operationName ?? undefined,
          contextValue: { user: who.user, isAdmin: who.isAdmin }
        })
      // Post-mortem 3.3 — on a realtime process the re-runs share the heavy-read gate, so a burst
      // of writes cannot let @live queries take the small database pool from sign-ins.
      const result = (await inTenant(async () =>
        isRealtimeRole() ? withReadGate(String(who.user.id), runOnce, { label: 'live' }) : runOnce()
      )) as ExecutionResult
      if (stopped || finishing) return
      touched = touchedIds(result.data, plan.recordTypes)
      relisten()
      const hash = createHash('sha1').update(JSON.stringify(result)).digest('hex')
      if (hash === lastHash) return
      lastHash = hash
      revision++
      push({ ...result, extensions: { ...(result.extensions ?? {}), live: { revision } } })
    } catch (err) {
      push(errorResult(err instanceof Error ? err.message : String(err), 'LIVE_QUERY_FAILED'))
    } finally {
      running = false
      if (dirty && !stopped && !finishing) schedule()
    }
  }

  function schedule(): void {
    if (stopped || finishing) return
    if (running) {
      dirty = true
      return
    }
    if (timer) return
    const wait = Math.max(0, lastRunAt + throttleMs - Date.now())
    timer = setTimeout(() => {
      timer = null
      void run()
    }, wait)
    timer.unref?.()
  }

  // A quiet live query still ends with its sign-in.
  const recheck = setInterval(
    () => {
      if (stopped || finishing || running) return
      void inTenant(args.identity)
        .then((who) => {
          if (!who) finish(ended())
        })
        .catch(() => {})
    },
    envInt('LIVE_QUERY_RECHECK_MS', RECHECK_MS)
  )
  recheck.unref?.()

  void run()

  return {
    next(): Promise<IteratorResult<ExecutionResult>> {
      if (queue.length) {
        const value = queue.shift() as ExecutionResult
        if (finishing && queue.length === 0) stop()
        return Promise.resolve({ value, done: false })
      }
      if (stopped || finishing) {
        stop()
        return Promise.resolve({ value: undefined, done: true })
      }
      return new Promise((res) => waiters.push(res))
    },
    return(): Promise<IteratorResult<ExecutionResult>> {
      stop()
      return Promise.resolve({ value: undefined, done: true })
    },
    throw(e: unknown): Promise<IteratorResult<ExecutionResult>> {
      stop()
      return Promise.reject(e)
    },
    [Symbol.asyncIterator]() {
      return this
    }
  }
}
