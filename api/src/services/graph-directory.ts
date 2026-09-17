import { config } from '../config.js'
import { db } from '../db/index.js'
import { overlaySettings } from './settings-overrides.js'

// ─── Microsoft Graph directory ───────────────────────────────────────────────
// Login enrichment (auth/oidc.ts) reads /me with the PERSON's token, so it only
// ever knows about people who have signed in. This service reads ANY tenant
// user with the app's own client-credentials token, which needs User.Read.All
// (or Directory.Read.All) granted as an APPLICATION permission and admin-
// consented. Until that consent exists the token issues fine but carries no
// `roles` claim and every /users call 403s — `directoryStatus()` reports
// exactly that so the UI can say what to flip instead of shrugging.
//
// Alternatively (nivaro_settings.directory_auth_mode = 'service_account') the
// lookups sign in as a named SERVICE ACCOUNT with a password (the OAuth
// password grant against the same app registration): the grant is then a
// DELEGATED User.Read.All and rides the token's `scp` claim instead of `roles`.

export type DirectoryUser = {
  id: string
  display_name: string | null
  first_name: string | null
  last_name: string | null
  email: string | null
  upn: string | null
  title: string | null
  department: string | null
  company: string | null
  office_location: string | null
  city: string | null
  state: string | null
  country: string | null
  phone: string | null
  business_phones: string[]
  employee_id: string | null
  preferred_language: string | null
  account_enabled: boolean | null
}

export type DirectoryStatus = {
  configured: boolean
  granted: boolean
  roles: string[]
  tenant: string | null
  reason: string | null
  auth_mode: 'app' | 'service_account'
  username: string | null
}

export type DirectoryIdentity = {
  mode: 'app' | 'service_account'
  username: string | null
  password: string | null
}

/** Which identity the lookups use — from nivaro_settings (per-instance overlay applies). */
export async function directoryIdentity(): Promise<DirectoryIdentity> {
  try {
    const raw = (await db('nivaro_settings')
      .select('directory_auth_mode', 'directory_username', 'directory_password')
      .orderBy('id', 'asc')
      .first()) as Record<string, unknown> | undefined
    const row = await overlaySettings(raw ?? {})
    const username = typeof row.directory_username === 'string' ? row.directory_username.trim() : ''
    const password = typeof row.directory_password === 'string' ? row.directory_password : ''
    const mode =
      row.directory_auth_mode === 'service_account' && username && password
        ? 'service_account'
        : 'app'
    return { mode, username: username || null, password: password || null }
  } catch {
    return { mode: 'app', username: null, password: null }
  }
}

export class DirectoryError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly code: string
  ) {
    super(message)
    this.name = 'DirectoryError'
  }
}

const GRANT_ROLES = [
  'User.Read.All',
  'User.ReadWrite.All',
  'Directory.Read.All',
  'Directory.ReadWrite.All'
]

const USER_SELECT = [
  'id',
  'displayName',
  'givenName',
  'surname',
  'mail',
  'userPrincipalName',
  'jobTitle',
  'department',
  'companyName',
  'officeLocation',
  'city',
  'state',
  'country',
  'mobilePhone',
  'businessPhones',
  'employeeId',
  'preferredLanguage',
  'accountEnabled'
].join(',')

type GraphUser = {
  id: string
  displayName?: string | null
  givenName?: string | null
  surname?: string | null
  mail?: string | null
  userPrincipalName?: string | null
  jobTitle?: string | null
  department?: string | null
  companyName?: string | null
  officeLocation?: string | null
  city?: string | null
  state?: string | null
  country?: string | null
  mobilePhone?: string | null
  businessPhones?: string[]
  employeeId?: string | null
  preferredLanguage?: string | null
  accountEnabled?: boolean | null
}

function tenantId(): string | null {
  if (config.GRAPH_TENANT_ID) return config.GRAPH_TENANT_ID
  const m = config.OIDC_ISSUER.match(/microsoftonline\.com\/([^/]+)/i)
  return m?.[1] ?? null
}

function credentials() {
  return {
    tenant: tenantId(),
    clientId: config.GRAPH_CLIENT_ID || config.OIDC_CLIENT_ID,
    secret: config.GRAPH_CLIENT_SECRET || config.OIDC_CLIENT_SECRET
  }
}

export function directoryConfigured(): boolean {
  const c = credentials()
  return Boolean(c.tenant && c.clientId && c.secret)
}

let cachedToken: { key: string; token: string; expiresAt: number; roles: string[] } | null = null

/** Application `roles` and delegated `scp` scopes, as one list. */
export function grantsFromJwt(token: string): string[] {
  try {
    const payload = JSON.parse(
      Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8')
    ) as { roles?: unknown; scp?: unknown }
    const roles = Array.isArray(payload.roles) ? payload.roles.map(String) : []
    const scp = typeof payload.scp === 'string' ? payload.scp.split(/\s+/).filter(Boolean) : []
    return [...new Set([...roles, ...scp])]
  } catch {
    return []
  }
}

/**
 * Graph token, cached until a minute before expiry: client credentials for the
 * app, or the password grant for a configured service account.
 */
async function appToken(): Promise<{ token: string; roles: string[] }> {
  const c = credentials()
  if (!c.tenant || !c.clientId || !c.secret) {
    throw new DirectoryError(
      'Directory lookups are not configured (no Microsoft tenant or app credentials)',
      503,
      'directory_not_configured'
    )
  }
  const identity = await directoryIdentity()
  const key = `${identity.mode}|${identity.username ?? ''}`
  if (cachedToken && cachedToken.key === key && cachedToken.expiresAt > Date.now()) {
    return { token: cachedToken.token, roles: cachedToken.roles }
  }
  const body =
    identity.mode === 'service_account'
      ? new URLSearchParams({
          client_id: c.clientId,
          client_secret: c.secret,
          grant_type: 'password',
          username: identity.username ?? '',
          password: identity.password ?? '',
          scope: 'https://graph.microsoft.com/.default'
        })
      : new URLSearchParams({
          client_id: c.clientId,
          client_secret: c.secret,
          grant_type: 'client_credentials',
          scope: 'https://graph.microsoft.com/.default'
        })
  let res: Response
  try {
    res = await fetch(`https://login.microsoftonline.com/${c.tenant}/oauth2/v2.0/token`, {
      method: 'POST',
      body,
      signal: AbortSignal.timeout(8000)
    })
  } catch (err) {
    throw new DirectoryError(
      `Could not reach the Microsoft token endpoint (${String(err).slice(0, 120)})`,
      502,
      'graph_token_failed'
    )
  }
  const json = (await res.json().catch(() => ({}))) as {
    access_token?: string
    expires_in?: number
    error?: string
    error_description?: string
  }
  if (!res.ok || !json.access_token) {
    const who =
      identity.mode === 'service_account'
        ? `the service account ${identity.username}`
        : 'the app token'
    throw new DirectoryError(
      `Microsoft refused ${who}: ${json.error ?? res.status}${
        json.error_description ? ` — ${json.error_description.slice(0, 300)}` : ''
      }`,
      502,
      'graph_token_failed'
    )
  }
  cachedToken = {
    key,
    token: json.access_token,
    expiresAt: Date.now() + Math.max(60, (json.expires_in ?? 3600) - 60) * 1000,
    roles: grantsFromJwt(json.access_token)
  }
  return { token: cachedToken.token, roles: cachedToken.roles }
}

/** Forget the cached token — a consent change in Azure shows up on the next call. */
export function resetDirectoryToken(): void {
  cachedToken = null
}

export async function directoryStatus(): Promise<DirectoryStatus> {
  const tenant = tenantId()
  const identity = await directoryIdentity()
  const base = { tenant, auth_mode: identity.mode, username: identity.username }
  if (!directoryConfigured()) {
    return {
      ...base,
      configured: false,
      granted: false,
      roles: [],
      reason: 'No Microsoft tenant or app credentials configured'
    }
  }
  try {
    const { roles } = await appToken()
    const granted = roles.some((r) => GRANT_ROLES.includes(r))
    const noGrant =
      identity.mode === 'service_account'
        ? `${identity.username} signed in, but its token carries no User.Read.All — grant the DELEGATED User.Read.All to the app and let the service account consent (or an admin consent for it)`
        : 'The app token carries no Graph roles — User.Read.All must be added as an APPLICATION permission and admin-consented, or switch to a service account below'
    return {
      ...base,
      configured: true,
      granted,
      roles,
      reason: granted
        ? null
        : roles.length === 0
          ? noGrant
          : `The token carries ${roles.join(', ')} but none of ${GRANT_ROLES.join(', ')}`
    }
  } catch (err) {
    let reason = err instanceof Error ? err.message : String(err)
    // "account does not exist" with a bare name = the UPN was left off.
    if (
      identity.mode === 'service_account' &&
      identity.username &&
      !identity.username.includes('@') &&
      /AADSTS50034/.test(reason)
    ) {
      reason +=
        ' — the sign-in name must be the full user principal name (name@domain), not the bare account name'
    }
    return { ...base, configured: true, granted: false, roles: [], reason }
  }
}

async function graphGet(path: string, init?: { headers?: Record<string, string> }) {
  const { token } = await appToken()
  let res: Response
  try {
    res = await fetch(`https://graph.microsoft.com/v1.0${path}`, {
      headers: { Authorization: `Bearer ${token}`, ...(init?.headers ?? {}) },
      signal: AbortSignal.timeout(8000)
    })
  } catch (err) {
    throw new DirectoryError(
      `Microsoft Graph did not answer (${String(err).slice(0, 120)})`,
      502,
      'graph_unreachable'
    )
  }
  if (res.ok) return res
  let code = ''
  let message = ''
  try {
    const body = (await res.json()) as { error?: { code?: string; message?: string } }
    code = body.error?.code ?? ''
    message = body.error?.message ?? ''
  } catch {
    /* status alone suffices */
  }
  if (res.status === 404 || code === 'Request_ResourceNotFound') {
    throw new DirectoryError('No directory entry matches', 404, 'not_found')
  }
  if (res.status === 401 || res.status === 403) {
    throw new DirectoryError(
      `Microsoft Graph denied the request (${code || res.status}) — the app needs User.Read.All as an application permission with admin consent`,
      503,
      'directory_not_granted'
    )
  }
  throw new DirectoryError(
    `Microsoft Graph error ${res.status}${code ? ` (${code})` : ''}${
      message ? `: ${message.slice(0, 200)}` : ''
    }`,
    502,
    'graph_error'
  )
}

function mapUser(g: GraphUser): DirectoryUser {
  return {
    id: g.id,
    display_name: g.displayName ?? null,
    first_name: g.givenName ?? null,
    last_name: g.surname ?? null,
    email: g.mail ?? null,
    upn: g.userPrincipalName ?? null,
    title: g.jobTitle ?? null,
    department: g.department ?? null,
    company: g.companyName ?? null,
    office_location: g.officeLocation ?? null,
    city: g.city ?? null,
    state: g.state ?? null,
    country: g.country ?? null,
    phone: g.mobilePhone ?? g.businessPhones?.[0] ?? null,
    business_phones: g.businessPhones ?? [],
    employee_id: g.employeeId ?? null,
    preferred_language: g.preferredLanguage ?? null,
    account_enabled: typeof g.accountEnabled === 'boolean' ? g.accountEnabled : null
  }
}

/** OData string literal — single quotes double up. */
const odataString = (v: string) => `'${v.replace(/'/g, "''")}'`

/**
 * One user by Graph object id, UPN or email. Graph resolves `/users/{upn}`
 * directly; a mail address that is NOT the UPN (aliases, renamed accounts)
 * falls back to a `mail eq` filter.
 */
export async function lookupDirectoryUser(key: string): Promise<DirectoryUser | null> {
  const k = key.trim()
  if (!k) return null
  try {
    const res = await graphGet(`/users/${encodeURIComponent(k)}?$select=${USER_SELECT}`)
    return mapUser((await res.json()) as GraphUser)
  } catch (err) {
    if (!(err instanceof DirectoryError && err.code === 'not_found')) throw err
  }
  if (!k.includes('@')) return null
  const res = await graphGet(
    `/users?$filter=mail eq ${encodeURIComponent(odataString(k))}&$select=${USER_SELECT}&$top=1`
  )
  const body = (await res.json()) as { value?: GraphUser[] }
  const first = body.value?.[0]
  return first ? mapUser(first) : null
}

/** Name / email / UPN search across the tenant (Graph `$search`, eventual consistency). */
export async function searchDirectoryUsers(q: string, top = 25): Promise<DirectoryUser[]> {
  const term = q.trim().replace(/"/g, '')
  if (term.length < 2) return []
  const search = ['displayName', 'mail', 'userPrincipalName']
    .map((f) => `"${f}:${term}"`)
    .join(' OR ')
  const res = await graphGet(
    `/users?$search=${encodeURIComponent(search)}&$select=${USER_SELECT}&$top=${Math.min(
      Math.max(top, 1),
      100
    )}&$count=true`,
    { headers: { ConsistencyLevel: 'eventual' } }
  )
  const body = (await res.json()) as { value?: GraphUser[] }
  return (body.value ?? []).map(mapUser)
}

/**
 * Every user in the tenant, paged 999 at a time — the way to check the whole
 * user table without one Graph call per person. A 5k-user tenant is six calls.
 */
export async function walkDirectoryUsers(): Promise<DirectoryUser[]> {
  const out: DirectoryUser[] = []
  let next: string | null = `/users?$select=${USER_SELECT}&$top=999`
  let pages = 0
  while (next && pages < 200) {
    pages += 1
    const res = await graphGet(next)
    const body = (await res.json()) as { value?: GraphUser[]; '@odata.nextLink'?: string }
    for (const g of body.value ?? []) out.push(mapUser(g))
    const link = body['@odata.nextLink']
    next = link ? link.replace(/^https:\/\/graph\.microsoft\.com\/v1\.0/, '') : null
  }
  return out
}

export async function fetchDirectoryManager(key: string): Promise<DirectoryUser | null> {
  try {
    const res = await graphGet(
      `/users/${encodeURIComponent(key.trim())}/manager?$select=${USER_SELECT}`
    )
    return mapUser((await res.json()) as GraphUser)
  } catch (err) {
    if (err instanceof DirectoryError && err.code === 'not_found') return null
    throw err
  }
}

/** 96x96 profile photo as a data URI — the same shape login enrichment stores. */
export async function fetchDirectoryPhoto(key: string): Promise<string | null> {
  try {
    const res = await graphGet(`/users/${encodeURIComponent(key.trim())}/photos/96x96/$value`)
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.length === 0 || buf.length > 200 * 1024) return null
    const mime = res.headers.get('content-type')?.split(';')[0] || 'image/jpeg'
    return `data:${mime};base64,${buf.toString('base64')}`
  } catch (err) {
    if (err instanceof DirectoryError && err.code === 'not_found') return null
    throw err
  }
}
