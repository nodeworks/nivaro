// api/src/services/traffic-inspect/request-capture.ts
/**
 * Traffic Map drill-down #1191 / #1213 — "Trace next call" and "Capture next": arms that keep the
 * next N matching requests' traces (whatever their speed) and, for captures, hold their request
 * bodies in memory (never written to nivaro_api_logs — session callers' bodies included).
 *
 * The book is per process. An arm is published on Redis (`<REDIS_CHANNEL_PREFIX>nvr:tm-trace-next`)
 * so every API process arms it; whichever process serves a matching request announces the kept
 * entry back on the same channel, so the arming page sees it whatever node it polls. Counts are
 * per process and reconciled on each announcement — two processes matching in the same instant
 * can keep one more than asked.
 *
 * Also remembers, for the root /graphql alias gap, which chain each internally dispatched GraphQL
 * request belonged to (the outer log row carries the chain id but no request id).
 */
import type { Redis } from 'ioredis'
import { type KeepNextInfo, keepNext } from '../request-trace.js'
import { maskBodySecrets, maskQueryString } from '../secret-mask.js'
import { callerKeyFor, classifyRequest, entityKey, routeTemplate } from '../traffic-entities.js'
import {
  type Arm,
  CAPTURE_BODY_CAP,
  KeepNextBook,
  type KeptEntry,
  type RequestFacts
} from './request-logic.js'

export const TRACE_NEXT_CHANNEL_SUFFIX = 'nvr:tm-trace-next'

const book = new KeepNextBook()
let nodeId = 'local'
let publish: ((m: RelayMessage) => void) | null = null

export function inspectBook(): KeepNextBook {
  return book
}

/** This process's node id as it labels kept entries (set when the relay starts). */
export function setInspectNode(id: string): void {
  if (id) nodeId = id
}

export type RelayMessage =
  | { t: 'arm'; node: string; arm: Omit<Arm, 'entries'> }
  | { t: 'kept'; node: string; armId: string; entry: KeptEntry }
  | { t: 'stop'; node: string; armId: string }

/** Arm here and on every peer. */
export function armEverywhere(arm: Omit<Arm, 'entries'>): void {
  book.arm(arm)
  publish?.({ t: 'arm', node: nodeId, arm })
}

/** Stop an arm here and on every peer (what it caught stays until it expires). */
export function stopEverywhere(armId: string): boolean {
  const had = book.stop(armId)
  publish?.({ t: 'stop', node: nodeId, armId })
  return had
}

/** Handle one relay message from a peer (exported for tests). */
export function receiveRelay(m: RelayMessage): void {
  if (!m || typeof m !== 'object' || m.node === nodeId) return
  if (m.t === 'arm' && m.arm && typeof m.arm.id === 'string') book.arm(m.arm)
  else if (m.t === 'kept' && typeof m.armId === 'string' && m.entry)
    book.applyRemote(m.armId, m.entry)
  else if (m.t === 'stop' && typeof m.armId === 'string') book.stop(m.armId)
}

// ─── The /graphql alias: inner request id → chain ────────────────────────────

const GQL_CHAIN_CAP = 2000
const gqlChains = new Map<string, { chainId: string; at: number }>()

/** The chain an internally dispatched GraphQL request (by request id) ran in, if seen here. */
export function chainForGraphqlRequest(rid: string): { chainId: string; at: number } | null {
  return gqlChains.get(rid.toLowerCase()) ?? null
}

// ─── The matcher ─────────────────────────────────────────────────────────────

interface ReqLike {
  method?: string
  authMethod?: string
  apiKeyId?: number | null
  chainId?: string
  body?: unknown
  headers?: Record<string, unknown>
  __nvrGql?: { operation?: string | null; kind?: string | null }
}

function factsOf(info: KeepNextInfo, req: ReqLike | null, path: string): RequestFacts {
  const op = req?.__nvrGql?.operation ?? null
  const c = classifyRequest({
    method: info.method,
    path,
    graphqlOperation: op,
    graphqlKind: req?.__nvrGql?.kind ?? null
  })
  return {
    route: routeTemplate(info.method, path, op),
    caller: callerKeyFor({
      authMethod: req?.authMethod ?? null,
      apiKeyId: req?.apiKeyId ?? null,
      userId: info.user
    }),
    entity: c ? entityKey(c.lane, c.entity) : null
  }
}

/**
 * The request body as a capture keeps it: masked JSON text, capped; or why there is none. JSON
 * only, like the API log (plugins/api-logger.ts captureRequestBody): `maskBodySecrets` masks by
 * key name inside JSON, so a plain-text or form-encoded body could carry a credential through.
 */
export function captureBody(
  req: ReqLike | null,
  method: string
): {
  body: string | null
  note: string | null
} {
  if (!req || req.body == null) {
    return {
      body: null,
      note:
        method === 'GET' || method === 'HEAD' ? 'A GET carries no body' : 'The request had no body'
    }
  }
  const ct = String(req.headers?.['content-type'] ?? '')
  if (ct.includes('multipart'))
    return { body: null, note: 'Multipart upload — the body is not captured' }
  if (!ct.toLowerCase().includes('json'))
    return {
      body: null,
      note: 'Non-JSON body — only JSON bodies are captured (credentials are masked by key)'
    }
  try {
    const text = typeof req.body === 'string' ? req.body : JSON.stringify(req.body)
    if (typeof text !== 'string') return { body: null, note: 'The body could not be read' }
    const cut = text.length > CAPTURE_BODY_CAP ? `${text.slice(0, CAPTURE_BODY_CAP)}…` : text
    return { body: maskBodySecrets(cut), note: null }
  } catch {
    return { body: null, note: 'The body could not be read' }
  }
}

/** The keep-next matcher (exported for tests); registered with request-trace below. */
export function inspectKeepNext(info: KeepNextInfo): boolean {
  const req = (
    info.request && typeof info.request === 'object' ? info.request : null
  ) as ReqLike | null
  const mark = info.url.indexOf('?')
  const path = mark < 0 ? info.url : info.url.slice(0, mark)

  // The root /graphql alias: remember the inner request's chain (cheap, GraphQL only).
  if (path === '/api/graphql' && req?.chainId) {
    gqlChains.set(info.id.toLowerCase(), { chainId: req.chainId, at: Date.now() })
    if (gqlChains.size > GQL_CHAIN_CAP) {
      const first = gqlChains.keys().next().value
      if (first !== undefined) gqlChains.delete(first)
    }
  }

  // The page's own polling must never satisfy an arm.
  if (path.startsWith('/api/traffic-map')) return false
  if (book.active() === 0) return false
  const facts = factsOf(info, req, path)
  const hits = book.match(facts)
  if (hits.length === 0) return false
  const base: KeptEntry = {
    rid: info.id,
    at: Date.now(),
    ms: info.total_ms,
    route: facts.route,
    method: info.method,
    path,
    status: info.status,
    node: nodeId,
    query: mark < 0 ? null : maskQueryString(info.url.slice(mark + 1))
  }
  let captured: { body: string | null; note: string | null } | null = null
  for (const arm of hits) {
    let entry = base
    if (arm.kind === 'capture') {
      captured ??= captureBody(req, info.method)
      entry = { ...base, body: captured.body, body_note: captured.note }
    }
    if (book.record(arm.id, entry)) publish?.({ t: 'kept', node: nodeId, armId: arm.id, entry })
  }
  return true
}

// Registered at module load so the matcher is in place before the first request. Guarded: a test
// that mocks request-trace without `keepNext` must not fail to load every module importing this.
try {
  keepNext('traffic-inspect-request', inspectKeepNext)
} catch {
  /* no keep-next hook on this request-trace (a partial mock) — arms match nothing */
}

// ─── Redis relay ─────────────────────────────────────────────────────────────

let relayStarted = false

/** Start the relay on this process (no-op when already running). Returns a stop function. */
export async function startInspectRelay(redis: Redis, node: string): Promise<() => Promise<void>> {
  setInspectNode(node)
  if (relayStarted) return async () => {}
  const channel = `${process.env.REDIS_CHANNEL_PREFIX ?? ''}${TRACE_NEXT_CHANNEL_SUFFIX}`
  const sub = redis.duplicate()
  sub.on('message', (ch: string, raw: string) => {
    if (ch !== channel) return
    try {
      receiveRelay(JSON.parse(raw) as RelayMessage)
    } catch {
      /* a malformed message never affects an arm */
    }
  })
  sub.on('error', () => {})
  await sub.subscribe(channel)
  publish = (m) => {
    redis.publish(channel, JSON.stringify(m)).catch(() => {})
  }
  relayStarted = true
  return async () => {
    publish = null
    relayStarted = false
    await sub.quit().catch(() => {})
  }
}

/** Test hook: forget arms, chains and the transport. */
export function resetInspectCapture(): void {
  book.clear()
  gqlChains.clear()
  publish = null
}

/** Test hook: capture outgoing relay messages. */
export function setRelayPublisherForTests(fn: ((m: RelayMessage) => void) | null): void {
  publish = fn
}
