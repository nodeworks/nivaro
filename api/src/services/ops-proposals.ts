import { randomUUID } from 'node:crypto'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { Redis } from 'ioredis'
import { adminBaseUrl } from '../admin-base.js'
import { config } from '../config.js'
import { db } from '../db/index.js'
import { getTenantId } from '../db/tenant-context.js'
import type { User } from '../types.js'
import { logActivity } from './activity.js'

/**
 * Ops actions the chat assistant proposes (#2015): pause a background job,
 * open a circuit breaker on a noisy caller, retry a failed partner push, turn
 * incident mode on or off. A proposal is a card in the admin-only channel
 * (a link the chat renders as an approval card for administrators only).
 *
 * Nothing runs until an administrator approves. Approval dispatches the SAME
 * admin route a person would use (in-process, with the approver's own
 * credential), so that route's own checks — admin, validation, self-break
 * refusal — judge the approver at that moment. One approval per proposal (a
 * Redis claim); every approval and dismissal is logged as activity.
 *
 * Proposals live 24 hours in Redis (per tenant), with an in-process copy so a
 * dev box without Redis still works.
 */

export type OpsAction = 'pause_job' | 'open_breaker' | 'retry_push' | 'incident_mode'
export const OPS_ACTIONS: readonly OpsAction[] = [
  'pause_job',
  'open_breaker',
  'retry_push',
  'incident_mode'
]

export interface OpsProposal {
  id: string
  action: OpsAction
  params: Record<string, unknown>
  reason: string
  summary: string
  room: string
  message_id: number | null
  proposed_by: string
  proposed_at: string
  status: 'pending' | 'approved' | 'failed' | 'dismissed'
  decided_by: string | null
  decided_by_name: string | null
  decided_at: string | null
  result: { status: number; ok: boolean; message: string | null } | null
}

const TTL_SECONDS = 24 * 60 * 60
const memory = new Map<string, { at: number; value: OpsProposal }>()
const memoryClaims = new Set<string>()

function redisOf(app: FastifyInstance): Redis | null {
  return ((app as FastifyInstance & { redis?: Redis }).redis ?? null) as Redis | null
}
function keyOf(id: string, suffix = ''): string {
  const tenant = getTenantId()
  return `nvr:${tenant ? `t:${tenant}:` : ''}ops:proposal:${id}${suffix}`
}

export async function saveProposal(app: FastifyInstance, p: OpsProposal): Promise<void> {
  memory.set(keyOf(p.id), { at: Date.now(), value: p })
  for (const [k, v] of memory) if (Date.now() - v.at > TTL_SECONDS * 1000) memory.delete(k)
  const redis = redisOf(app)
  if (!redis) return
  try {
    await redis.set(keyOf(p.id), JSON.stringify(p), 'EX', TTL_SECONDS)
  } catch {
    // memory copy stands
  }
}

export async function loadProposal(app: FastifyInstance, id: string): Promise<OpsProposal | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null
  const redis = redisOf(app)
  if (redis) {
    try {
      const raw = await redis.get(keyOf(id))
      if (raw) return JSON.parse(raw) as OpsProposal
    } catch {
      // fall through
    }
  }
  return memory.get(keyOf(id))?.value ?? null
}

/** One decision per proposal, across replicas. */
async function claim(app: FastifyInstance, id: string): Promise<boolean> {
  const redis = redisOf(app)
  if (redis) {
    try {
      return (await redis.set(keyOf(id, ':claim'), '1', 'EX', TTL_SECONDS, 'NX')) === 'OK'
    } catch {
      // fall back to this process
    }
  }
  if (memoryClaims.has(keyOf(id))) return false
  memoryClaims.add(keyOf(id))
  return true
}

const CALLER_RE = /^(k\d{1,12}|u[0-9A-F-]{36})$/
const ENTITY_RE = /^[a-z]+\/[A-Za-z0-9_][A-Za-z0-9_.-]{0,119}$/

/**
 * The model's proposal input, checked: the target must exist and the action
 * must make sense now. Throws a sentence the assistant can relay.
 */
export async function validateProposal(
  app: FastifyInstance,
  input: Record<string, unknown>
): Promise<{
  action: OpsAction
  params: Record<string, unknown>
  summary: string
  reason: string
}> {
  const action = String(input.action ?? '') as OpsAction
  if (!OPS_ACTIONS.includes(action)) throw new Error('Unknown action')
  const reason = String(input.reason ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300)
  if (!reason) throw new Error('A reason is required')
  if (action === 'pause_job') {
    const jobId = String(input.job_id ?? '').trim()
    const crons = (
      app as FastifyInstance & { cron?: { list(): Array<{ id: string; paused?: boolean }> } }
    ).cron
    const job = crons?.list().find((j) => j.id === jobId)
    if (!job) throw new Error(`No scheduled job "${jobId}"`)
    if (job.paused) throw new Error(`Job "${jobId}" is already paused`)
    return {
      action,
      params: { job_id: jobId },
      summary: `Pause the background job ${jobId}`,
      reason
    }
  }
  if (action === 'open_breaker') {
    const kind = input.target_kind === 'entity' ? 'entity' : 'caller'
    let target = String(input.target ?? '').trim()
    if (kind === 'caller' && /^u/i.test(target)) target = `u${target.slice(1).toUpperCase()}`
    if (!(kind === 'caller' ? CALLER_RE : ENTITY_RE).test(target))
      throw new Error(
        kind === 'caller'
          ? 'A caller target is "k<keyId>" or "u<USER-UUID>"'
          : 'An entity target is "<lane>/<entity>"'
      )
    const mode = input.mode === 'limit' ? 'limit' : 'refuse'
    const minutes = Math.min(24 * 60, Math.max(1, Math.round(Number(input.minutes) || 30)))
    const limit =
      mode === 'limit'
        ? Math.min(100_000, Math.max(1, Math.round(Number(input.limit) || 60)))
        : null
    return {
      action,
      params: { kind, target, mode, minutes, limit },
      summary:
        mode === 'refuse'
          ? `Refuse every request from ${kind} ${target} for ${minutes} min`
          : `Limit ${kind} ${target} to ${limit}/min for ${minutes} min`,
      reason
    }
  }
  if (action === 'retry_push') {
    const id = Number(input.submission_id)
    if (!Number.isInteger(id) || id < 1) throw new Error('submission_id is required')
    const row = (await db('nivaro_erp_submissions')
      .where({ id })
      .first('id', 'collection', 'status')
      .catch(() => undefined)) as { collection?: string; status?: string } | undefined
    if (!row) throw new Error(`No partner submission #${id}`)
    if (!['failed', 'rejected'].includes(String(row.status)))
      throw new Error(`Submission #${id} is ${row.status}, not failed`)
    return {
      action,
      params: { submission_id: id },
      summary: `Retry the failed partner push #${id} (${row.collection})`,
      reason
    }
  }
  const on = input.incident_on !== false
  const title = String(input.title ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200)
  return {
    action,
    params: { on, title: title || null },
    summary: on ? `Turn incident mode on${title ? `: ${title}` : ''}` : 'End incident mode',
    reason
  }
}

/** The link the chat turns into the approval card (admins only — see chat-app-card.ts). */
export function proposalLink(id: string): string {
  const base = adminBaseUrl() ?? config.PUBLIC_URL ?? ''
  return `${String(base).replace(/\/$/, '')}/ops-console?proposal=${id}`
}

export async function createProposal(
  app: FastifyInstance,
  asker: User,
  room: string,
  input: Record<string, unknown>
): Promise<OpsProposal> {
  const v = await validateProposal(app, input)
  const p: OpsProposal = {
    id: randomUUID(),
    ...v,
    room,
    message_id: null,
    proposed_by: String(asker.id),
    proposed_at: new Date().toISOString(),
    status: 'pending',
    decided_by: null,
    decided_by_name: null,
    decided_at: null,
    result: null
  }
  const { postAsAssistant } = await import('./ops-incidents.js')
  p.message_id = await postAsAssistant(
    app,
    room,
    `Approval needed: ${p.summary}.\nWhy: ${p.reason}\n${proposalLink(p.id)}`
  )
  await saveProposal(app, p)
  await logActivity({
    action: 'ops-proposal-create',
    user: asker.id,
    comment: `${p.summary} — ${p.reason}`
  })
  return p
}

/** The admin route an approved proposal dispatches. */
export function routeFor(p: Pick<OpsProposal, 'action' | 'params' | 'reason'>): {
  method: 'POST'
  url: string
  body: Record<string, unknown>
} {
  const q = p.params
  switch (p.action) {
    case 'pause_job':
      return {
        method: 'POST',
        url: `/api/cron/${encodeURIComponent(String(q.job_id))}/pause`,
        body: {}
      }
    case 'open_breaker':
      return {
        method: 'POST',
        url: '/api/traffic-map/breakers',
        body: {
          kind: q.kind,
          target: q.target,
          mode: q.mode,
          minutes: q.minutes,
          ...(q.mode === 'limit' ? { limit: q.limit } : {}),
          reason: `Ops assistant: ${p.reason}`.slice(0, 300)
        }
      }
    case 'retry_push':
      return {
        method: 'POST',
        url: `/api/erp-submissions/${Number(q.submission_id)}/retry`,
        body: {}
      }
    default:
      return {
        method: 'POST',
        url: '/api/ops-assistant/incident',
        body: { on: q.on !== false, title: q.title ?? null, reason: p.reason }
      }
  }
}

/**
 * Headers for the in-process dispatch: the approver's own credential, and
 * the host they came in on — cloud resolves the tenant from the host, so
 * without it the injected request fails closed.
 */
export function approvalHeaders(
  h: Record<string, string | string[] | undefined>,
  proposalId: string
): Record<string, string> {
  const out: Record<string, string> = {
    'content-type': 'application/json',
    'x-nivaro-ops-proposal': proposalId
  }
  for (const k of ['authorization', 'cookie', 'host', 'x-forwarded-host', 'x-forwarded-proto']) {
    const v = h[k]
    if (typeof v === 'string' && v) out[k] = v
  }
  return out
}

export class ProposalError extends Error {
  constructor(
    public statusCode: number,
    message: string
  ) {
    super(message)
  }
}

const nameOf = (u: Record<string, unknown> | undefined | null) =>
  `${u?.first_name ?? ''} ${u?.last_name ?? ''}`.trim() || String(u?.email ?? 'an administrator')

/**
 * Approve (run) or dismiss. The caller's route is requireAdmin; the approver
 * is read again here, and the action runs as them through its own route.
 */
export async function decideProposal(
  app: FastifyInstance,
  req: FastifyRequest,
  id: string,
  decision: 'approve' | 'dismiss'
): Promise<OpsProposal> {
  const p = await loadProposal(app, id)
  if (!p) throw new ProposalError(404, 'This proposal has expired or does not exist')
  if (p.status !== 'pending') throw new ProposalError(409, `Already ${p.status}`)
  const { isActiveAdmin, opsRoomVerdict } = await import('./ops-assistant.js')
  if (!(await isActiveAdmin(String(req.user?.id))))
    throw new ProposalError(403, 'Only an administrator can decide this')
  if (!(await claim(app, id))) throw new ProposalError(409, 'Someone else already decided this')

  const who = req.user as unknown as Record<string, unknown>
  p.decided_by = String(req.user?.id)
  p.decided_by_name = nameOf(who)
  p.decided_at = new Date().toISOString()

  let line: string
  if (decision === 'dismiss') {
    p.status = 'dismissed'
    line = `Dismissed by ${p.decided_by_name}: ${p.summary}.`
  } else {
    const r = routeFor(p)
    const headers = approvalHeaders(req.headers, p.id)
    let status = 500
    let message: string | null = null
    try {
      const res = await app.inject({
        method: r.method,
        url: r.url,
        headers,
        payload: JSON.stringify(r.body)
      })
      status = res.statusCode
      if (status >= 400) {
        try {
          message = String((JSON.parse(res.body) as { error?: string }).error ?? '').slice(0, 300)
        } catch {
          message = res.body.slice(0, 300)
        }
      }
    } catch (err) {
      message = err instanceof Error ? err.message : String(err)
    }
    const ok = status < 400
    p.status = ok ? 'approved' : 'failed'
    p.result = { status, ok, message }
    line = ok
      ? `Approved by ${p.decided_by_name} and done: ${p.summary}.`
      : `Approved by ${p.decided_by_name} but it did not run (${status}${message ? `: ${message}` : ''}): ${p.summary}.`
    const { noteIncidentAction } = await import('./ops-incidents.js')
    await noteIncidentAction(app, line).catch(() => undefined)
  }
  await saveProposal(app, p)
  await logActivity({
    action: decision === 'dismiss' ? 'ops-proposal-dismiss' : 'ops-proposal-approve',
    user: req.user?.id,
    comment: `${p.summary} — ${p.reason}${p.result ? ` → ${p.result.status}` : ''}`,
    req
  })
  // The outcome goes back to the room only while it is still admin-only.
  if ((await opsRoomVerdict(p.room)).ok) {
    const { postAsAssistant } = await import('./ops-incidents.js')
    await postAsAssistant(app, p.room, line, p.message_id).catch(() => null)
  }
  return p
}

export type OpsProposalCard = ReturnType<typeof proposalCard>

/** What the approval card shows (admins only; the caller checks). */
export function proposalCard(p: OpsProposal) {
  return {
    kind: 'ops-proposal' as const,
    id: p.id,
    action: p.action,
    summary: p.summary,
    reason: p.reason,
    status: p.status,
    proposed_at: p.proposed_at,
    decided_by_name: p.decided_by_name,
    decided_at: p.decided_at,
    result: p.result
  }
}

export async function proposalCardFor(userId: string, id: string): Promise<OpsProposalCard | null> {
  const { getApp } = await import('./io-holder.js')
  const app = getApp() as FastifyInstance | null
  if (!app) return null
  const { isActiveAdmin } = await import('./ops-assistant.js')
  if (!(await isActiveAdmin(userId))) return null
  const p = await loadProposal(app, id)
  return p ? proposalCard(p) : null
}
