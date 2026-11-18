/**
 * Change proposals on locked records (2026-11-14, idea 6).
 *
 * A record its post-approval lock (edit-lock.ts `admin_only` tier) keeps a
 * person out of used to take a free-text support ticket an administrator
 * re-keyed. On a collection with `summary_mode_rules.change_proposals: true`
 * the person instead proposes new values for the fields they could write if
 * the record were open (their update + read field lists, never read-only,
 * admin-only, computed, audit, link-list or file fields, never the lock's open
 * fields — those they change directly) with a reason.
 *
 * The owners of the record's current step — never the proposer — and
 * administrators see old → new and Accept or Decline. Accept writes the values
 * through the items service AS THE ACCEPTER: permissions, row filters, User
 * Scopes, validation, rules and the approval tier all judge it; only the
 * admin-only tier is skipped for that one write. Before writing, the accepter
 * must be able to change every field (a field they could not write refuses the
 * whole proposal, never drops it silently) and every field must still hold the
 * value it held when proposed — otherwise it refuses in plain words.
 *
 * Storage: nivaro_change_proposals (migration 527). Every reader probes the
 * table, so an instance behind the migration simply has no proposals.
 * History: the Notes thread (registered source 'change-proposals') shows each
 * proposal and its outcome; an accepted proposal's write carries a change
 * reason, so the record's history names it too.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { db } from '../db/index.js'
import { getTenantId } from '../db/tenant-context.js'
import type { User } from '../types.js'
import {
  choicesOf,
  type ProposalChange,
  type ProposalFieldMeta,
  type ProposalKind,
  parseProposalChanges,
  proposalKindOf,
  readProposedValue,
  sameProposalValue,
  storableValue
} from './change-proposal-values.js'
import { getCollection, getFields, getRelations } from './collections.js'
import {
  adminOnlyLockOf,
  adminOnlyStateOf,
  editLockVerdictFor,
  latestRecordRun
} from './edit-lock.js'
import { getEncryptedFields } from './encryption.js'
import { getAllowedFields, isAdminRole } from './permissions.js'
import { announceRecordAspect } from './record-events.js'
import { parseSummaryModeRules } from './summary-mode.js'

export const PROPOSALS_TABLE = 'nivaro_change_proposals'
export const MAX_PROPOSAL_FIELDS = 30
export const MAX_REASON = 2000
/** Pending proposals one person may hold on one record. */
export const MAX_PENDING_PER_PERSON = 1

export type ProposalStatus = 'pending' | 'accepting' | 'accepted' | 'declined' | 'withdrawn'

export interface ProposalRow {
  id: number
  collection: string
  item: string
  status: ProposalStatus
  changes: string
  reason: string
  state_key: string | null
  created_by: string
  created_at: Date | string
  decided_by: string | null
  decided_at: Date | string | null
  decision_note: string | null
}

export class ProposalError extends Error {
  constructor(
    public statusCode: number,
    message: string,
    public code?: string
  ) {
    super(message)
  }
}

const tableCache = new Map<string, Promise<boolean>>()
/** Whether migration 527 ran on this (tenant's) database. */
export function proposalsTableExists(): Promise<boolean> {
  const k = getTenantId() ?? ''
  let p = tableCache.get(k)
  if (!p) {
    p = db.schema.hasTable(PROPOSALS_TABLE).catch(() => false)
    p.then((ok) => {
      if (!ok) setTimeout(() => tableCache.delete(k), 60_000)
    })
    tableCache.set(k, p)
  }
  return p
}

/** The per-collection switch (Form UX → Propose a change), default off. */
export async function proposalsEnabledFor(collection: string): Promise<boolean> {
  const col = (await getCollection(collection).catch(() => undefined)) as
    | { summary_mode_rules?: unknown }
    | undefined
  if (!col) return false
  return parseSummaryModeRules(col.summary_mode_rules).change_proposals === true
}

const sameId = (a: unknown, b: unknown) =>
  a != null && b != null && String(a).toLowerCase() === String(b).toLowerCase()

export interface ProposableField {
  field: string
  label: string
  kind: ProposalKind
  /** the linked collection (kind 'relation') */
  relation?: string
  choices?: Array<{ value: unknown; text: string }>
  required?: boolean
}

function labelOf(meta: { field: string; options?: Record<string, unknown> | null }): string {
  const t = (meta.options as { label?: unknown } | null)?.label
  if (typeof t === 'string' && t.trim()) return t.trim()
  return meta.field
    .replace(/_id$/, '')
    .split('_')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')
}

async function fieldLabels(collection: string): Promise<Map<string, string>> {
  const fields = await getFields(collection).catch(() => [])
  const out = new Map<string, string>()
  for (const f of fields as Array<{ field: string; options?: Record<string, unknown> | null }>) {
    const raw = f as unknown as { label?: unknown; name?: unknown }
    const own = typeof raw.label === 'string' && raw.label.trim() ? raw.label.trim() : null
    out.set(f.field, own ?? labelOf(f))
  }
  return out
}

const asSet = (list: string[] | null) => (list && !list.includes('*') ? new Set(list) : null)

/**
 * The fields `user` could write on `collection` if the record were open, with
 * the input each takes. `openFields` (the lock's) are left out — those they
 * change directly. Admins get every eligible field (admin-only-edit included).
 */
export async function proposableFields(
  user: User,
  collection: string,
  opts: { isAdmin: boolean; openFields?: string[] }
): Promise<ProposableField[]> {
  const [fields, rels, writable, readable] = await Promise.all([
    getFields(collection),
    getRelations(collection).catch(() => []),
    opts.isAdmin ? Promise.resolve(null) : getAllowedFields(user, 'update', collection),
    opts.isAdmin ? Promise.resolve(null) : getAllowedFields(user, 'read', collection)
  ])
  const labels = await fieldLabels(collection)
  const open = new Set(opts.openFields ?? [])
  // Encrypted fields are never proposed: a proposal stores its values as plain JSON.
  const encrypted = new Set(await getEncryptedFields(collection).catch(() => [] as string[]))
  const out: ProposableField[] = []
  for (const f of fields as unknown as ProposalFieldMeta[] & Array<{ required?: boolean }>) {
    const m2o = rels.find(
      (r) =>
        r.many_collection === collection &&
        r.many_field === f.field &&
        r.junction_field == null &&
        !!r.one_collection
    )
    const alias = rels.some(
      (r) => r.one_collection === collection && r.one_field === f.field && r.one_field != null
    )
    const kind = proposalKindOf(f, {
      m2oTarget: m2o?.one_collection ?? null,
      alias,
      writable: asSet(writable),
      readable: asSet(readable),
      openFields: open,
      isAdmin: opts.isAdmin
    })
    if (!kind || encrypted.has(f.field)) continue
    out.push({
      field: f.field,
      label: labels.get(f.field) ?? f.field,
      kind,
      ...(kind === 'relation' && m2o?.one_collection ? { relation: m2o.one_collection } : {}),
      ...(kind === 'choice' ? { choices: choicesOf(f) ?? [] } : {}),
      ...((f as { required?: boolean }).required ? { required: true } : {})
    })
  }
  return out
}

export interface DeciderVerdict {
  may: boolean
  /** plain reason when not */
  reason?: string
}

/**
 * Whether `user` may accept or decline a proposal on this record: an
 * administrator, or an owner of the record's current step who is not the
 * person who proposed it (owning a post-approval step does not let a person
 * change the record, so it must not let them approve their own change).
 */
export async function deciderVerdict(
  user: User,
  isAdmin: boolean,
  proposal: Pick<ProposalRow, 'collection' | 'item' | 'created_by'>
): Promise<DeciderVerdict> {
  if (isAdmin) return { may: true }
  if (sameId(proposal.created_by, user.id))
    return {
      may: false,
      reason: 'You proposed this change — another owner of the step or an administrator decides it.'
    }
  const run = await latestRecordRun(proposal.collection, proposal.item)
  if (!run) return { may: false, reason: 'Only administrators can decide this proposal.' }
  const { resolveStateOwnersBatch } = await import('./pipeline-engine.js')
  const { ownsStep } = await import('./record-access.js')
  const owners = await resolveStateOwnersBatch([
    {
      key: 'p',
      stateId: run.current_state,
      instanceId: run.id,
      collection: proposal.collection,
      itemId: String(proposal.item)
    }
  ])
  if (ownsStep(owners.get('p') ?? [], String(user.id))) return { may: true }
  return {
    may: false,
    reason: `Only the owners of ${run.label ?? run.key} and administrators can decide this proposal.`
  }
}

export interface ProposeEligibility {
  enabled: boolean
  /** the record sits where only administrators change it */
  locked: boolean
  can_propose: boolean
  /** why not, in plain words (when enabled + locked) */
  reason?: string
  step?: string | null
  open_fields?: string[]
}

/**
 * Whether `user` may propose a change on this record right now, judged as the
 * caller: the switch is on, the record reads for them, it sits in an
 * admin-only state for them, and they could change it were it open.
 */
export async function proposeEligibility(
  user: User,
  isAdmin: boolean,
  collection: string,
  item: string,
  workspaceId?: string
): Promise<ProposeEligibility> {
  if (!(await proposalsTableExists()) || !(await proposalsEnabledFor(collection)))
    return { enabled: false, locked: false, can_propose: false }
  if (isAdmin) return { enabled: true, locked: false, can_propose: false }
  if (!(await adminOnlyLockOf(collection)))
    return { enabled: true, locked: false, can_propose: false }
  const verdict = await editLockVerdictFor(user, collection, item)
  if (verdict.tier !== 'admin_only' || verdict.allowed)
    return { enabled: true, locked: false, can_propose: false }
  const run = await latestRecordRun(collection, item)
  const base = {
    enabled: true,
    locked: true,
    step: run?.label ?? run?.key ?? null,
    open_fields: verdict.open_fields ?? []
  }
  const { can } = await import('./permissions.js')
  const { canUpdateItem } = await import('./items.js')
  if (!(await can(user, 'update', collection)))
    return { ...base, can_propose: false, reason: 'You cannot change records here.' }
  if (!(await canUpdateItem(user, collection, item, workspaceId)))
    return { ...base, can_propose: false, reason: 'You cannot change this record.' }
  return { ...base, can_propose: true }
}

async function userNames(ids: Array<string | null | undefined>): Promise<Map<string, string>> {
  const list = [...new Set(ids.filter((x): x is string => !!x).map((x) => String(x)))]
  const out = new Map<string, string>()
  if (list.length === 0) return out
  const rows = (await db('nivaro_users')
    .whereIn('id', list.slice(0, 500))
    .select('id', 'first_name', 'last_name', 'email')
    .catch(() => [])) as Array<{
    id: string
    first_name: string | null
    last_name: string | null
    email: string | null
  }>
  for (const r of rows) {
    const name = [r.first_name, r.last_name].filter(Boolean).join(' ').trim()
    out.set(String(r.id).toLowerCase(), name || r.email || 'Someone')
  }
  return out
}
export const nameFrom = (names: Map<string, string>, id: string | null | undefined) =>
  id ? (names.get(String(id).toLowerCase()) ?? 'Someone') : null

/** Readable values of a record for `fields`, as `user` reads it (null = cannot read the record). */
async function readValues(
  user: User,
  collection: string,
  item: string,
  fields: string[],
  workspaceId?: string
): Promise<Record<string, unknown> | null> {
  const { readOne } = await import('./items.js')
  const row = (await readOne(user, collection, item, workspaceId, ['id', ...fields]).catch(
    () => null
  )) as Record<string, unknown> | null
  return row ?? null
}

export interface CreateProposalInput {
  values: Record<string, unknown>
  reason: string
}

/**
 * Store a proposal. Every value is read for its field's input, compared with
 * what the record holds (a value that changes nothing is left out) and
 * rehearsed through the items service as the proposer with only the
 * admin-only tier skipped — a value the record would refuse is refused now,
 * not when an owner presses Accept.
 */
export async function createProposal(
  req: FastifyRequest,
  collection: string,
  item: string,
  input: CreateProposalInput,
  app?: FastifyInstance
): Promise<{ id: number; fields: string[] }> {
  const user = req.user!
  const isAdmin = !!req.isAdmin || (await isAdminRole(user))
  const workspaceId = req.workspaceId ?? undefined
  const elig = await proposeEligibility(user, isAdmin, collection, item, workspaceId)
  if (!elig.enabled) throw new ProposalError(404, 'Change proposals are not turned on here.')
  if (!elig.locked)
    throw new ProposalError(
      409,
      'This record is not locked for you — change it directly.',
      'NOT_LOCKED'
    )
  if (!elig.can_propose)
    throw new ProposalError(403, elig.reason ?? 'You cannot propose a change on this record.')

  const reason = String(input.reason ?? '').trim()
  if (reason.length < 3)
    throw new ProposalError(400, 'Say why the change is needed.', 'REASON_REQUIRED')
  if (reason.length > MAX_REASON)
    throw new ProposalError(400, `The reason is longer than ${MAX_REASON} characters.`)
  const values = input.values && typeof input.values === 'object' ? input.values : {}
  const keys = Object.keys(values)
  if (keys.length === 0) throw new ProposalError(400, 'Pick at least one field to change.')
  if (keys.length > MAX_PROPOSAL_FIELDS)
    throw new ProposalError(400, `Propose at most ${MAX_PROPOSAL_FIELDS} fields at once.`)

  const allowed = await proposableFields(user, collection, {
    isAdmin: false,
    openFields: elig.open_fields
  })
  const byName = new Map(allowed.map((f) => [f.field, f]))
  const metas = new Map(
    ((await getFields(collection)) as unknown as ProposalFieldMeta[]).map((f) => [f.field, f])
  )
  const refused = keys.filter((k) => !byName.has(k))
  if (refused.length > 0) {
    const labels = await fieldLabels(collection)
    throw new ProposalError(
      403,
      `You cannot propose a change to ${refused.map((k) => labels.get(k) ?? k).join(', ')}.`,
      'FIELD_NOT_PROPOSABLE'
    )
  }
  const current = await readValues(user, collection, item, keys, workspaceId)
  if (!current) throw new ProposalError(404, 'Not found')

  const changes: ProposalChange[] = []
  for (const k of keys) {
    const f = byName.get(k)!
    const read = readProposedValue(
      f.kind,
      values[k],
      metas.get(k) ?? { field: k, type: null, interface: null }
    )
    if ('error' in read) throw new ProposalError(400, `${f.label} ${read.error}.`, 'INVALID_VALUE')
    if (sameProposalValue(current[k], read.value, f.kind)) continue
    changes.push({ field: k, from: storableValue(current[k], f.kind), to: read.value })
  }
  if (changes.length === 0)
    throw new ProposalError(400, 'Those are the values the record already holds.', 'NO_CHANGE')

  const mine = (await db(PROPOSALS_TABLE)
    .where({ collection, item: String(item), status: 'pending' })
    .select('created_by')) as Array<{ created_by: string }>
  if (mine.filter((r) => sameId(r.created_by, user.id)).length >= MAX_PENDING_PER_PERSON)
    throw new ProposalError(
      409,
      'You already have a proposal waiting on this record — withdraw it first to propose another.',
      'PROPOSAL_PENDING'
    )

  // Rehearse the write as the proposer (validation, rules, row filters).
  const { updateOne } = await import('./items.js')
  const payload = Object.fromEntries(changes.map((c) => [c.field, c.to]))
  try {
    const report = (await updateOne(user, collection, item, payload, req, workspaceId, {
      dryRun: true,
      callerPayload: true,
      skipAdminOnlyLock: true
    })) as unknown as { error?: string } | null
    if (report && typeof report === 'object' && typeof report.error === 'string')
      throw new ProposalError(422, report.error, 'WOULD_BE_REFUSED')
  } catch (err) {
    if (err instanceof ProposalError) throw err
    throw refusalOf(err)
  }

  const run = await latestRecordRun(collection, item)
  const inserted = (await db(PROPOSALS_TABLE).insert(
    {
      collection,
      item: String(item),
      status: 'pending',
      changes: JSON.stringify(changes),
      reason,
      state_key: run?.key ?? null,
      created_by: String(user.id),
      created_at: new Date()
    },
    ['id']
  )) as Array<{ id: number } | number>
  const first = inserted[0]
  const id = Number(typeof first === 'object' ? first.id : first)
  if (app)
    await notifyReviewers(app, {
      id,
      collection,
      item: String(item),
      created_by: String(user.id),
      run,
      fields: changes.map((c) => c.field),
      reason
    })
  announceProposalChange(collection, item)
  return { id, fields: changes.map((c) => c.field) }
}

/**
 * S10 (realtime gaps 2026-11-17): a proposal on a record was made, accepted, declined or
 * withdrawn. Open Notes panels listen for `$comments`; `$proposals` names it precisely for
 * clients that learn it. Ids + aspect names only — viewers re-read as themselves.
 */
function announceProposalChange(collection: string, item: string | number): void {
  announceRecordAspect(collection, item, ['$comments', '$proposals'])
}

/** An items-service refusal in plain words, kept as a ProposalError. */
export function refusalOf(err: unknown): ProposalError {
  const e = err as {
    statusCode?: number
    code?: string
    message?: string
    errors?: Array<{ field?: string; message?: string }>
  }
  const status = Number(e?.statusCode)
  const detail = Array.isArray(e?.errors)
    ? e.errors
        .map((x) => x?.message)
        .filter(Boolean)
        .join(' ')
    : ''
  const message = detail || (typeof e?.message === 'string' ? e.message : '')
  if (status === 404 || e?.code === 'ITEM_NOT_FOUND') return new ProposalError(404, 'Not found')
  if (status === 403)
    return new ProposalError(
      403,
      message || 'You do not have permission to make this change.',
      e?.code
    )
  if (status >= 400 && status < 500)
    return new ProposalError(
      status === 409 ? 409 : 422,
      message || 'The record would refuse this change.',
      e?.code ?? 'WOULD_BE_REFUSED'
    )
  return new ProposalError(500, 'Could not check the change right now. Try again in a moment.')
}

export async function loadProposal(id: number): Promise<ProposalRow | null> {
  if (!Number.isInteger(id) || id <= 0) return null
  if (!(await proposalsTableExists())) return null
  return ((await db(PROPOSALS_TABLE).where({ id }).first()) as ProposalRow | undefined) ?? null
}

/**
 * The record's name as ONE recipient may see it (their own read access: a record
 * or label they cannot read gets the collection's name, never its id or label).
 */
async function recordLabelFor(userId: string, collection: string, item: string): Promise<string> {
  try {
    const { getUser } = await import('./users.js')
    const viewer = await getUser(String(userId))
    if (!viewer) return 'a record'
    const { recordLabelsAsViewer } = await import('./record-labels-as-viewer.js')
    const labels = await recordLabelsAsViewer(viewer, [{ collection, id: String(item) }])
    return labels[`${collection}:${String(item)}`] || 'a record'
  } catch {
    return 'a record'
  }
}

async function notifyProposer(
  app: FastifyInstance,
  p: ProposalRow,
  actorId: string,
  outcome: 'accepted' | 'declined',
  note: string | null
): Promise<void> {
  if (sameId(p.created_by, actorId)) return
  try {
    const { notifyUser } = await import('./notification-channels.js')
    const label = await recordLabelFor(String(p.created_by), p.collection, p.item)
    await notifyUser(app, String(p.created_by), {
      subject:
        outcome === 'accepted'
          ? `Your proposed change to ${label} was accepted`
          : `Your proposed change to ${label} was declined`,
      message:
        outcome === 'accepted'
          ? 'The new values are on the record now.'
          : note
            ? `Reason: ${note}`
            : 'No reason was given.',
      sender: actorId,
      // Its own category: people mute or route proposal notices on their own.
      category: 'proposals',
      collection: p.collection,
      item: String(p.item),
      why: 'you proposed this change',
      source: { kind: 'change-proposal', label: 'Change proposal', id: p.id }
    })
  } catch {
    // A failed notice never undoes the decision.
  }
}

/** An accept that never finished (the process stopped mid-write) frees the proposal after this. */
export const ACCEPTING_STALE_MS = 2 * 60_000

/** Whether a row still waits on a decision (a long-stuck accept counts as waiting). */
export function isPending(
  r: Pick<ProposalRow, 'status' | 'decided_at'>,
  now = Date.now()
): boolean {
  if (r.status === 'pending') return true
  if (r.status !== 'accepting') return false
  const at = r.decided_at ? new Date(r.decided_at).getTime() : 0
  return !Number.isFinite(at) || now - at > ACCEPTING_STALE_MS
}

/**
 * Who reviews a new proposal: the owners of the record's current step, never
 * the proposer; when the step resolves nobody, the administrators (who may
 * always decide). Exported for the tests.
 */
export async function proposalReviewers(
  collection: string,
  item: string,
  proposerId: string,
  run: { id: string; current_state: string } | null
): Promise<string[]> {
  let ids: string[] = []
  if (run) {
    const { resolveStateOwnersBatch } = await import('./pipeline-engine.js')
    const owners = await resolveStateOwnersBatch([
      { key: 'r', stateId: run.current_state, instanceId: run.id, collection, itemId: item }
    ]).catch(() => new Map())
    ids = ((owners.get('r') ?? []) as Array<{ id: string | null }>)
      .map((o) => (o.id != null ? String(o.id) : ''))
      .filter(Boolean)
  }
  ids = ids.filter((id) => !sameId(id, proposerId))
  if (ids.length === 0) {
    // Administrators only (they may always decide) — never desk/team members who cannot.
    const { activeAdministratorIds } = await import('./support-tickets.js')
    ids = (await activeAdministratorIds().catch(() => [] as string[])).filter(
      (id) => !sameId(id, proposerId)
    )
  }
  const seen = new Set<string>()
  return ids.filter((id) => {
    const k = id.toLowerCase()
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
}

/** Tell the reviewers a proposal waits on them (category Change proposals). */
async function notifyReviewers(
  app: FastifyInstance,
  p: {
    id: number
    collection: string
    item: string
    created_by: string
    run: { id: string; current_state: string } | null
    fields: string[]
    reason: string
  }
): Promise<void> {
  try {
    const reviewers = await proposalReviewers(p.collection, p.item, p.created_by, p.run)
    if (reviewers.length === 0) return
    const { notifyUser } = await import('./notification-channels.js')
    const [names, labels] = await Promise.all([
      userNames([p.created_by]),
      fieldLabels(p.collection)
    ])
    const who = nameFrom(names, p.created_by) ?? 'Someone'
    const fieldText = p.fields.map((f) => labels.get(f) ?? f).join(', ')
    for (const uid of reviewers) {
      // Each reviewer gets the record's name as THEY may read it.
      const label = await recordLabelFor(uid, p.collection, p.item)
      await notifyUser(app, uid, {
        subject: `Change proposed on ${label} — review it`,
        message: `${who} proposed new values for ${fieldText}: ${p.reason}`.slice(0, 500),
        sender: p.created_by,
        category: 'proposals',
        collection: p.collection,
        item: p.item,
        why: 'you own the step this record is at',
        source: { kind: 'change-proposal', label: 'Change proposal', id: p.id }
      }).catch(() => undefined)
    }
  } catch {
    // A failed notice never undoes the proposal: it waits in My Work anyway.
  }
}

/** Claim a pending proposal for the accept write (one decision wins). */
async function claimForAccept(id: number): Promise<boolean> {
  const stale = new Date(Date.now() - ACCEPTING_STALE_MS)
  const n = await db(PROPOSALS_TABLE)
    .where({ id })
    .where((q) =>
      q
        .where('status', 'pending')
        .orWhere((w) => w.where('status', 'accepting').where('decided_at', '<', stale))
    )
    .update({ status: 'accepting', decided_by: null, decided_at: new Date() })
  return Number(n) === 1
}

const DECIDED_STATUS_SENTENCE: Record<string, string> = {
  accepted: 'This proposal was already accepted.',
  declined: 'This proposal was already declined.',
  withdrawn: 'This proposal was withdrawn.',
  accepting: 'Someone is accepting this proposal right now.'
}

async function proposalForDecision(
  req: FastifyRequest,
  id: number
): Promise<{ p: ProposalRow; isAdmin: boolean }> {
  const user = req.user!
  const p = await loadProposal(id)
  if (!p) throw new ProposalError(404, 'Not found')
  // The record must read for the decider, as themselves.
  const row = await readValues(user, p.collection, p.item, [], req.workspaceId ?? undefined)
  if (!row) throw new ProposalError(404, 'Not found')
  if (!isPending(p))
    throw new ProposalError(409, DECIDED_STATUS_SENTENCE[p.status] ?? 'Already decided.', 'DECIDED')
  return { p, isAdmin: !!req.isAdmin || (await isAdminRole(user)) }
}

/**
 * What made the proposal acceptable must still hold when it is accepted: the
 * collection still takes proposals (turned off = every waiting one has
 * expired), the record still sits under the post-approval lock (unlocked =
 * the accepter edits it directly, nothing is bypassed) and still in the step
 * it was proposed in (moved on = the proposal described another moment).
 */
export async function assertStillApplies(
  p: Pick<ProposalRow, 'collection' | 'item' | 'state_key'>
): Promise<void> {
  if (!(await proposalsEnabledFor(p.collection)))
    throw new ProposalError(
      409,
      'Change proposals are turned off for this kind of record, so this proposal has expired.',
      'PROPOSALS_OFF'
    )
  if (!(await adminOnlyStateOf(p.collection, String(p.item))))
    throw new ProposalError(
      409,
      'This record is no longer locked — change it directly instead of accepting the proposal.',
      'NOT_LOCKED'
    )
  const run = await latestRecordRun(p.collection, String(p.item))
  if (!run || !p.state_key || run.key !== p.state_key)
    throw new ProposalError(
      409,
      'The record moved on since this was proposed; ask for a new proposal.',
      'PROPOSAL_STEP_CHANGED'
    )
}

/**
 * Accept: re-check the accepter's right to every field, refuse when a field
 * changed since the proposal, then write through the items service as the
 * accepter (admin-only tier skipped for this write only).
 */
export async function acceptProposal(
  app: FastifyInstance,
  req: FastifyRequest,
  id: number
): Promise<{ id: number; fields: string[] }> {
  const user = req.user!
  const workspaceId = req.workspaceId ?? undefined
  const { p, isAdmin } = await proposalForDecision(req, id)
  const who = await deciderVerdict(user, isAdmin, p)
  if (!who.may) throw new ProposalError(403, who.reason ?? 'You cannot decide this proposal.')
  await assertStillApplies(p)

  const changes = parseProposalChanges(p.changes)
  if (changes.length === 0) throw new ProposalError(409, 'This proposal holds no changes.')
  const labels = await fieldLabels(p.collection)
  const name = (f: string) => labels.get(f) ?? f

  // The accepter must be able to change every field themselves.
  const { can } = await import('./permissions.js')
  const { canUpdateItem } = await import('./items.js')
  if (!isAdmin) {
    if (
      !(await can(user, 'update', p.collection)) ||
      !(await canUpdateItem(user, p.collection, p.item, workspaceId))
    )
      throw new ProposalError(
        403,
        'You cannot change this record, so you cannot accept this proposal.',
        'ACCEPTER_CANNOT_WRITE'
      )
  }
  const theirs = await proposableFields(user, p.collection, { isAdmin })
  const kinds = new Map(theirs.map((f) => [f.field, f.kind]))
  const cannot = changes.filter((c) => !kinds.has(c.field)).map((c) => name(c.field))
  if (cannot.length > 0)
    throw new ProposalError(
      403,
      `You cannot change ${cannot.join(', ')}, so you cannot accept this proposal. An administrator can.`,
      'ACCEPTER_CANNOT_WRITE'
    )

  // The record must still hold what the proposer saw.
  const current = await readValues(
    user,
    p.collection,
    p.item,
    changes.map((c) => c.field),
    workspaceId
  )
  if (!current) throw new ProposalError(404, 'Not found')
  const moved = changes.filter(
    (c) => !sameProposalValue(current[c.field], c.from, kinds.get(c.field))
  )
  if (moved.length > 0)
    throw new ProposalError(
      409,
      `${moved.map((c) => name(c.field)).join(', ')} changed since this proposal was made. Decline it and ask for a new one.`,
      'PROPOSAL_STALE'
    )

  if (!(await claimForAccept(p.id)))
    throw new ProposalError(409, 'This proposal was decided a moment ago.', 'DECIDED')
  const names = await userNames([p.created_by])
  const proposer = nameFrom(names, p.created_by) ?? 'Someone'
  const payload: Record<string, unknown> = Object.fromEntries(changes.map((c) => [c.field, c.to]))
  payload._change_reason = `Accepted change proposal #${p.id} from ${proposer}: ${p.reason}`.slice(
    0,
    1000
  )
  try {
    const { updateOne } = await import('./items.js')
    await updateOne(user, p.collection, p.item, payload, req, workspaceId, {
      callerPayload: true,
      skipAdminOnlyLock: true
    })
  } catch (err) {
    await db(PROPOSALS_TABLE)
      .where({ id: p.id, status: 'accepting' })
      .update({ status: 'pending', decided_at: null })
      .catch(() => {})
    throw refusalOf(err)
  }
  await db(PROPOSALS_TABLE)
    .where({ id: p.id })
    .update({
      status: 'accepted',
      decided_by: String(user.id),
      decided_at: new Date()
    })
  await notifyProposer(app, p, String(user.id), 'accepted', null)
  announceProposalChange(p.collection, p.item)
  return { id: p.id, fields: changes.map((c) => c.field) }
}

export async function declineProposal(
  app: FastifyInstance,
  req: FastifyRequest,
  id: number,
  noteRaw: unknown
): Promise<{ id: number }> {
  const user = req.user!
  const note = String(noteRaw ?? '').trim()
  if (note.length < 3)
    throw new ProposalError(400, 'Say why you are declining it.', 'NOTE_REQUIRED')
  if (note.length > MAX_REASON)
    throw new ProposalError(400, `The note is longer than ${MAX_REASON} characters.`)
  const { p, isAdmin } = await proposalForDecision(req, id)
  const who = await deciderVerdict(user, isAdmin, p)
  if (!who.may) throw new ProposalError(403, who.reason ?? 'You cannot decide this proposal.')
  const n = await db(PROPOSALS_TABLE)
    .where({ id: p.id })
    .whereIn('status', ['pending', 'accepting'])
    .where((q) =>
      q
        .where('status', 'pending')
        .orWhere('decided_at', '<', new Date(Date.now() - ACCEPTING_STALE_MS))
    )
    .update({
      status: 'declined',
      decided_by: String(user.id),
      decided_at: new Date(),
      decision_note: note
    })
  if (Number(n) !== 1)
    throw new ProposalError(409, 'This proposal was decided a moment ago.', 'DECIDED')
  await notifyProposer(app, p, String(user.id), 'declined', note)
  announceProposalChange(p.collection, p.item)
  return { id: p.id }
}

export async function withdrawProposal(req: FastifyRequest, id: number): Promise<{ id: number }> {
  const user = req.user!
  const p = await loadProposal(id)
  if (!p || !sameId(p.created_by, user.id)) throw new ProposalError(404, 'Not found')
  if (!isPending(p))
    throw new ProposalError(409, DECIDED_STATUS_SENTENCE[p.status] ?? 'Already decided.', 'DECIDED')
  const n = await db(PROPOSALS_TABLE)
    .where({ id: p.id, status: 'pending' })
    .update({
      status: 'withdrawn',
      decided_by: String(user.id),
      decided_at: new Date()
    })
  if (Number(n) !== 1)
    throw new ProposalError(409, 'This proposal was decided a moment ago.', 'DECIDED')
  announceProposalChange(p.collection, p.item)
  return { id: p.id }
}

export interface ProposalView {
  id: number
  status: ProposalStatus
  reason: string
  step: string | null
  created_by: string
  created_by_name: string | null
  created_at: Date | string
  decided_by: string | null
  decided_by_name: string | null
  decided_at: Date | string | null
  decision_note: string | null
  changes: Array<{
    field: string
    label: string
    kind: ProposalKind | null
    relation?: string
    choices?: Array<{ value: unknown; text: string }>
    from: unknown
    to: unknown
    /** the field no longer holds `from` */
    stale?: boolean
    /** what the field holds now (stale changes only), so the owner sees what moved */
    now?: unknown
  }>
  /** fields of this proposal the viewer may not read (left out of `changes`) */
  hidden_fields: number
  can_decide: boolean
  /** why not (pending only) */
  decide_reason?: string
  can_withdraw: boolean
}

/**
 * The record's proposals as `user` may see them: every proposal on a record
 * they can read, each change only for a field they can read. Pending ones
 * first, then the latest decided (≤ `decidedCap`).
 */
export async function proposalsForRecord(
  user: User,
  isAdmin: boolean,
  collection: string,
  item: string,
  opts: { workspaceId?: string; decidedCap?: number } = {}
): Promise<ProposalView[]> {
  if (!(await proposalsTableExists())) return []
  const rows = (await db(PROPOSALS_TABLE)
    .where({ collection, item: String(item) })
    .orderBy('id', 'desc')
    .limit(60)
    .select('*')) as ProposalRow[]
  if (rows.length === 0) return []
  const open = rows.filter((r) => r.status === 'pending' || r.status === 'accepting')
  const done = rows.filter((r) => !open.includes(r)).slice(0, opts.decidedCap ?? 10)
  const list = [...open, ...done]
  const readable = isAdmin ? null : asSet(await getAllowedFields(user, 'read', collection))
  const encryptedFields = new Set(await getEncryptedFields(collection).catch(() => [] as string[]))
  const [labels, fields, rels, names] = await Promise.all([
    fieldLabels(collection),
    getFields(collection).catch(() => []),
    getRelations(collection).catch(() => []),
    userNames(list.flatMap((r) => [r.created_by, r.decided_by]))
  ])
  const kindOf = new Map<string, ProposalKind | null>()
  const relOf = new Map<string, string>()
  const choicesByField = new Map<string, Array<{ value: unknown; text: string }>>()
  for (const f of fields as unknown as ProposalFieldMeta[]) {
    const m2o = rels.find(
      (r) =>
        r.many_collection === collection &&
        r.many_field === f.field &&
        r.junction_field == null &&
        !!r.one_collection
    )
    if (m2o?.one_collection) relOf.set(f.field, m2o.one_collection)
    const choices = choicesOf(f)
    if (choices) choicesByField.set(f.field, choices)
    kindOf.set(
      f.field,
      proposalKindOf(f, {
        m2oTarget: m2o?.one_collection ?? null,
        alias: false,
        writable: null,
        readable: null,
        openFields: new Set(),
        isAdmin: true
      })
    )
  }
  // Pending proposals: show which fields moved since (current values, read as the viewer).
  const pendingFields = [
    ...new Set(open.flatMap((r) => parseProposalChanges(r.changes).map((c) => c.field)))
  ].filter((f) => !readable || readable.has(f))
  const current =
    pendingFields.length > 0
      ? await readValues(user, collection, item, pendingFields, opts.workspaceId)
      : null

  const out: ProposalView[] = []
  for (const r of list) {
    const all = parseProposalChanges(r.changes)
    const visible = all.filter(
      (c) => (!readable || readable.has(c.field)) && !encryptedFields.has(c.field)
    )
    if (visible.length === 0 && !sameId(r.created_by, user.id)) continue
    const pending = isPending(r)
    let decide: DeciderVerdict = { may: false }
    if (pending) decide = await deciderVerdict(user, isAdmin, r).catch(() => ({ may: false }))
    out.push({
      id: Number(r.id),
      status: pending ? 'pending' : r.status,
      reason: r.reason,
      step: r.state_key ?? null,
      created_by: String(r.created_by),
      created_by_name: nameFrom(names, r.created_by),
      created_at: r.created_at,
      decided_by: r.decided_by ? String(r.decided_by) : null,
      decided_by_name: nameFrom(names, r.decided_by),
      decided_at: r.decided_at,
      decision_note: r.decision_note,
      changes: visible.map((c) => {
        const kind = kindOf.get(c.field) ?? null
        const stale =
          pending && current && c.field in current
            ? !sameProposalValue(current[c.field], c.from, kind)
            : false
        return {
          field: c.field,
          label: labels.get(c.field) ?? c.field,
          kind,
          ...(relOf.has(c.field) ? { relation: relOf.get(c.field) } : {}),
          ...(choicesByField.has(c.field) ? { choices: choicesByField.get(c.field) } : {}),
          from: c.from,
          to: c.to,
          ...(stale ? { stale: true, now: current?.[c.field] ?? null } : {})
        }
      }),
      hidden_fields: all.length - visible.length,
      can_decide: decide.may,
      ...(pending && !decide.may && decide.reason ? { decide_reason: decide.reason } : {}),
      can_withdraw: pending && sameId(r.created_by, user.id)
    })
  }
  return out
}

export interface DecidableProposal {
  id: number
  collection: string
  item: string
  item_label: string
  fields: string[]
  reason: string
  created_by_name: string | null
  created_at: Date | string
}

/**
 * Pending proposals `user` may decide — for My Work. Administrators get every
 * pending proposal; others the ones on records whose current step they own
 * (and did not propose), on records they can read.
 */
export async function decidableProposalsFor(
  user: User,
  isAdmin: boolean,
  workspaceId?: string
): Promise<DecidableProposal[]> {
  if (!(await proposalsTableExists())) return []
  const rows = (await db(PROPOSALS_TABLE)
    .where({ status: 'pending' })
    .orderBy('id', 'asc')
    .limit(200)
    .select('*')) as ProposalRow[]
  if (rows.length === 0) return []
  // Turned off for a collection = its waiting proposals have expired.
  const on = new Map<string, boolean>()
  for (const c of new Set(rows.map((r) => r.collection)))
    on.set(c, await proposalsEnabledFor(c).catch(() => false))
  const live = rows.filter((r) => on.get(r.collection))
  if (live.length === 0) return []
  const keep: ProposalRow[] = []
  if (isAdmin) keep.push(...live)
  else {
    const candidates = live.filter((r) => !sameId(r.created_by, user.id))
    const { resolveStateOwnersBatch } = await import('./pipeline-engine.js')
    const { ownsStep } = await import('./record-access.js')
    const runs = await Promise.all(
      candidates.map((r) => latestRecordRun(r.collection, r.item).catch(() => null))
    )
    const reqs = candidates
      .map((r, i) => ({ r, run: runs[i] }))
      .filter((x) => !!x.run)
      .map((x) => ({
        key: String(x.r.id),
        stateId: x.run!.current_state,
        instanceId: x.run!.id,
        collection: x.r.collection,
        itemId: String(x.r.item)
      }))
    const owners = reqs.length
      ? await resolveStateOwnersBatch(reqs).catch(() => new Map())
      : new Map()
    for (const r of candidates)
      if (ownsStep(owners.get(String(r.id)) ?? [], String(user.id))) keep.push(r)
  }
  const visible: ProposalRow[] = []
  for (const r of keep.slice(0, 50)) {
    if (await readValues(user, r.collection, r.item, [], workspaceId)) visible.push(r)
  }
  if (visible.length === 0) return []
  const names = await userNames(visible.map((r) => r.created_by))
  const byCol = new Map<string, string[]>()
  for (const r of visible) byCol.set(r.collection, [...(byCol.get(r.collection) ?? []), r.item])
  const itemLabels = new Map<string, string>()
  const labelsByCol = new Map<string, Map<string, string>>()
  const { resolveFriendlyIds } = await import('./workflow-transitions.js')
  await Promise.all(
    [...byCol].map(async ([c, ids]) => {
      const m = await resolveFriendlyIds(c, ids).catch(() => new Map<string, string>())
      for (const [id, l] of m) itemLabels.set(`${c}\u0000${id}`, l)
      labelsByCol.set(c, await fieldLabels(c))
    })
  )
  return visible.map((r) => ({
    id: Number(r.id),
    collection: r.collection,
    item: String(r.item),
    item_label: itemLabels.get(`${r.collection}\u0000${r.item}`) ?? String(r.item),
    fields: parseProposalChanges(r.changes).map(
      (c) => labelsByCol.get(r.collection)?.get(c.field) ?? c.field
    ),
    reason: r.reason,
    created_by_name: nameFrom(names, r.created_by),
    created_at: r.created_at
  }))
}

/**
 * Notes-thread entries for a record's proposals: the proposal, then its
 * decline or withdrawal (an accepted proposal's write carries its own change
 * reason, which the thread already shows). Fields are named only when the
 * viewer can read them; values never ride the thread.
 */
export async function proposalNotes(
  collection: string,
  item: string,
  viewerId: string,
  cap: number
): Promise<
  Array<{
    id: string
    source: 'note'
    label: string
    text: string
    user: string | null
    created_at: Date | string
    context: string | null
    origin: 'person'
    _origin: 'person'
  }>
> {
  if (!(await proposalsTableExists())) return []
  const rows = (await db(PROPOSALS_TABLE)
    .where({ collection, item: String(item) })
    .orderBy('id', 'desc')
    .limit(Math.max(1, Math.min(cap, 100)))
    .select('*')
    .catch(() => [])) as ProposalRow[]
  if (rows.length === 0) return []
  const viewer = (await db('nivaro_users')
    .where({ id: viewerId })
    .first('id', 'role')
    .catch(() => null)) as User | null
  let readable: Set<string> | null = null
  if (viewer && !(await isAdminRole(viewer)))
    readable = asSet(await getAllowedFields(viewer, 'read', collection))
  else if (!viewer) readable = new Set()
  const labels = await fieldLabels(collection)
  const fieldsText = (r: ProposalRow) => {
    const names = parseProposalChanges(r.changes)
      .filter((c) => !readable || readable.has(c.field))
      .map((c) => labels.get(c.field) ?? c.field)
    return names.length > 0 ? names.join(', ') : 'fields you cannot see'
  }
  const out: Awaited<ReturnType<typeof proposalNotes>> = []
  for (const r of rows) {
    out.push({
      id: `proposal:${r.id}`,
      source: 'note',
      label: 'Change proposal',
      text: `Proposed a change to ${fieldsText(r)}: ${r.reason}`,
      user: r.created_by ? String(r.created_by) : null,
      created_at: r.created_at,
      context: `Proposal #${r.id}`,
      origin: 'person',
      _origin: 'person'
    })
    if ((r.status === 'declined' || r.status === 'withdrawn') && r.decided_at)
      out.push({
        id: `proposal:${r.id}:${r.status}`,
        source: 'note',
        label: 'Change proposal',
        text:
          r.status === 'declined'
            ? `Declined the proposed change to ${fieldsText(r)}${r.decision_note ? `: ${r.decision_note}` : '.'}`
            : `Withdrew the proposed change to ${fieldsText(r)}.`,
        user: r.decided_by ? String(r.decided_by) : null,
        created_at: r.decided_at,
        context: `Proposal #${r.id}`,
        origin: 'person',
        _origin: 'person'
      })
  }
  return out
}
