/**
 * Audience preview before sending (#3080).
 *
 * notification-audience.ts (#526) answers "for THIS write, who would be told". This answers the
 * question one step earlier, for a CONFIG that sends to people — an alert definition, a rule with
 * a notify / task action, a flow with a mail or notification step, a field watch, a broadcast:
 * "if I save this, who does it reach?". The editors ask it for an unsaved draft
 * (POST /api/audience-preview) and every save route asks it again on the server
 * (services/audience-gate.ts), so an API or MCP caller is held to the same confirm as the UI.
 *
 * What counts as the audience, per kind:
 *  - alert        the definition's subscribers (people subscribe themselves; the definition
 *                 names nobody) — only while it is active
 *  - field_watch  the watch's subscribers — only while it is active
 *  - rule         create_task assignees (a person, a team), plus any person / role / address a
 *                 notify-like action names; "the record's owners" and {{templates}} are per
 *                 record and come back as notes, never guessed into the count
 *  - flow / flow_operation   mail `to` addresses and notification `recipient` ids of the flow's
 *                 mail / notification steps — only while the flow is active
 *  - broadcast    the broadcast's audience, resolved by the SAME resolver the send uses
 *
 * Nothing here sends or writes. Names leave only for admins (every caller is admin-gated).
 */
import { db } from '../db/index.js'
import { selectInChunks } from './db-batch.js'

export const AUDIENCE_KINDS = [
  'alert',
  'rule',
  'flow',
  'flow_operation',
  'field_watch',
  'broadcast'
] as const
export type AudienceKind = (typeof AUDIENCE_KINDS)[number]

/** The config table each kind lives in — the activity row's collection. */
export const AUDIENCE_TABLE: Record<AudienceKind, string> = {
  alert: 'nivaro_alert_definitions',
  rule: 'nivaro_rules',
  flow: 'nivaro_flows',
  flow_operation: 'nivaro_flow_operations',
  field_watch: 'nivaro_field_watches',
  broadcast: 'nivaro_announcements'
}

export const SAMPLE_SIZE = 20

/** Who a draft names, before any database lookup. */
export interface RecipientSpec {
  user_ids: string[]
  emails: string[]
  roles: string[]
  teams: number[]
  /** Subscribers of an existing alert definition / field watch. */
  subscribers_of: { table: 'alert' | 'field_watch'; id: number } | null
  /** A broadcast audience (resolved by announcements.ts). */
  broadcast: Record<string, unknown> | null
  /** Per-record recipients the preview cannot count ({{templates}}, record owners). */
  dynamic: string[]
  /** False = the config is off: it tells nobody until it is turned on. */
  active: boolean
}

export interface AudiencePreview {
  kind: AudienceKind
  count: number
  /** First SAMPLE_SIZE people by name. */
  sample: Array<{ id: string; name: string }>
  includes_roles: Array<{ id: string; name: string; members: number }>
  /** A broadcast with no audience reaches every active person. */
  includes_everyone: boolean
  /** Addresses on a mail step that belong to nobody in the user table. */
  external_addresses: number
  over_threshold: boolean
  threshold: number
  active: boolean
  /** Whether saving needs `confirm_audience: true`. */
  confirm_required: boolean
  notes: string[]
}

export interface ResolvedPerson {
  id: string
  name: string
}

// ── Pure: what a draft names ─────────────────────────────────────────────────

function emptySpec(): RecipientSpec {
  return {
    user_ids: [],
    emails: [],
    roles: [],
    teams: [],
    subscribers_of: null,
    broadcast: null,
    dynamic: [],
    active: true
  }
}

function parseMaybeJson(v: unknown): unknown {
  if (typeof v !== 'string') return v
  const t = v.trim()
  if (!t.startsWith('{') && !t.startsWith('[')) return v
  try {
    return JSON.parse(t)
  } catch {
    return v
  }
}

function asList(v: unknown): string[] {
  const p = parseMaybeJson(v)
  if (Array.isArray(p)) return p.map((x) => String(x ?? '').trim()).filter(Boolean)
  if (typeof p === 'string')
    return p
      .split(/[,;\n]+/)
      .map((s) => s.trim())
      .filter(Boolean)
  if (typeof p === 'number') return [String(p)]
  return []
}

const isTemplate = (s: string) => /\{\{.*\}\}|\{%.*%\}/.test(s)
const isEmail = (s: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)

function truthy(v: unknown): boolean {
  return v === true || v === 1 || v === '1' || v === 'true'
}

/** Adds every person / address / role a list of values names; templates become notes. */
function addPeople(spec: RecipientSpec, values: string[], label: string): void {
  for (const raw of values) {
    if (isTemplate(raw)) {
      spec.dynamic.push(`${label} "${raw.slice(0, 80)}" is worked out per record`)
      continue
    }
    for (const part of raw.split(/[\s,;]+/).filter(Boolean)) {
      if (isEmail(part)) spec.emails.push(part.toLowerCase())
      else spec.user_ids.push(part)
    }
  }
}

/** Generic recipient keys an action or step may carry (core and extension ops alike). */
function addActionRecipients(spec: RecipientSpec, opts: Record<string, unknown>, label: string) {
  for (const key of ['to', 'cc', 'bcc']) addPeople(spec, asList(opts[key]), `${label} ${key}`)
  for (const key of ['recipient', 'recipients', 'user', 'users', 'user_ids', 'assignee'])
    addPeople(spec, asList(opts[key]), label)
  for (const key of ['role', 'roles', 'recipient_roles']) {
    for (const r of asList(opts[key])) {
      if (isTemplate(r)) spec.dynamic.push(`${label} role "${r.slice(0, 80)}" is per record`)
      else spec.roles.push(r)
    }
  }
  const team = opts.team_id ?? opts.team
  if (team != null && team !== '') {
    const n = Number(team)
    if (Number.isFinite(n)) spec.teams.push(n)
  }
  if (truthy(opts.assign_to_owners) || truthy(opts.to_owners))
    spec.dynamic.push(`${label} goes to each record's current owners`)
}

const SENDING_FLOW_OPS = new Set(['mail', 'notification'])

function opOptions(op: Record<string, unknown>): Record<string, unknown> {
  const o = parseMaybeJson(op.options)
  return o && typeof o === 'object' && !Array.isArray(o) ? (o as Record<string, unknown>) : {}
}

function addFlowOperation(spec: RecipientSpec, op: Record<string, unknown>) {
  const type = String(op.type ?? '')
  if (!SENDING_FLOW_OPS.has(type)) return
  const opts = opOptions(op)
  const label = `${type === 'mail' ? 'Mail' : 'Notification'} step "${String(op.name ?? op.key ?? type)}"`
  if (type === 'mail') addPeople(spec, asList(opts.to), label)
  else addPeople(spec, asList(opts.recipient), label)
  for (const r of asList(opts.roles ?? opts.role)) if (!isTemplate(r)) spec.roles.push(r)
}

/** Whether a flow operation sends to people (a save of any other op needs no preview). */
export function isSendingFlowOperation(op: { type?: unknown } | null | undefined): boolean {
  return SENDING_FLOW_OPS.has(String(op?.type ?? ''))
}

/**
 * What a draft names, from the draft alone. `draft` is the config as it would be stored (an
 * update merges the patch over the stored row before asking). Flows pass `operations`; an
 * existing alert / field watch passes its `id` so its subscribers count.
 */
export function extractRecipientSpec(kind: AudienceKind, draft: Record<string, unknown>) {
  const spec = emptySpec()
  switch (kind) {
    case 'alert':
    case 'field_watch': {
      spec.active = draft.is_active === undefined ? true : truthy(draft.is_active)
      const id = Number(draft.id)
      if (Number.isFinite(id) && id > 0) spec.subscribers_of = { table: kind, id }
      break
    }
    case 'rule': {
      spec.active = draft.enabled === undefined ? true : truthy(draft.enabled)
      const raw = parseMaybeJson(draft.actions)
      const actions = (Array.isArray(raw) ? raw : raw && typeof raw === 'object' ? [raw] : [])
        .filter((a): a is Record<string, unknown> => !!a && typeof a === 'object')
        .filter((a) => a.type === 'notify' || a.type === 'create_task' || a.type === 'mail')
      for (const a of actions) {
        const label = a.type === 'create_task' ? 'Task action' : 'Notify action'
        const before = spec.user_ids.length + spec.emails.length + spec.roles.length
        addActionRecipients(spec, a, label)
        const named = spec.user_ids.length + spec.emails.length + spec.roles.length
        if (a.type === 'notify' && named === before && !spec.dynamic.length)
          spec.dynamic.push('A notify action names no recipients, so it tells nobody')
      }
      break
    }
    case 'flow': {
      spec.active = String(draft.status ?? 'inactive') === 'active'
      const ops = Array.isArray(draft.operations) ? draft.operations : []
      for (const op of ops) if (op && typeof op === 'object') addFlowOperation(spec, op as never)
      break
    }
    case 'flow_operation': {
      // The step's flow decides whether anything sends; the caller passes its status.
      spec.active = draft.flow_status === undefined ? true : draft.flow_status === 'active'
      addFlowOperation(spec, draft)
      break
    }
    case 'broadcast': {
      const aud = parseMaybeJson(draft.audience)
      spec.broadcast = aud && typeof aud === 'object' ? (aud as Record<string, unknown>) : {}
      for (const r of asList(spec.broadcast.roles)) spec.roles.push(r)
      break
    }
  }
  spec.user_ids = [...new Set(spec.user_ids.map((u) => u.toLowerCase()))]
  spec.emails = [...new Set(spec.emails)]
  spec.roles = [...new Set(spec.roles)]
  spec.teams = [...new Set(spec.teams)]
  spec.dynamic = [...new Set(spec.dynamic)]
  return spec
}

/** Whether a broadcast audience names nobody — which means every active person. */
export function broadcastIsEveryone(aud: Record<string, unknown> | null): boolean {
  if (!aud) return false
  const has = (k: string) => Array.isArray(aud[k]) && (aud[k] as unknown[]).length > 0
  return (
    !has('roles') &&
    !has('groups') &&
    !has('user_ids') &&
    !(typeof aud.dimension === 'string' && aud.dimension && has('values'))
  )
}

/**
 * The confirm rule, pure: a save that reaches more than `threshold` people, a whole role or
 * everyone asks first. An inactive config reaches nobody and never asks.
 */
export function needsAudienceConfirm(input: {
  count: number
  roles: number
  everyone: boolean
  threshold: number
  active: boolean
}): { over_threshold: boolean; confirm_required: boolean } {
  const over = input.count > input.threshold
  return {
    over_threshold: over,
    confirm_required: input.active && (over || input.roles > 0 || input.everyone)
  }
}

/** Builds the answer from the resolved people (sorted by name, first SAMPLE_SIZE kept). */
export function summarizeAudience(input: {
  kind: AudienceKind
  people: ResolvedPerson[]
  roles: Array<{ id: string; name: string; members: number }>
  everyone: boolean
  external: number
  threshold: number
  active: boolean
  notes: string[]
}): AudiencePreview {
  const byId = new Map<string, ResolvedPerson>()
  for (const p of input.people) byId.set(p.id.toLowerCase(), p)
  const people = [...byId.values()].sort((a, b) => a.name.localeCompare(b.name))
  const count = people.length + input.external
  const gate = needsAudienceConfirm({
    count,
    roles: input.roles.length,
    everyone: input.everyone,
    threshold: input.threshold,
    active: input.active
  })
  const notes = [...input.notes]
  if (!input.active && count > 0)
    notes.unshift('This is turned off, so nobody is told until it is turned on.')
  return {
    kind: input.kind,
    count,
    sample: people.slice(0, SAMPLE_SIZE).map((p) => ({ id: p.id, name: p.name })),
    includes_roles: input.roles,
    includes_everyone: input.everyone,
    external_addresses: input.external,
    threshold: input.threshold,
    active: input.active,
    ...gate,
    notes
  }
}

/** The ids + roles a preview reaches — used to tell whether a save adds anyone. */
export function audienceKeys(p: AudiencePreview, all: string[]): Set<string> {
  const keys = new Set(all.map((x) => `u:${x.toLowerCase()}`))
  for (const r of p.includes_roles) keys.add(`r:${r.id.toLowerCase()}`)
  if (p.includes_everyone) keys.add('everyone')
  return keys
}

// ── Database: who those names are ────────────────────────────────────────────

function nameOf(u: {
  first_name?: string | null
  last_name?: string | null
  email?: string | null
  id?: unknown
}): string {
  return (
    [u.first_name, u.last_name].filter(Boolean).join(' ').trim() || u.email || String(u.id ?? '')
  )
}

type UserRow = {
  id: string
  first_name: string | null
  last_name: string | null
  email: string | null
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Resolves a spec to people. Returns every reached id (for the "adds anyone" check). */
export async function resolveRecipientSpec(spec: RecipientSpec): Promise<{
  people: ResolvedPerson[]
  roles: Array<{ id: string; name: string; members: number }>
  everyone: boolean
  external: number
  notes: string[]
}> {
  const people: ResolvedPerson[] = []
  const notes = [...spec.dynamic]
  let everyone = false
  let external = 0

  if (spec.broadcast) {
    everyone = broadcastIsEveryone(spec.broadcast)
    const { resolveAudienceUsers } = await import('../routes/announcements.js')
    const users = await resolveAudienceUsers(spec.broadcast as never)
    for (const u of users) people.push({ id: String(u.id), name: nameOf(u) })
  }

  if (spec.subscribers_of) {
    const { table, id } = spec.subscribers_of
    const rows = (await (table === 'alert'
      ? db('nivaro_alert_subscriptions as s').where('s.alert_definition', id)
      : db('nivaro_field_watch_subscribers as s').where('s.watch', id)
    )
      .join('nivaro_users as u', 'u.id', 's.user')
      .where('u.status', 'active')
      .select('u.id', 'u.first_name', 'u.last_name', 'u.email')
      .catch(() => [])) as UserRow[]
    for (const u of rows) people.push({ id: String(u.id), name: nameOf(u) })
    if (!rows.length) notes.push('Nobody is subscribed yet; people subscribe themselves.')
  }

  if (spec.user_ids.length) {
    // Only ids can match a uuid column (a stray word would make SQL Server refuse the read).
    const ids = spec.user_ids.filter((u) => UUID_RE.test(u))
    const rows = (await selectInChunks(ids, 500, (chunk) =>
      db('nivaro_users')
        .whereIn('id', chunk)
        .where({ status: 'active', is_redacted: false })
        .select('id', 'first_name', 'last_name', 'email')
    ).catch(() => [])) as UserRow[]
    for (const u of rows) people.push({ id: String(u.id), name: nameOf(u) })
    const missing = spec.user_ids.length - rows.length
    if (missing > 0) notes.push(`${missing} named recipient(s) are not active people.`)
  }

  if (spec.emails.length) {
    const rows = (await selectInChunks(spec.emails, 500, (chunk) =>
      db('nivaro_users')
        .whereIn('email', chunk)
        .where({ status: 'active' })
        .select('id', 'first_name', 'last_name', 'email')
    ).catch(() => [])) as UserRow[]
    const known = new Set(rows.map((r) => String(r.email ?? '').toLowerCase()))
    for (const u of rows) people.push({ id: String(u.id), name: nameOf(u) })
    external = spec.emails.filter((e) => !known.has(e)).length
    if (external > 0) notes.push(`${external} address(es) belong to nobody here.`)
  }

  const roles: Array<{ id: string; name: string; members: number }> = []
  if (spec.roles.length) {
    const roleIds = spec.roles.filter((r) => UUID_RE.test(r))
    const roleRows = (await db('nivaro_roles')
      .where((q) => {
        q.whereIn('name', spec.roles)
        if (roleIds.length) q.orWhereIn('id', roleIds)
      })
      .select('id', 'name')
      .catch(() => [])) as Array<{ id: string; name: string }>
    for (const r of roleRows) {
      const members = (await db('nivaro_users')
        .where({ role: r.id, status: 'active', is_redacted: false })
        .select('id', 'first_name', 'last_name', 'email')
        .catch(() => [])) as UserRow[]
      // A broadcast already resolved its roles (with its other conditions) above.
      if (!spec.broadcast)
        for (const u of members) people.push({ id: String(u.id), name: nameOf(u) })
      roles.push({ id: String(r.id), name: r.name, members: members.length })
    }
  }

  if (spec.teams.length) {
    const rows = (await db('nivaro_user_group_members as m')
      .join('nivaro_users as u', 'u.id', 'm.user')
      .whereIn('m.group_id', spec.teams)
      .where('u.status', 'active')
      .select('u.id', 'u.first_name', 'u.last_name', 'u.email')
      .catch(() => [])) as UserRow[]
    for (const u of rows) people.push({ id: String(u.id), name: nameOf(u) })
  }

  return { people, roles, everyone, external, notes }
}

/** Fills the parts of a draft only the database knows (a flow's other steps, a step's flow). */
async function completeDraft(
  kind: AudienceKind,
  draft: Record<string, unknown>
): Promise<Record<string, unknown>> {
  if (kind === 'flow' && !Array.isArray(draft.operations) && draft.id) {
    const ops = (await db('nivaro_flow_operations')
      .where({ flow: String(draft.id) })
      .select('id', 'name', 'key', 'type', 'options')
      .catch(() => [])) as Array<Record<string, unknown>>
    return { ...draft, operations: ops }
  }
  if (kind === 'flow_operation' && draft.flow_status === undefined && draft.flow) {
    const flow = (await db('nivaro_flows')
      .where({ id: String(draft.flow) })
      .first('status')
      .catch(() => undefined)) as { status?: string } | undefined
    return { ...draft, flow_status: flow?.status ?? 'inactive' }
  }
  return draft
}

/** Who a config draft reaches, and whether saving it needs a confirm. */
export async function previewConfigAudience(
  kind: AudienceKind,
  draft: Record<string, unknown>,
  threshold: number
): Promise<{ preview: AudiencePreview; ids: string[] }> {
  const full = await completeDraft(kind, draft)
  const spec = extractRecipientSpec(kind, full)
  const r = await resolveRecipientSpec(spec)
  const preview = summarizeAudience({
    kind,
    people: r.people,
    roles: r.roles,
    everyone: r.everyone,
    external: r.external,
    threshold,
    active: spec.active,
    notes: r.notes
  })
  return {
    preview,
    ids: [...new Set(r.people.map((p) => p.id.toLowerCase()))]
  }
}
