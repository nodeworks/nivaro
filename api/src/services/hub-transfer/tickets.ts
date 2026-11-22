import { createHash, randomBytes } from 'node:crypto'
import { hubSharedConfig, isMultiTenant, isNivaroCloud, tenantSource } from '../deployment-mode.js'
import { hubLinkToken } from '../hub/mode.js'
import { hubLinkKeyTag } from '../hub-link/retire.js'
import { getApp } from '../io-holder.js'

/**
 * Transfer tickets (Hub phase 6, Decision 11). During a move the TARGET pulls every stored object
 * of the app from the SOURCE's `/api/hub-transfer/files/:id`. The source authorises those reads
 * with a ticket it minted on the Hub's request (`POST /api/hub-link/files/ticket` on a dedicated
 * app, `POST /api/hub-deployment/apps/:id/files/ticket` on a shared deployment); the Hub hands it
 * to the target with the pull.
 *
 *  - `nvt_` + 32 random bytes (base64url). Valid 6 h; reusable inside that window (a pull reads
 *    thousands of objects), never answered back, logged or put in an error.
 *  - Stored in the source's Redis as `nvr:hub-transfer:<sha256(ticket)>` → `{t, a, exp}`: only the
 *    hash is a key, so a Redis read never yields a usable ticket.
 *  - The ticket decides the app (ruling R16): `t` is the tenant it was minted for (null on a
 *    dedicated app). `a` binds it to the minting process: the shared deployment's key, or a hash
 *    of this dedicated app's HUB_TOKEN — two dedicated apps sharing one Redis database never
 *    accept each other's tickets.
 */

export const TRANSFER_TICKET_TTL_MS = 6 * 60 * 60 * 1000
/** `nvt_` + 32 bytes base64url (43 characters, no padding). */
export const TRANSFER_TICKET_RE = /^nvt_[A-Za-z0-9_-]{43}$/

export interface TicketRedis {
  set(key: string, value: string, mode: 'PX', ms: number): Promise<unknown>
  get(key: string): Promise<string | null>
}

/** Test seams. */
export const ticketDeps = {
  redis(): TicketRedis | null {
    try {
      return (getApp()?.redis as TicketRedis | undefined) ?? null
    } catch {
      return null
    }
  },
  now: (): number => Date.now()
}

export class TransferTicketError extends Error {
  readonly code = 'REDIS_UNAVAILABLE'
  constructor() {
    super('The transfer ticket could not be stored (Redis)')
    this.name = 'TransferTicketError'
  }
}

/** Where the transfer routes are mounted (routes/hub-transfer.ts): a hub-linked single app
 *  (HUB_TOKEN, as the hub link) or a Hub shared deployment; never Nivaro Cloud. */
export function hubTransferMounted(env: NodeJS.ProcessEnv = process.env): boolean {
  if (isNivaroCloud(env)) return false
  if (tenantSource(env) === 'hub') return true
  return !!hubLinkToken(env) && !isMultiTenant(env)
}

/** The Redis key of a ticket: its sha256 only (the ticket itself is never a key). */
export function ticketKey(ticket: string): string {
  return `nvr:hub-transfer:${createHash('sha256').update(ticket).digest('hex')}`
}

/** What a ticket minted here is bound to: this shared deployment, or this dedicated app. */
function minterTag(): string {
  if (tenantSource() === 'hub') return `shared:${hubSharedConfig()?.deployment ?? ''}`
  return `link:${hubLinkKeyTag()}`
}

/** Mint a 6 h transfer ticket for `tenantId` (null on a dedicated app). */
export async function mintTransferTicket(
  tenantId: string | null
): Promise<{ ticket: string; expires_at: string }> {
  const redis = ticketDeps.redis()
  if (!redis) throw new TransferTicketError()
  const ticket = `nvt_${randomBytes(32).toString('base64url')}`
  const exp = ticketDeps.now() + TRANSFER_TICKET_TTL_MS
  try {
    await redis.set(
      ticketKey(ticket),
      JSON.stringify({ t: tenantId, a: minterTag(), exp }),
      'PX',
      TRANSFER_TICKET_TTL_MS
    )
  } catch {
    throw new TransferTicketError()
  }
  return { ticket, expires_at: new Date(exp).toISOString() }
}

/**
 * The app a ticket was minted for, or `{ok: false}`: malformed, unknown, expired, minted by
 * another deployment or app, or Redis did not answer (fails closed).
 */
export async function ticketTenant(
  ticket: string
): Promise<{ ok: true; tenant: string | null } | { ok: false }> {
  if (typeof ticket !== 'string' || !TRANSFER_TICKET_RE.test(ticket)) return { ok: false }
  const redis = ticketDeps.redis()
  if (!redis) return { ok: false }
  let raw: string | null
  try {
    raw = await redis.get(ticketKey(ticket))
  } catch {
    return { ok: false }
  }
  if (!raw) return { ok: false }
  let v: { t?: unknown; a?: unknown; exp?: unknown }
  try {
    v = JSON.parse(raw) as typeof v
  } catch {
    return { ok: false }
  }
  if (typeof v.exp !== 'number' || !(v.exp > ticketDeps.now())) return { ok: false }
  if (v.a !== minterTag()) return { ok: false }
  if (v.t !== null && typeof v.t !== 'string') return { ok: false }
  return { ok: true, tenant: v.t }
}

/** `Authorization: Transfer <ticket>` → the ticket text, or null. */
export function transferTicketFromHeader(header: unknown): string | null {
  if (typeof header !== 'string') return null
  const m = /^Transfer\s+(\S+)$/.exec(header.trim())
  return m ? m[1] : null
}
