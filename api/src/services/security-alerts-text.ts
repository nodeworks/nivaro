/**
 * Security alerts (SOC 2 CC7) — the pure half: event shapes, what counts as a widening, and the
 * plain-words notice built from a coalesced batch. No database, no Redis, no clock: everything
 * here is testable on its own (services/security-alerts.ts does the I/O).
 *
 * House rules for the text: who did what to whom, in names; never an id, a status code or SQL.
 * Links carry ids (they have to) but the words never do.
 */

/** The event families an administrator can switch on or off. */
export type SecurityAlertKind =
  | 'user_role'
  | 'role_permissions'
  | 'api_key'
  | 'access_denied'
  | 'admin_signin'

/** Who made a change when it was not a person signed in (directory groups, SCIM, …). */
export type SecuritySource = 'person' | 'directory' | 'scim' | 'system' | 'hub'

export interface UserRoleEvent {
  kind: 'user_role'
  actor: string | null
  source?: SecuritySource
  userId: string
  fromRole: string | null
  toRole: string | null
  /** The account was created with this role (not a change). */
  created?: boolean
  /** Filled in at raise time so the gate and the text agree. */
  fromAdmin?: boolean
  toAdmin?: boolean
  fromName?: string | null
  toName?: string | null
}

export interface RolePermissionsEvent {
  kind: 'role_permissions'
  actor: string | null
  roleId: string
  roleName: string
  /** One plain sentence: "Can now create Purchase orders." */
  change: string
  /** The role itself gained or lost administrator rights. */
  adminChange?: 'granted' | 'removed'
  /** People holding the role when it gained administrator rights. */
  members?: number
}

export interface ApiKeyEvent {
  kind: 'api_key'
  actor: string | null
  keyId: string
  keyName: string
  ownerId: string | null
  change: 'created' | 'widened'
  /** Plain sentences: what the key may do (created) or how its access grew (widened). */
  reasons: string[]
}

export interface AccessDeniedEvent {
  kind: 'access_denied'
  caller: { type: 'user' | 'api_key' | 'address'; id: string; label?: string | null }
  count: number
  minutes: number
}

export interface AdminSigninEvent {
  kind: 'admin_signin'
  userId: string
  device: string | null
}

export type SecurityEvent =
  | UserRoleEvent
  | RolePermissionsEvent
  | ApiKeyEvent
  | AccessDeniedEvent
  | AdminSigninEvent

/** Which events collapse into one notice: same family, same actor (or one bucket per family). */
export function coalesceGroup(ev: SecurityEvent): string {
  switch (ev.kind) {
    case 'user_role':
    case 'role_permissions':
    case 'api_key':
      return `${ev.kind}:${ev.actor ? String(ev.actor).toUpperCase() : ((ev as UserRoleEvent).source ?? 'system')}`
    case 'access_denied':
    case 'admin_signin':
      return ev.kind
  }
}

/** The actor of an event, when it has one (they are not told about their own change). */
export function eventActor(ev: SecurityEvent): string | null {
  return 'actor' in ev && ev.actor ? String(ev.actor) : null
}

// ─── Small wording helpers ──────────────────────────────────────────────────

/** `purchase_orders` → `Purchase orders`; `*` → `every collection`. */
export function collectionWords(c: string): string {
  if (!c || c === '*') return 'every collection'
  const s = c
    .replace(/^nivaro_/i, '')
    .replace(/[_-]+/g, ' ')
    .trim()
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : c
}

const VERBS: Record<string, string> = {
  read: 'read',
  create: 'create',
  update: 'change',
  delete: 'delete',
  share: 'share',
  '*': 'do anything with'
}

export function actionWords(a: string): string {
  return VERBS[a] ?? a
}

function listWords(items: string[], max = 4): string {
  const shown = items.slice(0, max)
  const more = items.length - shown.length
  const head =
    shown.length <= 1
      ? (shown[0] ?? '')
      : `${shown.slice(0, -1).join(', ')} and ${shown[shown.length - 1]}`
  return more > 0 ? `${shown.join(', ')} and ${more} more` : head
}

// ─── Policy / role change sentences (used by routes/roles.ts) ───────────────

export function policyAddedSentence(collection: string, action: string): string {
  return `Can now ${actionWords(action)} ${collectionWords(collection)}.`
}

export function policyRemovedSentence(collection: string, action: string): string {
  return `Can no longer ${actionWords(action)} ${collectionWords(collection)}.`
}

export function policyChangedSentence(
  collection: string,
  action: string,
  what: { fields?: boolean; rowFilterRemoved?: boolean; rowFilter?: boolean }
): string | null {
  const parts: string[] = []
  if (what.fields) parts.push('which fields it may use')
  if (what.rowFilterRemoved) parts.push('removed its record filter (every record now counts)')
  else if (what.rowFilter) parts.push('which records it may reach')
  if (parts.length === 0) return null
  return `Changed ${parts.join(' and ')} for "${actionWords(action)} ${collectionWords(collection)}".`
}

const truthy = (v: unknown) => v === true || v === 1 || v === '1' || v === 'true'

/** Role columns an edit may touch that say nothing about access. */
const ROLE_QUIET_KEYS = new Set([
  'id',
  'name',
  'description',
  'icon',
  'color',
  'sort',
  'admin_access',
  'app_access',
  'ui_permissions',
  'workspace',
  'created_at',
  'updated_at'
])

/**
 * A role edit (PATCH /roles/:id) in sentences: administrator rights, app sign-in, a rename and any
 * other access setting. A description-only edit says nothing.
 */
export function roleEditSentences(
  before: Record<string, unknown>,
  after: Record<string, unknown>
): { changes: string[]; adminChange?: 'granted' | 'removed'; adminSentence?: string } {
  const changes: string[] = []
  let adminChange: 'granted' | 'removed' | undefined
  let adminSentence: string | undefined
  if (truthy(before.admin_access) !== truthy(after.admin_access)) {
    adminChange = truthy(after.admin_access) ? 'granted' : 'removed'
    adminSentence =
      adminChange === 'granted' ? 'Given administrator rights.' : 'Administrator rights removed.'
    changes.push(adminSentence)
  }
  if (truthy(before.app_access) !== truthy(after.app_access))
    changes.push(
      truthy(after.app_access) ? 'Can now sign in to the app.' : 'Can no longer sign in to the app.'
    )
  if (String(before.name ?? '') !== String(after.name ?? '') && before.name != null)
    changes.push(`Renamed from ${String(before.name)} to ${String(after.name ?? '')}.`)
  const other = Object.keys(after).filter(
    (k) =>
      !ROLE_QUIET_KEYS.has(k) &&
      JSON.stringify(before[k] ?? null) !== JSON.stringify(after[k] ?? null)
  )
  if (other.length)
    changes.push(
      `Changed its ${listWords(other.map((k) => k.replace(/_/g, ' ')))} setting${other.length === 1 ? '' : 's'}.`
    )
  return { changes, adminChange, adminSentence }
}

// ─── API key widening (used by routes/api-keys.ts) ──────────────────────────

export interface KeyScope {
  collection: string
  actions: string[]
}

export interface KeyShape {
  scopes: KeyScope[]
  scope_restrictions: Array<{ dimension: string; values: Array<string | number> }> | null
  ip_allowlist: string[]
  sandbox: boolean
  is_active: boolean
  expires_at: Date | string | null
}

function covers(scopes: KeyScope[], collection: string, action: string): boolean {
  return scopes.some(
    (s) =>
      (s.collection === '*' || s.collection === collection) &&
      (s.actions.includes('*') || s.actions.includes(action))
  )
}

/** What a key may do, in words: "full access to every collection", "read Projects and …". */
export function describeKeyScopes(scopes: KeyScope[]): string {
  if (scopes.length === 0) return 'no access yet'
  if (covers(scopes, '*', '*')) return 'full access to every collection'
  const parts = scopes.map((s) => {
    const verbs = s.actions.includes('*') ? ['do anything with'] : s.actions.map(actionWords)
    return `${listWords(verbs)} ${collectionWords(s.collection)}`
  })
  return listWords(parts, 3)
}

function time(v: Date | string | null): number | null {
  if (v == null || v === '') return null
  const t = new Date(v).getTime()
  return Number.isFinite(t) ? t : null
}

/**
 * How `after` reaches further than `before` — one sentence per way, empty when it does not.
 * A narrower key, a renamed key or a lower rate limit say nothing.
 */
export function apiKeyWidening(before: KeyShape, after: KeyShape): string[] {
  const out: string[] = []
  const gained: string[] = []
  for (const s of after.scopes) {
    for (const a of s.actions) {
      if (!covers(before.scopes, s.collection, a))
        gained.push(`${actionWords(a)} ${collectionWords(s.collection)}`)
    }
  }
  if (gained.length) out.push(`It can now ${listWords([...new Set(gained)])}.`)

  const rb = before.scope_restrictions ?? []
  const ra = after.scope_restrictions ?? []
  if (rb.length > 0) {
    const loosened = rb.some((r) => {
      const now = ra.find((x) => x.dimension === r.dimension)
      if (!now) return true
      const was = new Set(r.values.map(String))
      return now.values.some((v) => !was.has(String(v)))
    })
    if (ra.length === 0) out.push('It is no longer limited to a slice of the records.')
    else if (loosened) out.push('Its record limits were loosened.')
  }

  if (before.ip_allowlist.length > 0) {
    if (after.ip_allowlist.length === 0) out.push('It can now be used from any network address.')
    else if (after.ip_allowlist.some((ip) => !before.ip_allowlist.includes(ip)))
      out.push('It accepts more network addresses.')
  }
  if (before.sandbox && !after.sandbox)
    out.push('Its writes are now saved (it was rehearsal-only).')
  if (!before.is_active && after.is_active) out.push('It was switched back on.')
  const eb = time(before.expires_at)
  const ea = time(after.expires_at)
  if (eb != null && ea == null) out.push('It no longer expires.')
  else if (eb != null && ea != null && ea > eb) out.push('It now expires later.')
  return out
}

// ─── The notice ─────────────────────────────────────────────────────────────

export interface NoticeContext {
  /** Display names by upper-case user id. */
  names: Map<string, string>
  /** API key names by id (for access_denied callers that are keys). */
  keyNames?: Map<string, string>
}

export interface SecurityNotice {
  kind: SecurityAlertKind
  subject: string
  message: string
  /** Admin-app path (no origin) the notice opens. */
  path: string
  /** What it is about, for the activity log row. */
  collection: string | null
  item: string | null
  /** People not to tell (the actor of their own change). Upper-case ids. */
  exclude: string[]
}

const MAX_LINES = 8

function nameOf(ctx: NoticeContext, id: string | null | undefined): string {
  if (!id) return 'Someone'
  return ctx.names.get(String(id).toUpperCase()) ?? 'Someone'
}

function actorWords(ctx: NoticeContext, ev: { actor: string | null; source?: SecuritySource }) {
  if (ev.actor) return nameOf(ctx, ev.actor)
  if (ev.source === 'directory') return 'Directory group mapping'
  if (ev.source === 'scim') return 'SCIM provisioning'
  if (ev.source === 'hub') return 'The Nivaro Hub'
  return 'The system'
}

function roleWords(name: string | null | undefined): string {
  return name?.trim() ? name.trim() : 'no role'
}

function bullets(lines: string[]): string {
  const shown = lines.slice(0, MAX_LINES)
  const more = lines.length - shown.length
  return shown.join(' ') + (more > 0 ? ` …and ${more} more.` : '')
}

function userRoleNotice(evs: UserRoleEvent[], ctx: NoticeContext): SecurityNotice {
  const first = evs[0]
  const who = actorWords(ctx, first)
  const by = first.source === 'directory' ? ' at sign-in' : ''
  const exclude = first.actor ? [String(first.actor).toUpperCase()] : []
  const gained = evs.filter((e) => e.toAdmin && !e.fromAdmin)
  const lost = evs.filter((e) => e.fromAdmin && !e.toAdmin)
  if (evs.length === 1) {
    const e = first
    const person = nameOf(ctx, e.userId)
    const path = `/users/${encodeURIComponent(e.userId)}`
    if (e.created) {
      return {
        kind: 'user_role',
        subject: `Security: new administrator account for ${person}`,
        message: `${who} created an account for ${person} with the ${roleWords(e.toName)} role${by}, which has administrator rights.`,
        path,
        collection: 'nivaro_users',
        item: e.userId,
        exclude
      }
    }
    const subject = gained.length
      ? `Security: ${person} was given administrator rights`
      : lost.length
        ? `Security: ${person} no longer has administrator rights`
        : `Security: ${person}'s role was changed`
    return {
      kind: 'user_role',
      subject,
      message: `${who} changed ${person}'s role from ${roleWords(e.fromName)} to ${roleWords(e.toName)}${by}.`,
      path,
      collection: 'nivaro_users',
      item: e.userId,
      exclude
    }
  }
  const lines = evs.map((e) => {
    const person = nameOf(ctx, e.userId)
    const note =
      e.toAdmin && !e.fromAdmin
        ? ' (now an administrator)'
        : e.fromAdmin && !e.toAdmin
          ? ' (no longer an administrator)'
          : ''
    return e.created
      ? `${person}: new account as ${roleWords(e.toName)}${note}.`
      : `${person}: ${roleWords(e.fromName)} → ${roleWords(e.toName)}${note}.`
  })
  const people = new Set(evs.map((e) => e.userId.toUpperCase())).size
  const adminBits: string[] = []
  if (gained.length) adminBits.push(`${gained.length} gained administrator rights`)
  if (lost.length) adminBits.push(`${lost.length} lost them`)
  return {
    kind: 'user_role',
    subject: `Security: ${who} changed the roles of ${people} people${adminBits.length ? ` — ${adminBits.join(', ')}` : ''}`,
    message: bullets(lines),
    path: '/users',
    collection: 'nivaro_users',
    item: null,
    exclude
  }
}

function rolePermissionsNotice(evs: RolePermissionsEvent[], ctx: NoticeContext): SecurityNotice {
  const first = evs[0]
  const who = actorWords(ctx, first)
  const exclude = first.actor ? [String(first.actor).toUpperCase()] : []
  const roles = [...new Map(evs.map((e) => [e.roleId.toUpperCase(), e])).values()]
  const granted = evs.filter((e) => e.adminChange === 'granted')
  if (roles.length === 1) {
    const r = first
    const path = `/roles?role=${encodeURIComponent(r.roleId)}`
    const members = granted.find((e) => e.members != null)?.members
    const subject = granted.length
      ? `Security: the ${r.roleName} role was given administrator rights`
      : evs.some((e) => e.adminChange === 'removed')
        ? `Security: the ${r.roleName} role no longer has administrator rights`
        : `Security: ${who} changed the ${r.roleName} role's permissions`
    const tail =
      granted.length && members != null
        ? ` ${members === 1 ? 'Its 1 member is' : `Its ${members} members are`} now ${members === 1 ? 'an administrator' : 'administrators'}.`
        : ''
    return {
      kind: 'role_permissions',
      subject,
      message: `${who} changed the ${r.roleName} role. ${bullets(evs.map((e) => e.change))}${tail}`,
      path,
      collection: 'nivaro_roles',
      item: r.roleId,
      exclude
    }
  }
  const lines = roles.map((r) => {
    const own = evs.filter((e) => e.roleId.toUpperCase() === r.roleId.toUpperCase())
    return `${r.roleName}: ${own.length} ${own.length === 1 ? 'change' : 'changes'}${own.some((e) => e.adminChange === 'granted') ? ', now has administrator rights' : ''}.`
  })
  return {
    kind: 'role_permissions',
    subject: `Security: ${who} changed the permissions of ${roles.length} roles${granted.length ? ' — one was given administrator rights' : ''}`,
    message: bullets(lines),
    path: '/roles',
    collection: 'nivaro_roles',
    item: null,
    exclude
  }
}

function apiKeyNotice(evs: ApiKeyEvent[], ctx: NoticeContext): SecurityNotice {
  const first = evs[0]
  const who = actorWords(ctx, first)
  const exclude = first.actor ? [String(first.actor).toUpperCase()] : []
  const keys = [...new Map(evs.map((e) => [e.keyId, e])).values()]
  if (keys.length === 1) {
    const created = evs.find((e) => e.change === 'created')
    const owner = first.ownerId ? nameOf(ctx, first.ownerId) : null
    const reasons = [...new Set(evs.flatMap((e) => e.reasons))]
    return {
      kind: 'api_key',
      subject: created
        ? `Security: ${who} created the API key "${first.keyName}"`
        : `Security: ${who} gave the API key "${first.keyName}" more access`,
      message: created
        ? `The key acts as ${owner ?? 'its owner'} with ${reasons[0] ?? 'the access it was given'}.${reasons.length > 1 ? ` ${bullets(reasons.slice(1))}` : ''}`
        : bullets(reasons),
      path: `/api-keys?key=${encodeURIComponent(first.keyId)}`,
      collection: 'nivaro_api_keys',
      item: first.keyId,
      exclude
    }
  }
  const createdN = keys.filter((k) =>
    evs.some((e) => e.keyId === k.keyId && e.change === 'created')
  )
  const lines = keys.map((k) => {
    const made = createdN.includes(k)
    return `"${k.keyName}": ${made ? 'created' : 'given more access'}.`
  })
  return {
    kind: 'api_key',
    subject: `Security: ${who} created or widened ${keys.length} API keys`,
    message: bullets(lines),
    path: '/api-keys',
    collection: 'nivaro_api_keys',
    item: null,
    exclude
  }
}

function callerWords(ev: AccessDeniedEvent, ctx: NoticeContext): string {
  const c = ev.caller
  if (c.type === 'user') return nameOf(ctx, c.id)
  if (c.type === 'api_key') {
    const name = ctx.keyNames?.get(String(c.id)) ?? c.label
    return name ? `the API key "${name}"` : 'an API key'
  }
  return `the network address ${c.id}`
}

function callerPath(ev: AccessDeniedEvent): string {
  const c = ev.caller
  if (c.type === 'user') return `/users/${encodeURIComponent(c.id)}?tab=activity`
  if (c.type === 'api_key') return `/api-keys?key=${encodeURIComponent(c.id)}`
  return '/security-center'
}

function accessDeniedNotice(evs: AccessDeniedEvent[], ctx: NoticeContext): SecurityNotice {
  const first = evs[0]
  if (evs.length === 1) {
    const who = callerWords(first, ctx)
    const Who = who.charAt(0).toUpperCase() + who.slice(1)
    return {
      kind: 'access_denied',
      subject: `Security: ${who} was refused access ${first.count} times in ${first.minutes} minutes`,
      message: `${Who} kept asking for things they are not allowed to see or change: ${first.count} refusals within ${first.minutes} minutes. It can be a page or integration set up wrongly, or someone probing for access they do not have. The link shows who it is and what they did.`,
      path: callerPath(first),
      collection:
        first.caller.type === 'user'
          ? 'nivaro_users'
          : first.caller.type === 'api_key'
            ? 'nivaro_api_keys'
            : null,
      item: first.caller.type === 'address' ? null : first.caller.id,
      exclude: []
    }
  }
  const lines = evs.map((e) => {
    const who = callerWords(e, ctx)
    return `${who.charAt(0).toUpperCase() + who.slice(1)}: ${e.count} refusals in ${e.minutes} minutes.`
  })
  return {
    kind: 'access_denied',
    subject: `Security: ${evs.length} callers were refused access over and over`,
    message: `${bullets(lines)} It can be a page or integration set up wrongly, or someone probing for access they do not have.`,
    path: '/security-center',
    collection: null,
    item: null,
    exclude: []
  }
}

function adminSigninNotice(evs: AdminSigninEvent[], ctx: NoticeContext): SecurityNotice {
  const people = [...new Map(evs.map((e) => [e.userId.toUpperCase(), e])).values()]
  if (people.length === 1) {
    const e = people[0]
    const person = nameOf(ctx, e.userId)
    return {
      kind: 'admin_signin',
      subject: `Security: administrator ${person} signed in from a new location`,
      message: `${person}, an administrator, signed in from a network address not seen for them in the last 90 days${e.device ? `, using ${e.device}` : ''}. If that is unexpected, check their sessions on Security & privacy and sign them out there.`,
      path: `/users/${encodeURIComponent(e.userId)}`,
      collection: 'nivaro_users',
      item: e.userId,
      exclude: [e.userId.toUpperCase()]
    }
  }
  return {
    kind: 'admin_signin',
    subject: `Security: ${people.length} administrators signed in from new locations`,
    message: `${listWords(
      people.map((p) => nameOf(ctx, p.userId)),
      MAX_LINES
    )} signed in from network addresses not seen for them in the last 90 days. If that is unexpected, check their sessions on Security & privacy.`,
    path: '/security-center',
    collection: 'nivaro_users',
    item: null,
    exclude: []
  }
}

/** One notice for one coalesced batch (all events share a family; empty batch → null). */
export function buildSecurityNotice(
  evs: SecurityEvent[],
  ctx: NoticeContext
): SecurityNotice | null {
  if (evs.length === 0) return null
  switch (evs[0].kind) {
    case 'user_role':
      return userRoleNotice(evs as UserRoleEvent[], ctx)
    case 'role_permissions':
      return rolePermissionsNotice(evs as RolePermissionsEvent[], ctx)
    case 'api_key':
      return apiKeyNotice(evs as ApiKeyEvent[], ctx)
    case 'access_denied':
      return accessDeniedNotice(evs as AccessDeniedEvent[], ctx)
    case 'admin_signin':
      return adminSigninNotice(evs as AdminSigninEvent[], ctx)
  }
}

/** Every user id a batch names (to look their names up once). */
export function namedUsers(evs: SecurityEvent[]): string[] {
  const ids = new Set<string>()
  for (const e of evs) {
    if ('actor' in e && e.actor) ids.add(String(e.actor))
    if (e.kind === 'user_role' || e.kind === 'admin_signin') ids.add(e.userId)
    if (e.kind === 'api_key' && e.ownerId) ids.add(e.ownerId)
    if (e.kind === 'access_denied' && e.caller.type === 'user') ids.add(e.caller.id)
  }
  return [...ids]
}
