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
    carry?: { targetInstance: string; keepEnvMail?: boolean }
  ): Promise<MaintenanceAnswer>
  retire(moveId: number): Promise<void>
  unretire(): Promise<void>
  sharedReadiness(): Promise<HubLinkReadiness>
  fileTicket(): Promise<{ ticket: string; expires_at: string }>
  revokeTicket(ticket: string): Promise<{ revoked: boolean }>
  pullFiles(req: PullRequest): Promise<{ run_id: string }>
  pullStatus(runId: string): Promise<PullStatus>
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
    slow = false
  ): Promise<{ status: number; body: unknown }> {
    const base = hubLinkOrigin(baseUrl)
    if (!base) throw new HubLinkError('BAD_BASE_URL')
    const bearer = typeof token === 'string' ? token.trim() : ''
    if (!bearer) throw new HubLinkError('HUB_TOKEN_MISSING')
    const ms = deps.timeoutMs ?? (slow ? SLOW_MS : HUB_LINK_TIMEOUT_MS)
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

    async maintenance(on, moveId, message, carry) {
      const a = await call('/maintenance', 'POST', {
        on,
        move_id: moveId,
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
        ...(req.objects ? { objects: true } : {})
      })
      if (!ok(a)) throw refusal(a)
      const b = a.body
      if (!isObj(b) || !isStr(b.run_id) || !RUN_ID_RE.test(b.run_id))
        throw new HubLinkError('LINK_BAD_ANSWER', a.status)
      return { run_id: b.run_id }
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
        failed_ids: Array.isArray(b.failed_ids)
          ? (b.failed_ids as unknown[]).filter(isStr).slice(0, 50)
          : [],
        failed_reasons: pullFailReasonsFrom(b.failed_reasons)
      }
    }
  }
}
