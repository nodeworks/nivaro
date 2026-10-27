import type { FastifyInstance } from 'fastify'
import { db } from '../../db/index.js'
import { applyApprovalDecision } from '../../routes/approvals.js'
import type { User } from '../../types.js'
import { isAdminUser } from '../ai-plan-steps.js'
import { recordLink } from '../app-links.js'
import {
  assertInstanceAccess,
  InstanceAccessError,
  instanceAccessAllowed
} from '../instance-guard.js'
import { acknowledgeNotification } from '../notification-ack.js'
import { runRecordTransition } from '../record-transition.js'
import { maintenanceState } from '../security.js'
import { userTimeZone } from '../user-time.js'
import type { TeamsActivity } from './activity.js'
import { type AdaptiveCard, resultCard } from './cards.js'
import { connectCard } from './connect-card.js'
import { resolveTeamsUser } from './links.js'

// Action.Execute handler (spec §6.1, §8). Every action runs AS the linked sender through the same
// services the web app uses; the nonce only stops double presses — it is not a secret.

const NONCE_TTL_S = 7 * 24 * 3600
const NONCE_MAX = 5000
const PENDING = '__pending__'
const PENDING_TTL_S = 60
const POLL_STEP_MS = 250
const POLL_MAX_MS = 8000
const KEY = (n: string) => `nvr:teams:nonce:${n}`

type RedisLike = {
  set: (...a: unknown[]) => Promise<unknown>
  get: (k: string) => Promise<string | null>
  del: (k: string) => Promise<unknown>
}
const redisOf = (app: FastifyInstance) => (app as { redis?: RedisLike }).redis

const local = new Map<string, string>()

/** Claims the nonce; null = ours, otherwise the stored value of whoever claimed it first. */
async function claim(app: FastifyInstance, nonce: string): Promise<string | null> {
  const redis = redisOf(app)
  if (redis) {
    try {
      if ((await redis.set(KEY(nonce), PENDING, 'EX', PENDING_TTL_S, 'NX')) === 'OK') return null
      return (await redis.get(KEY(nonce))) ?? PENDING
    } catch {
      // Redis trouble: this process's memory still stops same-process repeats.
    }
  }
  const held = local.get(nonce)
  if (held !== undefined) return held
  local.set(nonce, PENDING)
  if (local.size > NONCE_MAX) local.delete(local.keys().next().value as string)
  return null
}

async function store(app: FastifyInstance, nonce: string, card: AdaptiveCard): Promise<void> {
  const json = JSON.stringify(card)
  const redis = redisOf(app)
  if (redis) {
    try {
      await redis.set(KEY(nonce), json, 'EX', NONCE_TTL_S)
      return
    } catch {
      // Redis failed: keep the card in this process so a repeat still gets it.
    }
  }
  local.set(nonce, json)
  if (local.size > NONCE_MAX) local.delete(local.keys().next().value as string)
}

/** What a repeat press waits for while the first is still running. */
async function lookup(app: FastifyInstance, nonce: string): Promise<string> {
  const redis = redisOf(app)
  if (redis) {
    try {
      const v = await redis.get(KEY(nonce))
      if (v != null && v !== PENDING) return v
    } catch {
      /* local below */
    }
  }
  return local.get(nonce) ?? PENDING
}

async function release(app: FastifyInstance, nonce: string): Promise<void> {
  local.delete(nonce)
  const redis = redisOf(app)
  if (redis) await redis.del(KEY(nonce)).catch(() => undefined)
}

/** "9:41 AM ET" — 12-hour, in the person's zone (Eastern unless they chose another). */
async function clock(user: User): Promise<string> {
  const zone = await userTimeZone(user as { preferences?: unknown })
  const text = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZoneName: 'short'
  }).format(new Date())
  return text.replace(/\bE[SD]T\b/, 'ET')
}

interface Pressed {
  kind: string
  ref: string
  action: string
  nonce: string
  comment: string
}

function readPress(activity: TeamsActivity): Pressed | null {
  const v = activity.value as
    | { action?: { data?: Record<string, unknown> }; data?: Record<string, unknown> }
    | undefined
  const d = v?.action?.data ?? v?.data
  if (!d || typeof d !== 'object') return null
  const s = (x: unknown) => (typeof x === 'string' ? x : x == null ? '' : String(x))
  const p = {
    kind: s(d.kind),
    ref: s(d.ref),
    action: s(d.action),
    nonce: s(d.nonce),
    comment: s(d.comment).trim()
  }
  return p.kind && p.ref && p.action && p.nonce ? p : null
}

/** The Open link on "Working on it…" — only for a record the presser can read (the nonce may be
 *  someone else's in-flight press). */
async function pendingLink(p: Pressed, user: User, isAdmin: boolean): Promise<string | undefined> {
  try {
    let collection = ''
    let item = ''
    if (p.kind === 'transition') {
      const cut = p.ref.indexOf('/')
      if (cut <= 0) return undefined
      collection = p.ref.slice(0, cut)
      item = p.ref.slice(cut + 1)
    } else if (p.kind === 'approval') {
      const inst = (await db('nivaro_approval_instances')
        .where({ id: Number(p.ref) })
        .first('collection', 'item')) as { collection: string; item: string } | undefined
      if (!inst) return undefined
      collection = inst.collection
      item = String(inst.item)
    } else return undefined
    if (!(await instanceAccessAllowed(user, isAdmin, collection, item, 'read'))) return undefined
    return await recordLink(collection, item, { recipientUserId: user.id })
  } catch {
    /* no link */
  }
  return undefined
}

const NOT_FOUND = "You can't open this record any more."
const NEEDS_FORM = 'This needs the form.'

async function openCard(text: string, collection?: string, item?: string, userId?: string) {
  let url: string | undefined
  if (collection && item) {
    try {
      url = await recordLink(collection, item, { recipientUserId: userId })
    } catch {
      /* no link */
    }
  }
  return resultCard(text, url)
}

function refusalText(status: number, body: unknown): string {
  const b = (body ?? {}) as { error?: string }
  if (status === 404) return NOT_FOUND
  return typeof b.error === 'string' && b.error ? b.error : 'That could not be done.'
}

/** A reject asked for a reason: a card that carries the box and the same nonce, so it can be sent. */
function reasonCard(p: Pressed): AdaptiveCard {
  const card = resultCard('A reason is required to reject. Add one and press Reject again.')
  card.body.push({
    type: 'Input.Text',
    id: 'comment',
    placeholder: 'Reason (required to reject)',
    isMultiline: true,
    isRequired: true,
    errorMessage: 'A reason is required'
  })
  card.actions = [
    {
      type: 'Action.Execute',
      title: 'Reject',
      verb: 'nivaro',
      style: 'destructive',
      associatedInputs: 'auto',
      data: { kind: p.kind, ref: p.ref, action: p.action, nonce: p.nonce }
    }
  ]
  return card
}

async function runApproval(
  app: FastifyInstance,
  user: User,
  isAdmin: boolean,
  p: Pressed
): Promise<{ card: AdaptiveCard; keep: boolean }> {
  const decision = p.action === 'approved' || p.action === 'rejected' ? p.action : null
  const id = Number(p.ref)
  if (!decision || !Number.isInteger(id))
    return { card: resultCard('That button is not valid.'), keep: true }
  if (decision === 'rejected' && !p.comment) return { card: reasonCard(p), keep: false }

  // Read the target as the user: an instance on a record they cannot see is not theirs to decide.
  const inst = (await db('nivaro_approval_instances').where({ id }).first('collection', 'item')) as
    | { collection: string; item: string }
    | undefined
  if (!inst) return { card: resultCard(NOT_FOUND), keep: true }
  try {
    await assertInstanceAccess(user, isAdmin, inst.collection, String(inst.item), undefined, 'read')
  } catch (err) {
    if (err instanceof InstanceAccessError) return { card: resultCard(NOT_FOUND), keep: true }
    throw err
  }

  // applyApprovalDecision itself refuses (403) anyone who is not an approver of the current step.
  const r = await applyApprovalDecision({
    app,
    instanceId: id,
    user,
    isAdmin,
    decision,
    comment: p.comment || null
  })
  if (r.ok) {
    const word = decision === 'approved' ? 'Approved' : 'Rejected'
    return { card: resultCard(`${word} by you · ${await clock(user)}`), keep: true }
  }
  return {
    card: await openCard(
      refusalText(r.status ?? 400, { error: r.error }),
      inst.collection,
      String(inst.item),
      user.id
    ),
    keep: true
  }
}

async function runTransition(
  app: FastifyInstance,
  user: User,
  isAdmin: boolean,
  p: Pressed
): Promise<{ card: AdaptiveCard; keep: boolean }> {
  const cut = p.ref.indexOf('/')
  const collection = cut > 0 ? p.ref.slice(0, cut) : ''
  const item = cut > 0 ? p.ref.slice(cut + 1) : ''
  if (!collection || !item) return { card: resultCard('That button is not valid.'), keep: true }
  try {
    await assertInstanceAccess(user, isAdmin, collection, item, undefined, 'read')
  } catch (err) {
    if (err instanceof InstanceAccessError) return { card: resultCard(NOT_FOUND), keep: true }
    throw err
  }
  // A card is a one-click surface: a transition list surfaces keep off their menu (migration 312
  // in_row_menu = false) is form-only here too. Config row, not a record.
  const cfg = (await db('nivaro_workflow_transitions')
    .where({ id: p.action })
    .first('in_row_menu')) as { in_row_menu?: unknown } | undefined
  const menu = cfg?.in_row_menu
  if (cfg && menu != null && menu !== true && menu !== 1 && menu !== '1' && menu !== 'true')
    return {
      card: await openCard(`${NEEDS_FORM} Open in Nivaro`, collection, item, user.id),
      keep: true
    }
  const r = await runRecordTransition({
    user,
    isAdmin,
    collection,
    item,
    transitionId: p.action,
    comment: p.comment || null,
    log: app.log
  })
  const body = (r.body ?? {}) as {
    error?: string
    code?: string
    first?: { user_name?: string | null }
    data?: { new_state?: { label?: string } | null }
  }
  if (r.status >= 200 && r.status < 300) {
    const to = body.data?.new_state?.label
    return {
      card: resultCard(`${to ? `Moved to ${to}` : 'Moved'} by you · ${await clock(user)}`),
      keep: true
    }
  }
  if (r.status === 409 && body.code === 'TRANSITION_DUPLICATE') {
    const who = body.first?.user_name
    return {
      card: await openCard(
        who ? `Already moved by ${who}.` : 'Already moved.',
        collection,
        item,
        user.id
      ),
      keep: true
    }
  }
  // Requirements, a required note, or anything else the card cannot supply: the form can.
  if (
    r.status === 422 &&
    (body.error === 'TRANSITION_REQUIREMENTS' || body.code === 'TRANSITION_COMMENT_REQUIRED')
  )
    return {
      card: await openCard(`${NEEDS_FORM} Open in Nivaro`, collection, item, user.id),
      keep: true
    }
  return {
    card: await openCard(refusalText(r.status, body), collection, item, user.id),
    keep: true
  }
}

async function runAck(app: FastifyInstance, user: User, p: Pressed): Promise<AdaptiveCard> {
  const id = Number(p.ref)
  if (!Number.isInteger(id)) return resultCard('That button is not valid.')
  const r = await acknowledgeNotification(app, user, id)
  if (r.status >= 200 && r.status < 300)
    return resultCard(`Acknowledged by you · ${await clock(user)}`)
  return resultCard(refusalText(r.status, r.body))
}

export async function handleInvoke(
  app: FastifyInstance,
  activity: TeamsActivity
): Promise<AdaptiveCard> {
  const oid = activity.from?.aadObjectId
  const tenantId = activity.channelData?.tenant?.id ?? ''
  if (!oid) return resultCard('This button is not available.')
  const who = await resolveTeamsUser(oid, tenantId)
  if (!who.user) return connectCard(oid, tenantId)
  const user = who.user as User

  if ((await maintenanceState()).on)
    return resultCard('Nivaro is in maintenance — try again shortly.')

  const p = readPress(activity)
  if (!p) return resultCard('This button is not available.')

  const held = await claim(app, p.nonce)
  if (held !== null) {
    let value = held
    // The first press is still running (Teams re-sent because it was slow): wait for its card.
    for (let waited = 0; value === PENDING && waited < POLL_MAX_MS; waited += POLL_STEP_MS) {
      await new Promise((r) => setTimeout(r, POLL_STEP_MS))
      value = await lookup(app, p.nonce)
    }
    if (value === PENDING) {
      const link = await pendingLink(p, user, await isAdminUser(user).catch(() => false))
      return resultCard('Working on it…', link)
    }
    try {
      return JSON.parse(value) as AdaptiveCard
    } catch {
      return resultCard('Already done.')
    }
  }

  try {
    const isAdmin = await isAdminUser(user)
    let out: { card: AdaptiveCard; keep: boolean }
    if (p.kind === 'approval') out = await runApproval(app, user, isAdmin, p)
    else if (p.kind === 'transition') out = await runTransition(app, user, isAdmin, p)
    else if (p.kind === 'ack') out = { card: await runAck(app, user, p), keep: true }
    else out = { card: resultCard('This button is not available.'), keep: true }
    if (out.keep) await store(app, p.nonce, out.card)
    else await release(app, p.nonce)
    return out.card
  } catch (err) {
    // Nothing was decided: let a retry run.
    await release(app, p.nonce)
    app.log.error({ message: (err as Error)?.message }, 'teams bot: card action failed')
    return resultCard('Something went wrong. Try again, or open it in Nivaro.')
  }
}
