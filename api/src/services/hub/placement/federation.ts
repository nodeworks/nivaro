import { insertReturningId } from '../../../db/dialect/ef.js'
import { db } from '../../../db/index.js'
import { safeFetch } from '../../../lib/ssrf.js'
import { appMap } from '../../app-state.js'
import { hubUrlCheck } from '../../deployment-mode.js'
import { HUB_MASK, HubSecretError, openSecret, sealSecret } from '../secrets.js'
import { PlacementError, plainText } from './regions.js'

/**
 * Hub placement (idea 50): Hub-to-Hub federation, read only.
 *
 * A Hub registers another Hub (a PEER) by its https origin and an API key of THAT Hub with the
 * `hub:read` scope (hub-enh/api: a key reaches the Hub only with a Hub scope; `hub:read` = reads
 * and plans). The key is sealed with this Hub's ENCRYPTION_KEY at rest and never answered back
 * (reads show the mask). This Hub only ever sends GETs to two routes of the peer:
 *
 *   GET /api/hub/federation/self   who answers and with which Hub scope the key came (on save and
 *                                  on Check: a key with hub:write is refused, PEER_KEY_TOO_WIDE —
 *                                  federation needs no write, so it never holds one)
 *   GET /api/hub/fleet             the apps × environments the key's owner may see there
 *
 * Every call goes through safeFetch (lib/ssrf.ts: the address pinned, every redirect refused,
 * private or reserved addresses refused unless SSRF_ALLOW_HOSTS lets the name through), with a
 * 10 s timeout and a 4 MB answer cap. Nothing a peer answers is trusted: each row is rebuilt
 * field by field from plain types with length caps (text, numbers, ISO dates, booleans) — no
 * HTML, no URLs. The only link the fleet view shows is built here: the peer's own stored origin +
 * `/hub?app=<integer id>` (a plain host-relative path). No action is ever sent to a peer.
 *
 * Reads are cached per peer for 60 s (appMap: keyed per app like every module-level cache), and
 * a peer that stops answering shows its last good answer for up to 15 minutes, marked stale.
 */

export const PEERS = 'nivaro_hub_peers'

export const PEER_TIMEOUT_MS = 10_000
export const PEER_MAX_BYTES = 4 * 1024 * 1024
export const PEER_CACHE_MS = 60_000
export const PEER_STALE_MS = 15 * 60_000
/** Rows kept from one peer's fleet answer. */
export const PEER_MAX_ROWS = 2000

export interface PeerRow {
  id: number
  name: string
  base_url: string
  /** Sealed. */
  token: string | null
  enabled: boolean
  last_ok_at: string | null
  last_tried_at: string | null
  last_error: string | null
  last_count: number | null
}

/** A peer as the API shows it: the key only ever as the mask. */
export type PublicPeer = Omit<PeerRow, 'token'> & { token: string | null }

const iso = (v: unknown): string | null => {
  if (v == null) return null
  const d = v instanceof Date ? v : new Date(String(v))
  return Number.isFinite(d.getTime()) ? d.toISOString() : null
}

function peerFromRow(r: Record<string, unknown>): PeerRow {
  return {
    id: Number(r.id),
    name: String(r.name),
    base_url: String(r.base_url),
    token: (r.token as string | null) ?? null,
    enabled: r.enabled === true || r.enabled === 1 || r.enabled === '1',
    last_ok_at: iso(r.last_ok_at),
    last_tried_at: iso(r.last_tried_at),
    last_error: r.last_error == null ? null : String(r.last_error),
    last_count: r.last_count == null ? null : Number(r.last_count)
  }
}

export function publicPeer(p: PeerRow): PublicPeer {
  return { ...p, token: p.token ? HUB_MASK : null }
}

/** A peer's origin by the HUB_URL rule (https; plain http only to loopback outside production). */
export function peerOrigin(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw.trim() || raw.length > 300) return null
  return hubUrlCheck({ HUB_URL: raw.trim(), NODE_ENV: process.env.NODE_ENV }).origin
}

/** An API key as typed: one token, printable, 20–400 characters. */
export function tokenShapeOk(v: unknown): v is string {
  return typeof v === 'string' && /^[\x21-\x7e]{20,400}$/.test(v)
}

export async function listPeers(): Promise<PeerRow[]> {
  const rows = (await db(PEERS).orderBy('name', 'asc').orderBy('id', 'asc')) as Record<
    string,
    unknown
  >[]
  return rows.map(peerFromRow)
}

export async function getPeer(id: number): Promise<PeerRow | null> {
  const r = (await db(PEERS).where({ id }).first()) as Record<string, unknown> | undefined
  return r ? peerFromRow(r) : null
}

// ─── reading a peer ──────────────────────────────────────────────────────────

export type PeerFetch = (
  url: string,
  init: { headers: Record<string, string> }
) => Promise<Response>

const defaultFetch: PeerFetch = (url, init) =>
  safeFetch(url, {
    method: 'GET',
    headers: init.headers,
    redirect: 'error',
    timeoutMs: PEER_TIMEOUT_MS
  })

/** Why a read failed, as a code (never the peer's text, a URL or the key). */
export type PeerError =
  | 'PEER_UNREACHABLE'
  | 'PEER_REFUSED'
  | 'PEER_SCOPE_MISSING'
  | 'PEER_TOO_OLD'
  | 'PEER_BAD_ANSWER'
  | 'PEER_TOO_LARGE'
  | 'PEER_KEY_TOO_WIDE'
  | 'PEER_NOT_A_KEY'
  | 'PEER_KEY_UNREADABLE'

export const PEER_ERROR_WORDS: Record<PeerError, string> = {
  PEER_UNREACHABLE:
    'The other Hub did not answer (its address, the network, or SSRF_ALLOW_HOSTS on this Hub for a private address).',
  PEER_REFUSED: 'The other Hub refused the key (wrong, revoked or expired).',
  PEER_SCOPE_MISSING: 'The key has no hub:read scope on the other Hub.',
  PEER_TOO_OLD: 'The other Hub runs a version without federation (0.3.215 or later is needed).',
  PEER_BAD_ANSWER: 'The other Hub gave an answer this Hub cannot read.',
  PEER_TOO_LARGE: 'The other Hub answered with more than this Hub reads (4 MB).',
  PEER_KEY_TOO_WIDE:
    'The key can change the other Hub (hub:write). Federation only reads: make a key with hub:read only.',
  PEER_NOT_A_KEY: 'The other Hub did not see a named API key. Use an API key made there.',
  PEER_KEY_UNREADABLE:
    'This Hub cannot open the stored key (sealed with another ENCRYPTION_KEY). Enter it again.'
}

class PeerReadError extends Error {
  code: PeerError
  constructor(code: PeerError) {
    super(PEER_ERROR_WORDS[code])
    this.name = 'PeerReadError'
    this.code = code
  }
}

async function readCapped(res: Response): Promise<string> {
  if (!res.body) return ''
  const declared = Number(res.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > PEER_MAX_BYTES) {
    void res.body.cancel().catch(() => {})
    throw new PeerReadError('PEER_TOO_LARGE')
  }
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > PEER_MAX_BYTES) {
      void reader.cancel().catch(() => {})
      throw new PeerReadError('PEER_TOO_LARGE')
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/** One GET of the peer, JSON `data` answered; a failure is a PeerReadError code. */
async function peerGet(
  origin: string,
  path: '/api/hub/federation/self' | '/api/hub/fleet',
  token: string,
  doFetch: PeerFetch
): Promise<unknown> {
  let res: Response
  try {
    res = await doFetch(`${origin}${path}`, {
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' }
    })
  } catch {
    throw new PeerReadError('PEER_UNREACHABLE')
  }
  if (res.status === 401) {
    void res.body?.cancel().catch(() => {})
    throw new PeerReadError('PEER_REFUSED')
  }
  if (res.status === 403) {
    const text = await readCapped(res).catch(() => '')
    let code = ''
    try {
      code = String((JSON.parse(text) as { code?: unknown }).code ?? '')
    } catch {
      // not JSON
    }
    throw new PeerReadError(code === 'HUB_SCOPE_MISSING' ? 'PEER_SCOPE_MISSING' : 'PEER_REFUSED')
  }
  if (res.status === 404) {
    void res.body?.cancel().catch(() => {})
    throw new PeerReadError('PEER_TOO_OLD')
  }
  if (res.status < 200 || res.status >= 300) {
    void res.body?.cancel().catch(() => {})
    throw new PeerReadError('PEER_UNREACHABLE')
  }
  const text = await readCapped(res)
  try {
    const body = JSON.parse(text) as { data?: unknown }
    if (!body || typeof body !== 'object' || !('data' in body))
      throw new PeerReadError('PEER_BAD_ANSWER')
    return body.data
  } catch (e) {
    if (e instanceof PeerReadError) throw e
    throw new PeerReadError('PEER_BAD_ANSWER')
  }
}

export interface PeerSelf {
  product: string
  version: string | null
  key_scope: 'read' | 'write' | 'none'
}

/** The peer's answer to /federation/self, checked (a key with write scope is refused). */
export function parseSelf(data: unknown): PeerSelf {
  if (!data || typeof data !== 'object') throw new PeerReadError('PEER_BAD_ANSWER')
  const d = data as Record<string, unknown>
  if (d.auth !== 'api_key') throw new PeerReadError('PEER_NOT_A_KEY')
  const scope = d.key_scope === 'write' ? 'write' : d.key_scope === 'read' ? 'read' : 'none'
  if (scope === 'write') throw new PeerReadError('PEER_KEY_TOO_WIDE')
  if (scope === 'none') throw new PeerReadError('PEER_SCOPE_MISSING')
  return {
    product: safeText(d.product, 60) ?? 'Nivaro Hub',
    version: versionText(d.version),
    key_scope: scope
  }
}

// ─── remote rows, rebuilt ───────────────────────────────────────────────────

/** Plain text from a peer: printable, one line, capped; anything else null. */
export function safeText(v: unknown, max: number): string | null {
  if (typeof v !== 'string') return null
  let out = ''
  for (const ch of v) {
    const c = ch.codePointAt(0) ?? 0
    // Control characters, and the bidi overrides a name could hide text with.
    if (c < 0x20 || c === 0x7f || (c >= 0x202a && c <= 0x202e) || (c >= 0x2066 && c <= 0x2069))
      continue
    out += ch
  }
  const t = out.trim()
  return t ? t.slice(0, max) : null
}

const KEY_RE = /^[a-z0-9][a-z0-9-]{0,62}$/
const keyText = (v: unknown): string | null => (typeof v === 'string' && KEY_RE.test(v) ? v : null)
const versionText = (v: unknown): string | null =>
  typeof v === 'string' && /^v?\d+\.\d+\.\d+(-[0-9A-Za-z.-]{1,32})?$/.test(v) ? v : null
const intOf = (v: unknown, max = 1_000_000_000): number | null =>
  typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= max ? v : null
const pctOf = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 100
    ? Math.round(v * 100) / 100
    : null
const boolOf = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null)
const isoOf = (v: unknown): string | null => {
  if (typeof v !== 'string' || v.length > 40) return null
  const t = Date.parse(v)
  return Number.isFinite(t) ? new Date(t).toISOString() : null
}
const STATES = new Set(['ok', 'degraded', 'unreachable', 'link_refused'])
const PLACEMENTS = new Set(['dedicated', 'shared', 'none'])
/** A host name only (from the peer's environment address): never a URL or a path. */
function hostOnly(v: unknown): string | null {
  if (typeof v !== 'string' || v.length > 300) return null
  try {
    const u = new URL(v)
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null
    const h = u.hostname.toLowerCase()
    return /^[a-z0-9.-]{1,253}$/.test(h) ? h : null
  } catch {
    return null
  }
}

export interface FederatedRow {
  app_id: number
  app_key: string
  app_name: string
  environment_id: number
  env_key: string
  env_status: string | null
  host: string | null
  placement: 'dedicated' | 'shared' | 'none' | null
  version: string | null
  behind: number | null
  state: string | null
  up: boolean | null
  uptime_30d: number | null
  open_issues: number | null
  alerts: number
  checked_at: string | null
  deployed_at: string | null
  /** Host-relative path on the peer (built here, never taken from the answer). */
  path: string
}

/** One fleet row from a peer rebuilt from plain types, or null when it is not one. */
export function rebuildRow(v: unknown): FederatedRow | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null
  const r = v as Record<string, unknown>
  const appId = intOf(r.app_id)
  const envId = intOf(r.environment_id)
  const appKey = keyText(r.app_key)
  const envKey = keyText(r.env_key)
  if (appId === null || envId === null || !appKey || !envKey) return null
  const state = typeof r.state === 'string' && STATES.has(r.state) ? r.state : null
  const placement =
    typeof r.placement === 'string' && PLACEMENTS.has(r.placement)
      ? (r.placement as FederatedRow['placement'])
      : null
  const status = keyText(r.env_status)
  return {
    app_id: appId,
    app_key: appKey,
    app_name: safeText(r.app_name, 120) ?? appKey,
    environment_id: envId,
    env_key: envKey,
    env_status: status,
    host: hostOnly(r.base_url),
    placement,
    version: versionText(r.version),
    behind: intOf(r.behind, 10_000),
    state,
    up: boolOf(r.up),
    uptime_30d: pctOf(r.uptime_30d),
    open_issues: intOf(r.open_issues),
    alerts: Array.isArray(r.alerts) ? Math.min(r.alerts.length, 999) : 0,
    checked_at: isoOf(r.checked_at),
    deployed_at: isoOf(r.deployed_at),
    path: `/hub?app=${appId}`
  }
}

export function parseFleet(data: unknown): { rows: FederatedRow[]; newest: string | null } {
  if (!data || typeof data !== 'object' || !Array.isArray((data as { rows?: unknown }).rows))
    throw new PeerReadError('PEER_BAD_ANSWER')
  const d = data as { rows: unknown[]; newest?: unknown }
  const rows: FederatedRow[] = []
  for (const r of d.rows.slice(0, PEER_MAX_ROWS)) {
    const x = rebuildRow(r)
    if (x) rows.push(x)
  }
  return { rows, newest: versionText(d.newest) }
}

// ─── reads, cached ───────────────────────────────────────────────────────────

export interface PeerFleet {
  peer_id: number
  name: string
  /** The peer's origin as stored here (operator-set), for the one link the view builds. */
  base_url: string
  ok: boolean
  error: PeerError | null
  error_text: string | null
  /** The answer shown is the last good one (the peer failed since). */
  stale: boolean
  fetched_at: string | null
  version: string | null
  newest: string | null
  rows: FederatedRow[]
}

interface Cached {
  at: number
  ok: { at: number; version: string | null; newest: string | null; rows: FederatedRow[] } | null
  error: PeerError | null
}

/** Per peer id, per app (module-state guard: appMap). */
const fleetCache = appMap<number, Cached>()

export function _resetFederationCacheForTests(): void {
  fleetCache.clear()
}

export interface FederationDeps {
  fetch?: PeerFetch
  now?: () => number
}

function tokenOf(p: PeerRow): string {
  try {
    const t = openSecret(p.token)
    if (!t) throw new PeerReadError('PEER_KEY_UNREADABLE')
    return t
  } catch (e) {
    if (e instanceof PeerReadError) throw e
    if (e instanceof HubSecretError) throw new PeerReadError('PEER_KEY_UNREADABLE')
    throw e
  }
}

/** Asks a peer who it is with this key (save, Check). Throws PlacementError 409 with the code. */
export async function checkPeerKey(
  origin: string,
  token: string,
  deps: FederationDeps = {}
): Promise<PeerSelf> {
  try {
    return parseSelf(
      await peerGet(origin, '/api/hub/federation/self', token, deps.fetch ?? defaultFetch)
    )
  } catch (e) {
    if (e instanceof PeerReadError) throw new PlacementError(e.code, e.message, 409)
    throw e
  }
}

async function noteOutcome(id: number, ok: boolean, error: PeerError | null, count: number | null) {
  const now = new Date()
  await db(PEERS)
    .where({ id })
    .update({
      last_tried_at: now,
      ...(ok ? { last_ok_at: now, last_error: null, last_count: count } : { last_error: error })
    })
    .catch(() => undefined)
}

/** One peer's fleet, from the cache when fresh. Never throws for the peer's own failures. */
export async function readPeerFleet(
  p: PeerRow,
  deps: FederationDeps = {},
  opts: { fresh?: boolean } = {}
): Promise<PeerFleet> {
  const now = deps.now ?? Date.now
  const t = now()
  let c = fleetCache.get(p.id)
  if (!c || opts.fresh || t - c.at >= PEER_CACHE_MS) {
    const prev = c?.ok ?? null
    const origin = peerOrigin(p.base_url)
    try {
      if (!origin) throw new PeerReadError('PEER_UNREACHABLE')
      const token = tokenOf(p)
      const doFetch = deps.fetch ?? defaultFetch
      // The key is re-checked on every fresh read: a key widened to hub:write since is refused.
      const self = parseSelf(await peerGet(origin, '/api/hub/federation/self', token, doFetch))
      const fleet = parseFleet(await peerGet(origin, '/api/hub/fleet', token, doFetch))
      c = {
        at: t,
        ok: { at: t, version: self.version, newest: fleet.newest, rows: fleet.rows },
        error: null
      }
      await noteOutcome(p.id, true, null, fleet.rows.length)
    } catch (e) {
      if (!(e instanceof PeerReadError)) throw e
      c = { at: t, ok: prev && t - prev.at < PEER_STALE_MS ? prev : null, error: e.code }
      await noteOutcome(p.id, false, e.code, null)
    }
    fleetCache.set(p.id, c)
  }
  return {
    peer_id: p.id,
    name: p.name,
    base_url: peerOrigin(p.base_url) ?? p.base_url,
    ok: c.error === null,
    error: c.error,
    error_text: c.error ? PEER_ERROR_WORDS[c.error] : null,
    stale: c.error !== null && c.ok !== null,
    fetched_at: c.ok ? new Date(c.ok.at).toISOString() : null,
    version: c.ok?.version ?? null,
    newest: c.ok?.newest ?? null,
    rows: c.ok?.rows ?? []
  }
}

/** Every enabled peer's fleet, read side by side. */
export async function federatedFleet(
  deps: FederationDeps = {},
  opts: { fresh?: boolean } = {}
): Promise<PeerFleet[]> {
  const peers = (await listPeers()).filter((p) => p.enabled)
  return Promise.all(peers.map((p) => readPeerFleet(p, deps, opts)))
}

export function forgetPeerCache(id: number): void {
  fleetCache.delete(id)
}

// ─── writes ──────────────────────────────────────────────────────────────────

export interface PeerInput {
  name: string
  base_url: string
  /** Plain key when a new one was sent; undefined = keep. */
  token?: string
  enabled: boolean
}

export function checkPeerInput(body: Record<string, unknown>, existing?: PeerRow): PeerInput {
  const name = body.name !== undefined ? plainText(body.name, 120) : (existing?.name ?? null)
  if (!name) throw new PlacementError('BAD_NAME', 'Give the other Hub a name.')
  const rawUrl = body.base_url !== undefined ? body.base_url : existing?.base_url
  const origin = peerOrigin(rawUrl)
  if (!origin)
    throw new PlacementError(
      'BAD_URL',
      'The other Hub’s address is its https origin (no path, query or credentials; plain http only to localhost outside production).'
    )
  let token: string | undefined
  if (body.token !== undefined && body.token !== HUB_MASK) {
    if (!tokenShapeOk(body.token))
      throw new PlacementError(
        'BAD_TOKEN',
        'Paste the API key made on the other Hub (20–400 characters, no spaces).'
      )
    token = body.token
  }
  if (!existing && !token)
    throw new PlacementError(
      'BAD_TOKEN',
      'Paste an API key made on the other Hub with the hub:read scope.'
    )
  // A new address needs its key again: never send an old key to a new origin.
  if (existing && !token && origin !== peerOrigin(existing.base_url))
    throw new PlacementError('TOKEN_REQUIRED', 'Enter the key again when the address changes.')
  const enabled = body.enabled !== undefined ? body.enabled === true : (existing?.enabled ?? true)
  return { name, base_url: origin, ...(token ? { token } : {}), enabled }
}

export async function createPeer(f: PeerInput, userId: string | null): Promise<PeerRow> {
  if (!f.token) throw new PlacementError('BAD_TOKEN', 'Paste an API key made on the other Hub.')
  if (await db(PEERS).where({ base_url: f.base_url }).first('id'))
    throw new PlacementError('PEER_EXISTS', 'That Hub is registered already.', 409)
  const now = new Date()
  const id = await insertReturningId(db, PEERS, {
    name: f.name,
    base_url: f.base_url,
    token: sealSecret(f.token),
    enabled: f.enabled,
    created_by: userId,
    created_at: now,
    updated_at: now
  })
  return (await getPeer(Number(id))) as PeerRow
}

export async function updatePeer(id: number, f: PeerInput): Promise<PeerRow | null> {
  const clash = (await db(PEERS).where({ base_url: f.base_url }).whereNot({ id }).first('id')) as
    | { id: number }
    | undefined
  if (clash) throw new PlacementError('PEER_EXISTS', 'That Hub is registered already.', 409)
  const n = await db(PEERS)
    .where({ id })
    .update({
      name: f.name,
      base_url: f.base_url,
      enabled: f.enabled,
      ...(f.token ? { token: sealSecret(f.token) } : {}),
      updated_at: new Date()
    })
  forgetPeerCache(id)
  return n ? getPeer(id) : null
}

export async function deletePeer(id: number): Promise<boolean> {
  forgetPeerCache(id)
  return (await db(PEERS).where({ id }).del()) > 0
}

/** The stored key of a peer, opened for one call (Check now). */
export function peerToken(p: PeerRow): string {
  try {
    return tokenOf(p)
  } catch (e) {
    if (e instanceof PeerReadError) throw new PlacementError(e.code, e.message, 409)
    throw e
  }
}
