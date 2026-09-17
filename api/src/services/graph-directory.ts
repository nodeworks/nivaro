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
// When Conditional Access demands MFA the password grant is refused outright,
// so the third mode ('connected') has an admin sign in AS the service account
// once in the browser (`directoryConnectUrl` → the OIDC callback →
// `completeDirectoryConnect`) and keeps the REFRESH TOKEN; every Graph token
// after that is a refresh_token grant, and a rotated refresh token is stored
// back as it arrives.

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
  auth_mode: DirectoryAuthMode
  username: string | null
  connected_user: string | null
  connected_at: string | null
}

export type DirectoryAuthMode = 'app' | 'service_account' | 'connected'

export type DirectoryIdentity = {
  mode: DirectoryAuthMode
  username: string | null
  password: string | null
  refreshToken: string | null
  connectedUser: string | null
  connectedAt: string | null
}

/** Which identity the lookups use — from nivaro_settings (per-instance overlay applies). */
export async function directoryIdentity(): Promise<DirectoryIdentity> {
  try {
    const raw = (await db('nivaro_settings')
      .select(
        'directory_auth_mode',
        'directory_username',
        'directory_password',
        'directory_refresh_token',
        'directory_connected_user',
        'directory_connected_at'
      )
      .orderBy('id', 'asc')
      .first()) as Record<string, unknown> | undefined
    const row = await overlaySettings(raw ?? {})
    const username = typeof row.directory_username === 'string' ? row.directory_username.trim() : ''
    const password = typeof row.directory_password === 'string' ? row.directory_password : ''
    const refreshToken =
      typeof row.directory_refresh_token === 'string' ? row.directory_refresh_token : ''
    const connectedUser =
      typeof row.directory_connected_user === 'string' ? row.directory_connected_user : ''
    const connectedAt =
      row.directory_connected_at instanceof Date
        ? row.directory_connected_at.toISOString()
        : typeof row.directory_connected_at === 'string'
          ? row.directory_connected_at
          : null
    const mode: DirectoryAuthMode =
      row.directory_auth_mode === 'connected' && refreshToken
        ? 'connected'
        : row.directory_auth_mode === 'service_account' && username && password
          ? 'service_account'
          : 'app'
    return {
      mode,
      username: username || null,
      password: password || null,
      refreshToken: refreshToken || null,
      connectedUser: connectedUser || null,
      connectedAt
    }
  } catch {
    return {
      mode: 'app',
      username: null,
      password: null,
      refreshToken: null,
      connectedUser: null,
      connectedAt: null
    }
  }
}

const GRAPH_SCOPE = 'https://graph.microsoft.com/.default'

/**
 * The authorize URL for the one-time interactive connect. `prompt=login`
 * forces a fresh sign-in (as the service account, not whoever is browsing),
 * `offline_access` is what yields the refresh token.
 */
export function directoryConnectUrl(args: {
  state: string
  redirectUri: string
  loginHint?: string | null
}): string {
  const c = credentials()
  if (!c.tenant || !c.clientId) {
    throw new DirectoryError(
      'Directory lookups are not configured (no Microsoft tenant or app credentials)',
      503,
      'directory_not_configured'
    )
  }
  const q = new URLSearchParams({
    client_id: c.clientId,
    response_type: 'code',
    redirect_uri: args.redirectUri,
    response_mode: 'query',
    scope: 'openid profile offline_access https://graph.microsoft.com/User.Read.All',
    state: args.state,
    prompt: 'login'
  })
  if (args.loginHint) q.set('login_hint', args.loginHint)
  return `https://login.microsoftonline.com/${c.tenant}/oauth2/v2.0/authorize?${q.toString()}`
}

function jwtPayload(token: string): Record<string, unknown> {
  try {
    return JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8'))
  } catch {
    return {}
  }
}

/**
 * Exchange the authorization code, store the refresh token + who signed in,
 * and switch the auth mode to 'connected'. Returns the connected UPN.
 */
export async function completeDirectoryConnect(args: {
  code: string
  redirectUri: string
}): Promise<{ user: string; granted: boolean }> {
  const c = credentials()
  if (!c.tenant || !c.clientId || !c.secret) {
    throw new DirectoryError(
      'Directory lookups are not configured (no Microsoft tenant or app credentials)',
      503,
      'directory_not_configured'
    )
  }
  const res = await fetch(`https://login.microsoftonline.com/${c.tenant}/oauth2/v2.0/token`, {
    method: 'POST',
    body: new URLSearchParams({
      client_id: c.clientId,
      client_secret: c.secret,
      grant_type: 'authorization_code',
      code: args.code,
      redirect_uri: args.redirectUri
    }),
    signal: AbortSignal.timeout(10000)
  })
  const json = (await res.json().catch(() => ({}))) as {
    access_token?: string
    refresh_token?: string
    id_token?: string
    error?: string
    error_description?: string
  }
  if (!res.ok || !json.refresh_token || !json.access_token) {
    throw new DirectoryError(
      `Microsoft refused the connect: ${json.error ?? res.status}${
        json.error_description ? ` — ${json.error_description.slice(0, 300)}` : ''
      }${!res.ok || json.refresh_token ? '' : ' (no refresh token issued — offline_access missing?)'}`,
      502,
      'graph_token_failed'
    )
  }
  const claims = jwtPayload(json.id_token ?? json.access_token)
  const user = String(
    claims.preferred_username ?? claims.upn ?? claims.email ?? claims.unique_name ?? ''
  )
  const granted = grantsFromJwt(json.access_token).some((r) => GRANT_ROLES.includes(r))
  const row = await db('nivaro_settings').select('id').orderBy('id', 'asc').first()
  if (row) {
    await db('nivaro_settings')
      .where({ id: row.id })
      .update({
        directory_auth_mode: 'connected',
        directory_refresh_token: json.refresh_token,
        directory_connected_user: user || null,
        directory_connected_at: new Date()
      })
  }
  resetDirectoryToken()
  return { user, granted }
}

/** Forget the connected account (the refresh token is discarded, mode falls back to the app). */
export async function disconnectDirectory(): Promise<void> {
  const row = await db('nivaro_settings').select('id').orderBy('id', 'asc').first()
  if (row) {
    await db('nivaro_settings').where({ id: row.id }).update({
      directory_auth_mode: null,
      directory_refresh_token: null,
      directory_connected_user: null,
      directory_connected_at: null
    })
  }
  resetDirectoryToken()
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
  const key = `${identity.mode}|${identity.username ?? ''}|${identity.connectedUser ?? ''}`
  if (cachedToken && cachedToken.key === key && cachedToken.expiresAt > Date.now()) {
    return { token: cachedToken.token, roles: cachedToken.roles }
  }
  const body =
    identity.mode === 'connected'
      ? new URLSearchParams({
          client_id: c.clientId,
          client_secret: c.secret,
          grant_type: 'refresh_token',
          refresh_token: identity.refreshToken ?? '',
          scope: `${GRAPH_SCOPE} offline_access`
        })
      : identity.mode === 'service_account'
        ? new URLSearchParams({
            client_id: c.clientId,
            client_secret: c.secret,
            grant_type: 'password',
            username: identity.username ?? '',
            password: identity.password ?? '',
            scope: GRAPH_SCOPE
          })
        : new URLSearchParams({
            client_id: c.clientId,
            client_secret: c.secret,
            grant_type: 'client_credentials',
            scope: GRAPH_SCOPE
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
    refresh_token?: string
    expires_in?: number
    error?: string
    error_description?: string
  }
  if (!res.ok || !json.access_token) {
    const who =
      identity.mode === 'connected'
        ? `the connected account ${identity.connectedUser ?? ''}`
        : identity.mode === 'service_account'
          ? `the service account ${identity.username}`
          : 'the app token'
    const hint =
      identity.mode === 'connected' && json.error === 'invalid_grant'
        ? ' — the stored sign-in has expired or was revoked; connect the account again from Settings → Microsoft'
        : ''
    throw new DirectoryError(
      `Microsoft refused ${who}: ${json.error ?? res.status}${
        json.error_description ? ` — ${json.error_description.slice(0, 300)}` : ''
      }${hint}`,
      502,
      'graph_token_failed'
    )
  }
  // Microsoft rotates refresh tokens; keep the newest so the connection never
  // ages out while it is in use.
  if (
    identity.mode === 'connected' &&
    json.refresh_token &&
    json.refresh_token !== identity.refreshToken
  ) {
    void db('nivaro_settings')
      .orderBy('id', 'asc')
      .first()
      .then((row) =>
        row
          ? db('nivaro_settings')
              .where({ id: row.id })
              .update({ directory_refresh_token: json.refresh_token })
          : undefined
      )
      .catch(() => undefined)
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
  const base = {
    tenant,
    auth_mode: identity.mode,
    username: identity.username,
    connected_user: identity.connectedUser,
    connected_at: identity.connectedAt
  }
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
      identity.mode === 'connected'
        ? `${identity.connectedUser} is connected, but its token carries no User.Read.All — grant the DELEGATED User.Read.All to the app for that account, then connect again`
        : identity.mode === 'service_account'
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
