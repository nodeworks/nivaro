import { fieldWords, typedName } from '../plan-words.js'
import type { HubResourceRow } from '../store.js'
import {
  type ConnectionTest,
  type DesiredResource,
  type FieldChange,
  type FieldSpec,
  type HealthAnswer,
  type ListPage,
  type Observed,
  type OpResult,
  type OutboundMessage,
  type PlannedOp,
  type ProviderAdapter,
  type ProviderContext,
  ProviderError,
  type ResourceTypeSpec,
  type RiskFlag
} from '../types.js'
import {
  bookmarkSeg,
  channelSeg,
  SLACK_HOST,
  type SlackAnswer,
  slackCall,
  teamOf,
  teamProblem,
  userSeg
} from './client.js'

/**
 * Slack (`slack`): a bot token (`xoxb-`, from a Slack app the operator installs) pinned to one
 * workspace (`team_id`): every operation first checks, once per ten minutes, that the token
 * belongs to that workspace (`SLACK_OUT_OF_ACCOUNT` otherwise). Host `slack.com` only.
 *
 * Types: `slack.channel` (public or private; delete = archive, reversible by unarchive; the
 * only sender: `notify` posts Block Kit cards), `slack.channel_members` (people matched by email,
 * additive: unknown emails are listed, never guessed; removing the resource leaves the members),
 * `slack.bookmark` (a link in a channel's bookmark bar).
 *
 * External ids: channel = channel id; channel_members = channel id; bookmark =
 * `<channel id>/<bookmark id>`.
 */

const CHANNEL = 'slack.channel'
const MEMBERS = 'slack.channel_members'
const BOOKMARK = 'slack.bookmark'
const PAGE = 200
const MEMBER_PAGES = 5
const MEMBER_EMAIL_CAP = 100
const WORKSPACE_TTL_MS = 10 * 60 * 1000
const THREAD_TTL_MS = 14 * 24 * 60 * 60 * 1000

type Obj = Record<string, unknown>

const asObj = (v: unknown): Obj =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {}
const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null)
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
const norm = (v: unknown): unknown => (v === '' || v === undefined ? null : v)

const CHANNEL_NAME = /^[a-z0-9][a-z0-9_-]{0,79}$/
const FULL = { create: true, update: true, delete: true, adopt: true, snapshot: false, tag: false }

// ── Workspace pin ──

async function assertWorkspace(ctx: ProviderContext): Promise<void> {
  const key = `workspace-ok:${teamOf(ctx.config)}`
  if (ctx.tokens.get(key)) return
  const r = await slackCall(ctx, 'auth.test')
  const team = String(r.body?.team_id ?? '')
  const enterprise = String(r.body?.enterprise_id ?? '')
  const want = teamOf(ctx.config)
  if (team !== want && enterprise !== want)
    throw new ProviderError(
      'SLACK_OUT_OF_ACCOUNT',
      'This bot token belongs to a different Slack workspace than the one the connection names.'
    )
  ctx.tokens.set(key, '1', new Date(ctx.now().getTime() + WORKSPACE_TTL_MS))
}

function alreadyExists(what: string): ProviderError {
  return new ProviderError('ALREADY_EXISTS', `${what} at Slack. Adopt it instead of creating it.`)
}

function refOne(desired: DesiredResource | null, field: string): string {
  const v = desired?.refs?.[field]
  const one = Array.isArray(v) ? v[0] : v
  if (typeof one === 'string' && one) return one
  throw new ProviderError(
    'INVALID_FIELDS',
    `The ${field} this change belongs to is not created yet.`
  )
}

// ── Observed mappers (never carry a token) ──

function channelObserved(ctx: ProviderContext, c: any): Observed {
  const team = teamOf(ctx.config)
  return {
    type: CHANNEL,
    externalId: String(c.id),
    name: c.name ?? null,
    fields: {
      name: c.name ?? null,
      visibility: c.is_private ? 'private' : 'public',
      topic: asObj(c.topic).value || null,
      purpose: asObj(c.purpose).value || null
    },
    tags: {},
    version: null,
    status: c.is_archived ? 'archived' : 'active',
    url: c.id && team.startsWith('T') ? `https://app.slack.com/client/${team}/${c.id}` : null
  }
}

/** A real channel of the pinned workspace (not a DM, not shared in from elsewhere), or false. */
function isOurChannel(ctx: ProviderContext, c: any): boolean {
  if (!c || c.is_im || c.is_mpim) return false
  const team = asObj(c).context_team_id
  const want = teamOf(ctx.config)
  if (typeof team === 'string' && team && team !== want) {
    const shared = arr(asObj(c).shared_team_ids).map(String)
    return shared.includes(want) && !c.is_ext_shared
  }
  return true
}

async function readChannel(ctx: ProviderContext, id: string): Promise<Observed | null> {
  await assertWorkspace(ctx)
  const r = await slackCall(
    ctx,
    'conversations.info',
    { channel: channelSeg(id) },
    { allow: ['channel_not_found'] }
  )
  if (!r.ok || !isOurChannel(ctx, r.body?.channel)) return null
  return channelObserved(ctx, r.body.channel)
}

async function listChannels(
  ctx: ProviderContext,
  cursor: string | null,
  limit = PAGE
): Promise<{ items: any[]; next: string | null }> {
  await assertWorkspace(ctx)
  const r = await slackCall(ctx, 'conversations.list', {
    types: 'public_channel,private_channel',
    exclude_archived: false,
    limit,
    cursor: cursor ?? undefined
  })
  return {
    items: arr(r.body?.channels).filter((c) => isOurChannel(ctx, c)),
    next: str(asObj(r.body?.response_metadata).next_cursor)
  }
}

async function memberIds(ctx: ProviderContext, channel: string): Promise<string[] | null> {
  const out: string[] = []
  let cursor: string | null = null
  for (let i = 0; i < MEMBER_PAGES; i++) {
    const r: SlackAnswer = await slackCall(
      ctx,
      'conversations.members',
      { channel: channelSeg(channel), limit: PAGE, cursor: cursor ?? undefined },
      { allow: ['channel_not_found'] }
    )
    if (!r.ok) return null
    for (const m of arr(r.body?.members)) out.push(String(m))
    cursor = str(asObj(r.body?.response_metadata).next_cursor)
    if (!cursor) break
  }
  return out
}

async function emailOf(ctx: ProviderContext, userId: string): Promise<string | null> {
  const r = await slackCall(
    ctx,
    'users.info',
    { user: userSeg(userId) },
    { allow: ['user_not_found'] }
  )
  const u = asObj(r.body?.user)
  if (!r.ok || u.is_bot || u.deleted) return null
  return str(asObj(u.profile).email)?.toLowerCase() ?? null
}

async function readMembers(ctx: ProviderContext, channel: string): Promise<Observed | null> {
  const seen = await readChannel(ctx, channel)
  if (!seen) return null
  const ids = (await memberIds(ctx, channel)) ?? []
  const emails: string[] = []
  for (const id of ids.slice(0, MEMBER_EMAIL_CAP)) {
    const e = await emailOf(ctx, id)
    if (e) emails.push(e)
  }
  return {
    type: MEMBERS,
    externalId: channel,
    name: seen.name,
    fields: { channel, emails: emails.sort() },
    tags: {},
    version: String(ids.length),
    status: seen.status ?? null,
    url: seen.url ?? null
  }
}

function bookmarkObserved(channel: string, b: any): Observed {
  return {
    type: BOOKMARK,
    externalId: `${channel}/${String(b.id)}`,
    name: b.title ?? null,
    fields: { channel, title: b.title ?? null, link: b.link ?? null },
    tags: {},
    version: null,
    status: null,
    url: str(b.link)
  }
}

async function readBookmarks(ctx: ProviderContext, channel: string): Promise<any[] | null> {
  await assertWorkspace(ctx)
  const r = await slackCall(
    ctx,
    'bookmarks.list',
    { channel_id: channelSeg(channel) },
    { allow: ['channel_not_found'] }
  )
  return r.ok ? arr(r.body?.bookmarks) : null
}

function splitBookmark(externalId: string): [string, string] {
  const i = externalId.indexOf('/')
  if (i < 1 || i === externalId.length - 1)
    throw new ProviderError('BAD_EXTERNAL_ID', 'The provider id has the wrong shape.')
  return [channelSeg(externalId.slice(0, i)), bookmarkSeg(externalId.slice(i + 1))]
}

async function readBookmark(ctx: ProviderContext, externalId: string): Promise<Observed | null> {
  const [channel, id] = splitBookmark(externalId)
  const list = await readBookmarks(ctx, channel)
  const hit = list?.find((b) => String(asObj(b).id) === id)
  return hit ? bookmarkObserved(channel, hit) : null
}

// ── Specs ──

const VISIBILITY: FieldSpec['options'] = [
  { value: 'private', label: 'Private' },
  { value: 'public', label: 'Public' }
]

const CHANNEL_FIELDS: FieldSpec[] = [
  {
    key: 'name',
    label: 'Channel name',
    kind: 'string',
    required: true,
    pattern: '^[a-z0-9][a-z0-9_-]{0,79}$',
    help: 'Lower-case letters, digits, dashes and underscores, up to 80 characters.'
  },
  {
    key: 'visibility',
    label: 'Visibility',
    kind: 'enum',
    options: VISIBILITY,
    default: 'private',
    help: 'Changing it needs an Enterprise Grid org-level token with admin.conversations:write. Private → public is a public exposure.'
  },
  { key: 'topic', label: 'Topic', kind: 'string', max: 250 },
  { key: 'purpose', label: 'Purpose', kind: 'string', max: 250 }
]

const TYPES: ResourceTypeSpec[] = [
  {
    key: CHANNEL,
    label: 'Slack channel',
    scope: 'app',
    fields: CHANNEL_FIELDS,
    capabilities: FULL,
    reversible: (field) => field !== 'visibility',
    refs: [],
    nameField: 'name',
    sends: true,
    risk(op) {
      const out: RiskFlag[] = []
      if (
        op.changes.some(
          (c) => c.field === 'visibility' && c.from === 'private' && c.to === 'public'
        )
      )
        out.push('public_exposure')
      return out
    }
  },
  {
    key: MEMBERS,
    label: 'Slack channel members',
    scope: 'app',
    fields: [
      { key: 'channel', label: 'Channel', kind: 'ref', refType: CHANNEL, required: true },
      {
        key: 'emails',
        label: 'People (emails)',
        kind: 'list',
        required: true,
        items: { key: 'email', label: 'Email', kind: 'string' },
        help: 'People are matched by their Slack email. Emails Slack does not know are listed and never guessed. Members who are not listed are left alone.'
      }
    ],
    capabilities: {
      create: true,
      update: true,
      delete: true,
      adopt: false,
      snapshot: false,
      tag: false
    },
    reversible: true,
    refs: [{ field: 'channel', type: CHANNEL, required: true }],
    risk: () => []
  },
  {
    key: BOOKMARK,
    label: 'Slack bookmark',
    scope: 'app',
    fields: [
      { key: 'channel', label: 'Channel', kind: 'ref', refType: CHANNEL, required: true },
      { key: 'title', label: 'Title', kind: 'string', required: true, max: 200 },
      {
        key: 'link',
        label: 'Link',
        kind: 'string',
        required: true,
        pattern: '^https://',
        help: 'An https address: the app’s environment or its Hub page.'
      }
    ],
    capabilities: FULL,
    reversible: true,
    refs: [{ field: 'channel', type: CHANNEL, required: true }],
    risk: () => []
  }
]

const specOf = (type: string) => TYPES.find((t) => t.key === type)
const words = (type: string, changes: FieldChange[]) => fieldWords(specOf(type)?.fields, changes)

const NEEDS: Array<{ type: string; need: string }> = [
  { type: CHANNEL, need: 'channels:manage' },
  { type: CHANNEL, need: 'channels:read' },
  { type: CHANNEL, need: 'groups:write' },
  { type: CHANNEL, need: 'groups:read' },
  { type: CHANNEL, need: 'chat:write' },
  { type: MEMBERS, need: 'users:read' },
  { type: MEMBERS, need: 'users:read.email' },
  { type: BOOKMARK, need: 'bookmarks:write' },
  { type: BOOKMARK, need: 'bookmarks:read' }
]

// ── Field cleaning ──

function cleanName(v: unknown): string {
  const s = String(v ?? '').trim()
  if (!CHANNEL_NAME.test(s))
    throw new ProviderError(
      'INVALID_FIELDS',
      'A channel name is lower-case letters, digits, dashes and underscores, up to 80 characters.'
    )
  return s
}

function cleanEmails(v: unknown): string[] {
  const list = arr(v).map((x) =>
    String(x ?? '')
      .trim()
      .toLowerCase()
  )
  const out = [...new Set(list.filter(Boolean))]
  if (out.some((e) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)))
    throw new ProviderError('INVALID_FIELDS', 'One of the emails is not an email address.')
  return out.sort()
}

function cleanLink(v: unknown): string {
  const s = String(v ?? '').trim()
  let u: URL | null = null
  try {
    u = new URL(s)
  } catch {
    u = null
  }
  if (!u || u.protocol !== 'https:' || u.username || u.password)
    throw new ProviderError('INVALID_FIELDS', 'The link must be an https address.')
  return u.toString()
}

function cleanTitle(v: unknown): string {
  const s = String(v ?? '').trim()
  if (!s || s.length > 200)
    throw new ProviderError('INVALID_FIELDS', 'The title is 1 to 200 characters.')
  return s
}

// ── Plans ──

function planChannel(desired: DesiredResource | null, observed: Observed | null): PlannedOp[] {
  const label = 'Slack channel'
  if (!desired) {
    if (!observed || observed.status === 'archived') return []
    return [
      {
        kind: 'delete',
        type: CHANNEL,
        resourceId: null,
        externalId: observed.externalId,
        reason: `Archive ${typedName(label, observed.name)} (unarchive brings it back).`,
        changes: [],
        preconditions: { name: observed.name },
        risk: []
      }
    ]
  }
  const f = desired.fields
  const want = {
    name: String(f.name ?? '').trim(),
    visibility: f.visibility === 'public' ? 'public' : 'private',
    topic: norm(f.topic) ?? null,
    purpose: norm(f.purpose) ?? null
  }
  if (!observed) {
    return [
      {
        kind: 'create',
        type: CHANNEL,
        resourceId: desired.resourceId,
        externalId: null,
        reason: `Create ${typedName(label, want.name)}. If one with this name already exists, adopt it instead.`,
        changes: (['name', 'visibility', 'topic', 'purpose'] as const)
          .filter((k) => norm(want[k]) !== null)
          .map((k) => ({ field: k, to: want[k] })),
        preconditions: {},
        risk: []
      }
    ]
  }
  const changes: FieldChange[] = []
  if (observed.status === 'archived') changes.push({ field: 'archived', from: true, to: false })
  for (const k of ['name', 'visibility', 'topic', 'purpose'] as const) {
    if (norm(want[k]) !== norm(observed.fields[k]))
      changes.push({ field: k, from: norm(observed.fields[k]), to: norm(want[k]) })
  }
  if (!changes.length) return []
  return [
    {
      kind: 'update',
      type: CHANNEL,
      resourceId: desired.resourceId,
      externalId: observed.externalId,
      reason: `Update ${typedName(label, observed.name)}: ${
        changes.some((c) => c.field === 'archived') && changes.length === 1
          ? 'unarchive it'
          : words(
              CHANNEL,
              changes.map((c) => (c.field === 'archived' ? { field: 'name' } : c))
            )
      }.`,
      changes,
      preconditions: { name: observed.name, archived: observed.status === 'archived' },
      risk: []
    }
  ]
}

function planMembers(desired: DesiredResource | null, observed: Observed | null): PlannedOp[] {
  const label = 'Slack channel members'
  if (!desired) {
    if (!observed) return []
    return [
      {
        kind: 'delete',
        type: MEMBERS,
        resourceId: null,
        externalId: observed.externalId,
        reason: `Stop managing ${typedName(label, observed.name)}. The people stay in the channel.`,
        changes: [],
        preconditions: {},
        risk: []
      }
    ]
  }
  const want = cleanEmails(desired.fields.emails)
  const have = new Set(arr(observed?.fields.emails).map(String))
  const missing = want.filter((e) => !have.has(e))
  if (observed && !missing.length) return []
  return [
    {
      kind: observed ? 'update' : 'create',
      type: MEMBERS,
      resourceId: desired.resourceId,
      externalId: observed ? observed.externalId : null,
      reason: `Add ${missing.length || want.length} ${(missing.length || want.length) === 1 ? 'person' : 'people'} to the channel by email.`,
      changes: [{ field: 'emails', from: [...have].sort(), to: want }],
      preconditions: {},
      risk: []
    }
  ]
}

function planBookmark(desired: DesiredResource | null, observed: Observed | null): PlannedOp[] {
  const label = 'Slack bookmark'
  if (!desired) {
    if (!observed) return []
    return [
      {
        kind: 'delete',
        type: BOOKMARK,
        resourceId: null,
        externalId: observed.externalId,
        reason: `Remove ${typedName(label, observed.name)} from the channel.`,
        changes: [],
        preconditions: { title: observed.name },
        risk: []
      }
    ]
  }
  const want = { title: norm(desired.fields.title), link: norm(desired.fields.link) }
  if (!observed)
    return [
      {
        kind: 'create',
        type: BOOKMARK,
        resourceId: desired.resourceId,
        externalId: null,
        reason: `Add ${typedName(label, String(want.title ?? ''))} to the channel.`,
        changes: [
          { field: 'title', to: want.title },
          { field: 'link', to: want.link }
        ],
        preconditions: {},
        risk: []
      }
    ]
  const changes: FieldChange[] = []
  for (const k of ['title', 'link'] as const)
    if (want[k] !== norm(observed.fields[k]))
      changes.push({ field: k, from: norm(observed.fields[k]), to: want[k] })
  if (!changes.length) return []
  return [
    {
      kind: 'update',
      type: BOOKMARK,
      resourceId: desired.resourceId,
      externalId: observed.externalId,
      reason: `Update ${typedName(label, observed.name)}: ${words(BOOKMARK, changes)}.`,
      changes,
      preconditions: { title: observed.name },
      risk: []
    }
  ]
}

// ── Apply ──

const ok = (
  externalId: string | null,
  observed: Observed | null,
  answer?: Record<string, unknown>
): OpResult => ({ ok: true, externalId, observed, ...(answer ? { answer } : {}) })

async function applyChannel(
  ctx: ProviderContext,
  op: PlannedOp,
  desired: DesiredResource | null
): Promise<OpResult> {
  await assertWorkspace(ctx)
  if (op.kind === 'delete') {
    const id = channelSeg(op.externalId)
    const seen = await readChannel(ctx, id)
    if (!seen) return ok(id, null)
    if (seen.status !== 'archived')
      await slackCall(
        ctx,
        'conversations.archive',
        { channel: id },
        { allow: ['already_archived'] }
      )
    return ok(id, await readChannel(ctx, id))
  }
  if (!desired) throw new ProviderError('INVALID_FIELDS', 'This change has no desired state.')
  const f = desired.fields
  if (op.kind === 'create') {
    let id = desired.externalId
    if (id) {
      // A resumed run: reuse what this run already made.
      const again = await readChannel(ctx, id)
      if (again) return ok(id, again)
    }
    const name = cleanName(f.name)
    const made = await slackCall(
      ctx,
      'conversations.create',
      { name, is_private: f.visibility !== 'public' },
      { allow: ['name_taken'] }
    )
    if (!made.ok) throw alreadyExists(`A channel named ${name} already exists`)
    id = channelSeg(asObj(made.body?.channel).id)
    const topic = str(f.topic)
    const purpose = str(f.purpose)
    if (topic) await slackCall(ctx, 'conversations.setTopic', { channel: id, topic })
    if (purpose) await slackCall(ctx, 'conversations.setPurpose', { channel: id, purpose })
    return ok(id, await readChannel(ctx, id))
  }
  // update (replace is never planned)
  const id = channelSeg(op.externalId)
  if (desired.externalId && desired.externalId !== id)
    throw new ProviderError('TARGET_MISMATCH', 'This change is for a different channel.')
  const seen = await readChannel(ctx, id)
  if (!seen) throw new ProviderError('NOT_FOUND', 'The channel is gone at Slack.', { status: 404 })
  const fields = new Set(op.changes.map((c) => c.field))
  if (fields.has('archived') && seen.status === 'archived')
    await slackCall(ctx, 'conversations.unarchive', { channel: id }, { allow: ['not_archived'] })
  if (fields.has('name') && f.name !== seen.fields.name) {
    const name = cleanName(f.name)
    const r = await slackCall(
      ctx,
      'conversations.rename',
      { channel: id, name },
      { allow: ['name_taken'] }
    )
    if (!r.ok) throw alreadyExists(`A channel named ${name} already exists`)
  }
  if (fields.has('topic'))
    await slackCall(
      ctx,
      'conversations.setTopic',
      { channel: id, topic: str(f.topic) ?? '' },
      {
        allow: ['no_channel_topic']
      }
    )
  if (fields.has('purpose'))
    await slackCall(ctx, 'conversations.setPurpose', {
      channel: id,
      purpose: str(f.purpose) ?? ''
    })
  if (fields.has('visibility')) {
    const to = f.visibility === 'public' ? 'public' : 'private'
    if (to !== seen.fields.visibility)
      await slackCall(
        ctx,
        to === 'public'
          ? 'admin.conversations.convertToPublic'
          : 'admin.conversations.convertToPrivate',
        { channel_id: id }
      )
  }
  return ok(id, await readChannel(ctx, id))
}

async function applyMembers(
  ctx: ProviderContext,
  op: PlannedOp,
  desired: DesiredResource | null
): Promise<OpResult> {
  await assertWorkspace(ctx)
  if (op.kind === 'delete') return ok(op.externalId, null)
  if (!desired) throw new ProviderError('INVALID_FIELDS', 'This change has no desired state.')
  const channel = channelSeg(refOne(desired, 'channel'))
  if (op.externalId && op.externalId !== channel)
    throw new ProviderError('TARGET_MISMATCH', 'This change is for a different channel.')
  if (!(await readChannel(ctx, channel)))
    throw new ProviderError('NOT_FOUND', 'The channel is gone at Slack.', { status: 404 })
  const emails = cleanEmails(desired.fields.emails)
  const have = new Set((await memberIds(ctx, channel)) ?? [])
  const toAdd: string[] = []
  const unmatched: string[] = []
  for (const email of emails) {
    const r = await slackCall(ctx, 'users.lookupByEmail', { email }, { allow: ['users_not_found'] })
    const id = r.ok ? str(asObj(r.body?.user).id) : null
    if (!id) unmatched.push(email)
    else if (!have.has(id)) toAdd.push(userSeg(id))
  }
  for (let i = 0; i < toAdd.length; i += 100)
    await slackCall(
      ctx,
      'conversations.invite',
      { channel, users: toAdd.slice(i, i + 100).join(',') },
      { allow: ['already_in_channel'] }
    )
  return ok(channel, await readMembers(ctx, channel), {
    added: toAdd.length,
    unmatched
  })
}

async function applyBookmark(
  ctx: ProviderContext,
  op: PlannedOp,
  desired: DesiredResource | null
): Promise<OpResult> {
  await assertWorkspace(ctx)
  if (op.kind === 'delete') {
    const [channel, id] = splitBookmark(String(op.externalId ?? ''))
    if (!(await readBookmark(ctx, `${channel}/${id}`))) return ok(op.externalId, null)
    await slackCall(
      ctx,
      'bookmarks.remove',
      { channel_id: channel, bookmark_id: id },
      { allow: ['bookmark_not_found'] }
    )
    return ok(op.externalId, null)
  }
  if (!desired) throw new ProviderError('INVALID_FIELDS', 'This change has no desired state.')
  const channel = channelSeg(refOne(desired, 'channel'))
  const title = cleanTitle(desired.fields.title)
  const link = cleanLink(desired.fields.link)
  if (op.kind === 'create') {
    if (desired.externalId) {
      const again = await readBookmark(ctx, desired.externalId)
      if (again) return ok(desired.externalId, again)
    }
    const list = (await readBookmarks(ctx, channel)) ?? []
    if (list.some((b) => asObj(b).link === link))
      throw alreadyExists('A bookmark with this link already exists in the channel')
    const r = await slackCall(ctx, 'bookmarks.add', {
      channel_id: channel,
      title,
      type: 'link',
      link
    })
    const id = bookmarkSeg(asObj(r.body?.bookmark).id)
    return ok(
      `${channel}/${id}`,
      bookmarkObserved(channel, { ...asObj(r.body?.bookmark), title, link })
    )
  }
  const [ch, id] = splitBookmark(String(op.externalId ?? ''))
  if (ch !== channel)
    throw new ProviderError('TARGET_MISMATCH', 'This change is for a bookmark in another channel.')
  await slackCall(ctx, 'bookmarks.edit', { channel_id: ch, bookmark_id: id, title, link })
  return ok(op.externalId, await readBookmark(ctx, `${ch}/${id}`))
}

// ── Notify ──

/** Slack mrkdwn control characters (`& < >`) are escaped so a title or body cannot make a link. */
function mrkdwn(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

const SEVERITY_LABEL: Record<OutboundMessage['severity'], string> = {
  info: ':information_source: Info',
  warning: ':warning: Warning',
  critical: ':rotating_light: Critical'
}

export function cardBlocks(msg: OutboundMessage): unknown[] {
  const blocks: unknown[] = [
    { type: 'header', text: { type: 'plain_text', text: msg.title.slice(0, 150), emoji: false } }
  ]
  if (msg.body)
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: mrkdwn(msg.body).slice(0, 2900) }
    })
  blocks.push({
    type: 'context',
    elements: [{ type: 'mrkdwn', text: SEVERITY_LABEL[msg.severity] ?? SEVERITY_LABEL.info }]
  })
  if (msg.link && /^https:\/\//i.test(msg.link))
    blocks.push({
      type: 'actions',
      elements: [
        { type: 'button', text: { type: 'plain_text', text: 'Open in the Hub' }, url: msg.link }
      ]
    })
  return blocks
}

async function notifyChannel(
  ctx: ProviderContext,
  resource: HubResourceRow,
  msg: OutboundMessage
): Promise<OpResult> {
  try {
    await assertWorkspace(ctx)
    const channel = channelSeg(resource.external_id)
    const threadKey = msg.dedupKey ? `thread:${channel}:${msg.dedupKey}`.slice(0, 250) : null
    const threadTs = threadKey ? ctx.tokens.get(threadKey) : null
    const text = `${msg.title}${msg.body ? `: ${msg.body}` : ''}`.slice(0, 3000)
    const r = await slackCall(ctx, 'chat.postMessage', {
      channel,
      text: mrkdwn(text),
      blocks: msg.kind === 'card' || msg.link || msg.body ? cardBlocks(msg) : undefined,
      thread_ts: threadTs ?? undefined,
      unfurl_links: false,
      unfurl_media: false
    })
    const ts = str(r.body?.ts)
    if (threadKey && ts) {
      if (msg.action === 'resolve') ctx.tokens.delete(threadKey)
      else if (!threadTs)
        ctx.tokens.set(threadKey, ts, new Date(ctx.now().getTime() + THREAD_TTL_MS))
    }
    return {
      ok: true,
      externalId: channel,
      observed: null,
      answer: { ts, threaded: Boolean(threadTs) }
    }
  } catch (err) {
    if (err instanceof ProviderError)
      return {
        ok: false,
        externalId: resource.external_id,
        observed: null,
        error: {
          code: err.code,
          message: ctx.scrub(err.message),
          retryable: err.retryable,
          ...(err.status !== undefined ? { status: err.status } : {})
        }
      }
    throw err
  }
}

// ── The adapter ──

export const slackAdapter: ProviderAdapter = {
  key: 'slack',
  label: 'Slack',
  connection: {
    fields: [
      {
        key: 'team_id',
        label: 'Workspace id',
        kind: 'string',
        required: true,
        placeholder: 'T0123ABCD',
        help: 'Pinned: every call checks the bot token belongs to this workspace.'
      },
      {
        key: 'token',
        label: 'Bot token',
        kind: 'string',
        secret: true,
        required: true,
        placeholder: 'xoxb-…',
        help: 'From the Slack app you installed: scopes channels:manage, channels:read, groups:write, groups:read, chat:write, users:read, users:read.email, bookmarks:write, bookmarks:read.'
      }
    ],
    hosts: () => [SLACK_HOST],
    describe: (config) => `Slack workspace ${teamOf(config) || '(not set)'}`,
    validate(config, secrets) {
      const problems: string[] = []
      const t = teamProblem(config.team_id)
      if (t) problems.push(t)
      if (secrets.token !== undefined) {
        if (!secrets.token.trim()) problems.push('The bot token is empty.')
        else if (!secrets.token.trim().startsWith('xoxb-'))
          problems.push('The token must be a bot token (it starts with xoxb-).')
      }
      return problems
    }
  },
  types: TYPES,

  async testConnection(ctx): Promise<ConnectionTest> {
    const perms = (has: (need: string) => boolean) =>
      NEEDS.map((n) => ({ type: n.type, need: n.need, has: has(n.need) }))
    const fail = (message: string): ConnectionTest => {
      const p = perms(() => false)
      return { ok: false, identity: null, permissions: p, missing: p.map((x) => x.need), message }
    }
    let r: SlackAnswer
    try {
      r = await slackCall(ctx, 'auth.test')
    } catch (err) {
      if (err instanceof ProviderError) return fail(ctx.scrub(err.message))
      throw err
    }
    const team = String(r.body?.team_id ?? '')
    const enterprise = String(r.body?.enterprise_id ?? '')
    if (team !== teamOf(ctx.config) && enterprise !== teamOf(ctx.config))
      return fail('This bot token belongs to a different Slack workspace than the one named.')
    const header = r.headers.get('x-oauth-scopes')
    const scopes = new Set(
      (header ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    )
    const p = perms((need) => scopes.has(need))
    const missing = p.filter((x) => !x.has).map((x) => x.need)
    return {
      ok: scopes.has('chat:write') || !header,
      identity: `${r.body?.team ?? team} as ${r.body?.user ?? 'bot'}`,
      permissions: p,
      missing,
      ...(header ? {} : { message: 'Slack did not list the token’s scopes.' })
    }
  },

  async observe(ctx, type, externalId) {
    if (type === CHANNEL) return readChannel(ctx, externalId)
    if (type === MEMBERS) return readMembers(ctx, channelSeg(externalId))
    if (type === BOOKMARK) return readBookmark(ctx, externalId)
    throw new ProviderError('UNKNOWN_TYPE', `Slack has no ${type}.`)
  },

  async list(ctx, type, cursor): Promise<ListPage> {
    if (type === MEMBERS) return { items: [], cursor: null }
    if (type === CHANNEL) {
      const { items, next } = await listChannels(ctx, cursor ?? null)
      return { items: items.map((c) => channelObserved(ctx, c)), cursor: next }
    }
    if (type !== BOOKMARK) throw new ProviderError('UNKNOWN_TYPE', `Slack has no ${type}.`)
    const { items, next } = await listChannels(ctx, cursor ?? null, 20)
    const out: Observed[] = []
    for (const c of items) {
      if (c.is_archived) continue
      for (const b of (await readBookmarks(ctx, String(c.id))) ?? [])
        out.push(bookmarkObserved(String(c.id), b))
    }
    return { items: out, cursor: next }
  },

  async findExisting(ctx, type, desired): Promise<Observed | null> {
    if (type !== CHANNEL) return null
    const name = String(desired.fields.name ?? '').trim()
    if (!name) return null
    let cursor: string | null = null
    for (let i = 0; i < 5; i++) {
      const { items, next } = await listChannels(ctx, cursor)
      const hit = items.find((c) => c.name === name)
      if (hit) return channelObserved(ctx, hit)
      cursor = next
      if (!cursor) break
    }
    return null
  },

  plan(_ctx, desired, observed) {
    const type = desired?.type ?? observed?.type
    if (type === CHANNEL) return planChannel(desired, observed)
    if (type === MEMBERS) return planMembers(desired, observed)
    if (type === BOOKMARK) return planBookmark(desired, observed)
    throw new ProviderError('UNKNOWN_TYPE', `Slack has no ${String(type)}.`)
  },

  async apply(ctx, op, desired) {
    if (op.kind === 'noop') return ok(op.externalId, null)
    if (op.type === CHANNEL) return applyChannel(ctx, op, desired)
    if (op.type === MEMBERS) return applyMembers(ctx, op, desired)
    if (op.type === BOOKMARK) return applyBookmark(ctx, op, desired)
    throw new ProviderError('UNKNOWN_TYPE', `Slack has no ${op.type}.`)
  },

  async notify(ctx, resource, msg) {
    if (resource.type !== CHANNEL)
      return {
        ok: false,
        externalId: resource.external_id,
        observed: null,
        error: {
          code: 'NOT_A_SENDER',
          message: 'Only a Slack channel sends messages.',
          retryable: false
        }
      }
    return notifyChannel(ctx, resource, msg)
  },

  async health(ctx, type, externalId): Promise<HealthAnswer> {
    const checkedAt = ctx.now().toISOString()
    const seen = await this.observe(ctx, type, externalId)
    if (!seen) return { status: 'down', message: 'It is gone at Slack.', checkedAt }
    if (type === CHANNEL && seen.status === 'archived')
      return { status: 'warn', message: 'The channel is archived.', checkedAt }
    return { status: 'ok', checkedAt }
  }
}
