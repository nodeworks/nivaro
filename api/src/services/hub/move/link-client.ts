import { pullFailReasonsFrom } from '../../hub-transfer/fail-reasons.js'
import type { PullRequest, PullStatus } from '../shared/deployment-client.js'
import { parseReadiness } from './readiness-parse.js'

/**
 * Nivaro Hub phase 6, Task 16: the Hub's client for a DEDICATED app's hub link
 * (routes/hub-link.ts on the app, Tasks 9 and 10) — what a move needs from it:
 *
 *   GET    {base}/api/hub-link/status                 → {version, maintenance, retired, preflight}
 *   POST   {base}/api/hub-link/maintenance {on, move_id}
 *   POST   {base}/api/hub-link/retire {move_id}      DELETE {base}/api/hub-link/retire
 *   GET    {base}/api/hub-link/shared-readiness       → busy, key_fp, db_identity, files
 *   POST   {base}/api/hub-link/files/ticket           → {ticket, expires_at}
 *   DELETE {base}/api/hub-link/files/ticket {ticket}  → {revoked}            (T10 carry: revoke)
 *   POST   {base}/api/hub-link/files/pull             → {run_id}
 *   GET    {base}/api/hub-link/files/pull/:runId      → PullStatus
 *
 * Auth: `Authorization: Bearer <HUB_TOKEN>` (the environment's sealed hub token, opened by the
 * caller for the call). The token travels only in that header, so `base` must be https, or plain
 * http only to this machine or a .test / .localhost name (the phase-3 link-client rule). Every
 * call refuses redirects, is bounded (8 s; 15 s for the slow ones) and reads at most 2 MB. A
 * refusal is a HubLinkError with a short code and a plain sentence: never the token, a ticket,
 * the app's own message text or a driver error.
 */

export const HUB_LINK_TIMEOUT_MS = 8_000
const SLOW_MS = 15_000
const MAX_ANSWER_BYTES = 2 * 1024 * 1024
const CODE_RE = /^[A-Z][A-Z0-9_]{0,63}$/
const RUN_ID_RE = /^[A-Za-z0-9_-]{1,100}$/
const TICKET_RE = /^nvt_[A-Za-z0-9_-]{43}$/

export type HubLinkCode =
  | 'BAD_BASE_URL'
  | 'HUB_TOKEN_MISSING'
  | 'LINK_UNREACHABLE'
  | 'LINK_REFUSED'
  | 'LINK_MISSING'
  | 'LINK_BAD_ANSWER'
  /** The app answered a refusal with its own code (`reason`). */
  | 'LINK_SAID_NO'

const MESSAGES: Record<HubLinkCode, string> = {
  BAD_BASE_URL:
    "The app's address is not one the Hub sends its token to (https, or plain http only to this machine).",
  HUB_TOKEN_MISSING: 'The Hub holds no hub token for this environment.',
  LINK_UNREACHABLE: 'The app did not answer on its hub link.',
  LINK_REFUSED: 'The app refused the Hub on its hub link (check its HUB_TOKEN).',
  LINK_MISSING:
    'The address answers but has no hub link (no HUB_TOKEN there, or a Nivaro version without these routes).',
  LINK_BAD_ANSWER: 'The app answered its hub link with something the Hub cannot read.',
  LINK_SAID_NO: 'The app refused the request.'
}

export class HubLinkError extends Error {
  code: HubLinkCode
  status: number
  /** The app's own refusal code, when it sent one (code-shaped only). */
  reason: string | null
  constructor(code: HubLinkCode, status = 0, reason: string | null = null) {
    super(reason ? `${MESSAGES[code]} (${reason})` : MESSAGES[code])
    this.name = 'HubLinkError'
    this.code = code
    this.status = status
    this.reason = reason
  }
}

export interface HubLinkStatus {
  version: string
  maintenance: boolean | null
  retired: boolean
  preflight: { status: string; failing: string[] }
}

export interface HubLinkReadiness {
  key_fp: string | null
  busy: { imports: number; exports: number; renders: number }
  files: { count: number; bytes: number; local: number; objects?: Record<string, number> }
  db_identity: string | null
  version: string | null
}

/** What the source said it carried (names only; absent = an app before 0.3.215). */
export interface MaintenanceAnswer {
  instance_row: { result: string; keys: string[]; differed: string[] } | null
  env_mail: string | null
}

const strList = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, 200) : []

export interface HubLinkClient {
  status(): Promise<HubLinkStatus>
  /** `carry` (0.3.215, a move to a shared deployment): the source first copies its per-instance
   *  settings row to the row keyed `targetInstance`, and with `keepEnvMail` the mail settings it
   *  takes from its environment into that row (an older app ignores both: its answer then has
   *  neither `instance_row` nor `env_mail`). */
  maintenance(
    on: boolean,
    moveId: number,
    message?: string,
    carry?: { targetInstance: string; keepEnvMail?: boolean },
    /** Hub placement (review C1): only the move's new stack may take it (NOT_THE_MOVE_TARGET). */
    opts?: { onlyTarget?: boolean }
  ): Promise<MaintenanceAnswer>
  retire(moveId: number): Promise<void>
  unretire(): Promise<void>
  sharedReadiness(): Promise<HubLinkReadiness>
  fileTicket(): Promise<{ ticket: string; expires_at: string }>
  revokeTicket(ticket: string): Promise<{ revoked: boolean }>
  pullFiles(req: PullRequest): Promise<{ run_id: string }>
  pullStatus(runId: string): Promise<PullStatus>
  /**
   * Hub gap sqlite: START fetching, checking and staging the source's database (a job; the app
   * restarts once the Hub has read its end). Review 4 N3: start-then-poll.
   */
  pullDatabase?(req: {
    source: string
    ticket: string
    move_id: number
  }): Promise<DatabaseJobStatus>
  /** Hub gap sqlite: what this app installed at its last boot, or null. */
  databaseAdopted?(): Promise<{ sha256: string; move_id: number | null } | null>
  /** Hub gap sqlite: START this app's database checksum (a job; review 4 N2). */
  databaseSum?(): Promise<DatabaseJobStatus>
  /** Hub gap sqlite: a database job now; null = this process does not know it (it restarted). */
  databaseJob?(id: string): Promise<DatabaseJobStatus | null>
  /** Review 5 M1: the Hub gave up on a job — a running pull is aborted, nothing staged. */
  cancelDatabaseJob?(id: string): Promise<{ cancelled: boolean }>
  /** Review 5 L6: why this app's last boot refused a staged copy, or null. */
  databaseAdoptRefused?(): Promise<{ move_id: number | null; code: string } | null>
}

/** A database job as a link answers it (services/hub-transfer/database-jobs.ts). */
export interface DatabaseJobStatus {
  id: string
  state: 'running' | 'done' | 'failed'
  result: unknown
  code: string | null
  message: string | null
}

const JOB_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
/** `{job}` as a link answers it, or null. */
export function parseDatabaseJob(b: unknown): DatabaseJobStatus | null {
  const j = (b as { job?: unknown } | null)?.job as Record<string, unknown> | undefined
  if (!j || typeof j !== 'object') return null
  if (typeof j.id !== 'string' || !JOB_ID_RE.test(j.id)) return null
  if (j.state !== 'running' && j.state !== 'done' && j.state !== 'failed') return null
  return {
    id: j.id,
    state: j.state,
    result: j.result ?? null,
    code: typeof j.code === 'string' && CODE_RE.test(j.code) ? j.code : null,
    message: typeof j.message === 'string' ? j.message.slice(0, 300) : null
  }
}

/** A checksum job's result, or null. */
export function parseDatabaseSum(r: unknown): { sha256: string; bytes: number } | null {
  const o = r as { sha256?: unknown; bytes?: unknown } | null
  if (typeof o?.sha256 !== 'string' || !SHA_RE.test(o.sha256)) return null
  if (typeof o.bytes !== 'number' || !Number.isSafeInteger(o.bytes) || o.bytes < 0) return null
  return { sha256: o.sha256, bytes: o.bytes }
}

/** What a target answers for a database copy (hub gap sqlite). */
export interface DatabaseCopied {
  sha256: string
  bytes: number
  migrations: number
}

/**
 * How long the Hub waits for a database copy job (review 4 N3): longer than the target's own
 * deadline (SQLITE_PULL_DEADLINE_MS, 25 min), so the target always ends a copy first and says why.
 */
export const DATABASE_COPY_TIMEOUT_MS = 30 * 60_000

/** How long the Hub waits for a checksum job (review 4 N2): checkpoint wait + hashing 8 GiB. */
export const DATABASE_SUM_TIMEOUT_MS = 20 * 60_000

const SHA_RE = /^[0-9a-f]{64}$/

/** A copy answer as the Hub reads it, or null. */
export function parseDatabaseCopied(b: unknown): DatabaseCopied | null {
  if (!b || typeof b !== 'object') return null
  const o = b as Record<string, unknown>
  const v = (o.verified ?? {}) as Record<string, unknown>
  if (typeof o.sha256 !== 'string' || !SHA_RE.test(o.sha256)) return null
  if (typeof o.bytes !== 'number' || !Number.isSafeInteger(o.bytes) || o.bytes <= 0) return null
  if (v.integrity !== 'ok' || typeof v.migrations !== 'number' || v.migrations <= 0) return null
  return { sha256: o.sha256, bytes: o.bytes, migrations: v.migrations }
}

function plainHttpHost(hostname: string): boolean {
  const h = hostname.toLowerCase()
  return (
    h === 'localhost' ||
    h === '127.0.0.1' ||
    h === '[::1]' ||
    h.endsWith('.localhost') ||
    h.endsWith('.test')
  )
}

/** The origin the Hub may send the hub token to, or null. */
export function hubLinkOrigin(raw: string): string | null {
  try {
    const u = new URL(String(raw ?? '').trim())
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
    if (u.username || u.password) return null
    if (u.protocol === 'http:' && !plainHttpHost(u.hostname)) return null
    return u.origin
  } catch {
    return null
  }
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v)
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const isStr = (v: unknown): v is string => typeof v === 'string'

async function readCapped(res: Response): Promise<string | null> {
  if (!res.body) return ''
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > MAX_ANSWER_BYTES) {
      void reader.cancel().catch(() => {})
      return null
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString('utf8')
}

export interface HubLinkDeps {
  fetch?: typeof fetch
  timeoutMs?: number
}

export function hubLinkClient(
  baseUrl: string,
  token: string | null,
  deps: HubLinkDeps = {}
): HubLinkClient {
  const doFetch = deps.fetch ?? fetch

  async function call(
    path: string,
    method: 'GET' | 'POST' | 'DELETE',
    body?: unknown,
    slow = false,
    timeoutMs?: number
  ): Promise<{ status: number; body: unknown }> {
    const base = hubLinkOrigin(baseUrl)
    if (!base) throw new HubLinkError('BAD_BASE_URL')
    const bearer = typeof token === 'string' ? token.trim() : ''
    if (!bearer) throw new HubLinkError('HUB_TOKEN_MISSING')
    const ms = deps.timeoutMs ?? timeoutMs ?? (slow ? SLOW_MS : HUB_LINK_TIMEOUT_MS)
    const ctl = new AbortController()
    let timer: NodeJS.Timeout | undefined
    const run = async () => {
      const res = await doFetch(`${base}/api/hub-link${path}`, {
        method,
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${bearer}`,
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {})
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        redirect: 'error',
        signal: ctl.signal
      })
      if (res.status >= 300 && res.status < 400) {
        void res.body?.cancel().catch(() => {})
        throw new HubLinkError('LINK_REFUSED', res.status, 'REDIRECT')
      }
      const text = await readCapped(res)
      if (text === null) throw new HubLinkError('LINK_BAD_ANSWER', res.status)
      let parsed: unknown = null
      if (text) {
        try {
          parsed = JSON.parse(text)
        } catch {
          parsed = undefined
        }
      }
      return { status: res.status, body: parsed }
    }
    try {
      return await Promise.race([
        run(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            ctl.abort()
            reject(new HubLinkError('LINK_UNREACHABLE'))
          }, ms)
        })
      ])
    } catch (err) {
      if (err instanceof HubLinkError) throw err
      throw new HubLinkError('LINK_UNREACHABLE')
    } finally {
      clearTimeout(timer)
    }
  }

  const ok = (a: { status: number }) => a.status >= 200 && a.status < 300

  function refusal(a: { status: number; body: unknown }): HubLinkError {
    const c = (a.body as { code?: unknown } | null)?.code
    const code = typeof c === 'string' && CODE_RE.test(c) ? c : null
    if (a.status === 401 || a.status === 403 || a.status === 429 || code === 'HUB_LINK_REFUSED')
      return new HubLinkError('LINK_REFUSED', a.status)
    if (a.status === 404 && (!code || code === 'NOT_FOUND'))
      return new HubLinkError('LINK_MISSING', a.status)
    if (code) return new HubLinkError('LINK_SAID_NO', a.status, code)
    return new HubLinkError('LINK_BAD_ANSWER', a.status)
  }

  return {
    async status() {
      const a = await call('/status', 'GET')
      if (!ok(a)) throw refusal(a)
      const b = a.body
      if (!isObj(b) || !isStr(b.version) || !isObj(b.preflight))
        throw new HubLinkError('LINK_BAD_ANSWER', a.status)
      const pf = b.preflight as Record<string, unknown>
      return {
        version: b.version.slice(0, 64),
        maintenance: typeof b.maintenance === 'boolean' ? b.maintenance : null,
        retired: b.retired === true,
        preflight: {
          status: isStr(pf.status) ? pf.status.slice(0, 32) : 'unknown',
          failing: Array.isArray(pf.failing)
            ? pf.failing
                .filter(isStr)
                .map((x) => x.slice(0, 100))
                .slice(0, 50)
            : []
        }
      }
    },

    async maintenance(on, moveId, message, carry, opts) {
      const a = await call('/maintenance', 'POST', {
        on,
        move_id: moveId,
        ...(opts?.onlyTarget ? { only_target: true } : {}),
        ...(message ? { message } : {}),
        ...(on && carry ? { target_instance: carry.targetInstance } : {}),
        ...(on && carry?.keepEnvMail ? { keep_env_mail: true } : {})
      })
      if (!ok(a)) throw refusal(a)
      const b = (isObj(a.body) ? a.body : {}) as Record<string, unknown>
      const r = isObj(b.instance_row) ? (b.instance_row as Record<string, unknown>) : null
      return {
        instance_row: r
          ? {
              result: typeof r.result === 'string' ? r.result.slice(0, 20) : 'unknown',
              keys: strList(r.keys),
              differed: strList(r.differed)
            }
          : null,
        env_mail: typeof b.env_mail === 'string' ? b.env_mail.slice(0, 20) : null
      }
    },

    async retire(moveId) {
      const a = await call('/retire', 'POST', { move_id: moveId })
      if (!ok(a)) throw refusal(a)
    },

    async unretire() {
      const a = await call('/retire', 'DELETE')
      if (!ok(a)) throw refusal(a)
    },

    async sharedReadiness() {
      const a = await call('/shared-readiness', 'GET', undefined, true)
      if (!ok(a)) throw refusal(a)
      // R2-M-9: the plan's own parser; a report it refuses is never read as idle here.
      const r = parseReadiness(a.body)
      if (!r) throw new HubLinkError('LINK_BAD_ANSWER', a.status)
      return {
        key_fp: r.key_fp,
        busy: r.busy,
        files: r.files,
        db_identity: r.db_identity,
        version: r.version
      }
    },

    async fileTicket() {
      const a = await call('/files/ticket', 'POST', {})
      if (!ok(a)) throw refusal(a)
      const b = a.body
      if (!isObj(b) || !isStr(b.ticket) || !TICKET_RE.test(b.ticket) || !isStr(b.expires_at))
        throw new HubLinkError('LINK_BAD_ANSWER', a.status)
      return { ticket: b.ticket, expires_at: b.expires_at }
    },

    async revokeTicket(ticket) {
      if (typeof ticket !== 'string' || !TICKET_RE.test(ticket))
        throw new HubLinkError('LINK_SAID_NO', 0, 'BAD_TICKET')
      const a = await call('/files/ticket', 'DELETE', { ticket })
      if (!ok(a)) throw refusal(a)
      const r = (a.body as { revoked?: unknown } | null)?.revoked
      if (typeof r !== 'boolean') throw new HubLinkError('LINK_BAD_ANSWER', a.status)
      return { revoked: r }
    },

    async pullFiles(req) {
      const a = await call('/files/pull', 'POST', {
        source: req.source,
        ticket: req.ticket,
        mode: req.mode,
        ...(req.objects ? { objects: true } : {}),
        ...(req.env_objects ? { env_objects: true } : {}),
        ...(req.replays ? { replays: true } : {}),
        ...(req.source_scope ? { source_scope: req.source_scope } : {})
      })
      if (!ok(a)) throw refusal(a)
      const b = a.body
      if (!isObj(b) || !isStr(b.run_id) || !RUN_ID_RE.test(b.run_id))
        throw new HubLinkError('LINK_BAD_ANSWER', a.status)
      return { run_id: b.run_id }
    },

    async pullDatabase(req) {
      const a = await call(
        '/files/database/pull',
        'POST',
        { source: req.source, ticket: req.ticket, move_id: req.move_id },
        true
      )
      if (!ok(a)) throw refusal(a)
      const j = parseDatabaseJob(a.body)
      if (!j) throw new HubLinkError('LINK_BAD_ANSWER', a.status)
      return j
    },

    async databaseJob(id) {
      if (!JOB_ID_RE.test(id)) throw new HubLinkError('LINK_SAID_NO', 0, 'BAD_JOB_ID')
      const a = await call(`/files/database/jobs/${id}`, 'GET')
      // Review 5 L1: only the app's own "no such job" — a proxy's 404 (no healthy task yet) is a
      // read that failed, tried again within the follow's limit.
      if (a.status === 404 && (a.body as { code?: unknown } | null)?.code === 'UNKNOWN_JOB')
        return null
      if (!ok(a)) throw refusal(a)
      const j = parseDatabaseJob(a.body)
      if (!j) throw new HubLinkError('LINK_BAD_ANSWER', a.status)
      return j
    },

    async cancelDatabaseJob(id) {
      if (!JOB_ID_RE.test(id)) throw new HubLinkError('LINK_SAID_NO', 0, 'BAD_JOB_ID')
      const a = await call(`/files/database/jobs/${id}`, 'DELETE', undefined, true)
      if (!ok(a)) throw refusal(a)
      return { cancelled: (a.body as { cancelled?: unknown } | null)?.cancelled === true }
    },

    async databaseAdoptRefused() {
      const a = await call('/files/database/adopted', 'GET')
      if (!ok(a)) throw refusal(a)
      const r = (a.body as { refused?: unknown } | null)?.refused as
        | { move_id?: unknown; code?: unknown }
        | null
        | undefined
      if (!r || typeof r.code !== 'string' || !CODE_RE.test(r.code)) return null
      return { move_id: typeof r.move_id === 'number' ? r.move_id : null, code: r.code }
    },

    async databaseAdopted() {
      const a = await call('/files/database/adopted', 'GET')
      if (!ok(a)) throw refusal(a)
      const ad = (a.body as { adopted?: unknown } | null)?.adopted
      if (ad === null || ad === undefined) return null
      const o = ad as { sha256?: unknown; move_id?: unknown }
      if (typeof o.sha256 !== 'string' || !SHA_RE.test(o.sha256))
        throw new HubLinkError('LINK_BAD_ANSWER', a.status)
      return { sha256: o.sha256, move_id: typeof o.move_id === 'number' ? o.move_id : null }
    },

    async databaseSum() {
      const a = await call('/files/database/sum', 'POST', {}, true)
      if (!ok(a)) throw refusal(a)
      const j = parseDatabaseJob(a.body)
      if (!j) throw new HubLinkError('LINK_BAD_ANSWER', a.status)
      return j
    },

    async pullStatus(runId) {
      if (typeof runId !== 'string' || !RUN_ID_RE.test(runId))
        throw new HubLinkError('LINK_SAID_NO', 0, 'BAD_RUN_ID')
      const a = await call(`/files/pull/${runId}`, 'GET')
      if (!ok(a)) throw refusal(a)
      const b = a.body
      if (
        !isObj(b) ||
        !['running', 'done', 'failed'].includes(String(b.state)) ||
        !isNum(b.total) ||
        !isNum(b.copied) ||
        !isNum(b.skipped) ||
        !isNum(b.failed) ||
        !Array.isArray(b.missing) ||
        !isNum(b.bytes)
      )
        throw new HubLinkError('LINK_BAD_ANSWER', a.status)
      return {
        state: b.state as PullStatus['state'],
        total: b.total,
        copied: b.copied,
        skipped: b.skipped,
        failed: b.failed,
        missing: (b.missing as unknown[]).filter(isStr).slice(0, 50),
        bytes: b.bytes,
        error: isStr(b.error) ? b.error.slice(0, 300) : null,
        size_mismatch: isNum(b.size_mismatch) ? b.size_mismatch : 0,
        server_copied: isNum(b.server_copied) ? b.server_copied : 0,
        failed_ids: Array.isArray(b.failed_ids)
          ? (b.failed_ids as unknown[]).filter(isStr).slice(0, 50)
          : [],
        failed_reasons: pullFailReasonsFrom(b.failed_reasons)
      }
    }
  }
}
