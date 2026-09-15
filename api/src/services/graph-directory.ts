import { config } from '../config.js'

// ─── Microsoft Graph directory ───────────────────────────────────────────────
// Login enrichment (auth/oidc.ts) reads /me with the PERSON's token, so it only
// ever knows about people who have signed in. This service reads ANY tenant
// user with the app's own client-credentials token, which needs User.Read.All
// (or Directory.Read.All) granted as an APPLICATION permission and admin-
// consented. Until that consent exists the token issues fine but carries no
// `roles` claim and every /users call 403s — `directoryStatus()` reports
// exactly that so the UI can say what to flip instead of shrugging.

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

let cachedToken: { token: string; expiresAt: number; roles: string[] } | null = null

function rolesFromJwt(token: string): string[] {
  try {
    const payload = JSON.parse(
      Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8')
    ) as { roles?: unknown }
    return Array.isArray(payload.roles) ? payload.roles.map(String) : []
  } catch {
    return []
  }
}

/** Client-credentials token for Graph, cached until a minute before expiry. */
async function appToken(): Promise<{ token: string; roles: string[] }> {
  const c = credentials()
  if (!c.tenant || !c.clientId || !c.secret) {
    throw new DirectoryError(
      'Directory lookups are not configured (no Microsoft tenant or app credentials)',
      503,
      'directory_not_configured'
    )
  }
  if (cachedToken && cachedToken.expiresAt > Date.now()) {
    return { token: cachedToken.token, roles: cachedToken.roles }
  }
  const body = new URLSearchParams({
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
    throw new DirectoryError(
      `Microsoft refused the app token: ${json.error ?? res.status}${
        json.error_description ? ` — ${json.error_description.slice(0, 200)}` : ''
      }`,
      502,
      'graph_token_failed'
    )
  }
  cachedToken = {
    token: json.access_token,
    expiresAt: Date.now() + Math.max(60, (json.expires_in ?? 3600) - 60) * 1000,
    roles: rolesFromJwt(json.access_token)
  }
  return { token: cachedToken.token, roles: cachedToken.roles }
}

/** Forget the cached token — a consent change in Azure shows up on the next call. */
export function resetDirectoryToken(): void {
  cachedToken = null
}

export async function directoryStatus(): Promise<DirectoryStatus> {
  const tenant = tenantId()
  if (!directoryConfigured()) {
    return {
      configured: false,
      granted: false,
      roles: [],
      tenant,
      reason: 'No Microsoft tenant or app credentials configured'
    }
  }
  try {
    const { roles } = await appToken()
    const granted = roles.some((r) => GRANT_ROLES.includes(r))
    return {
      configured: true,
      granted,
      roles,
      tenant,
      reason: granted
        ? null
        : roles.length === 0
          ? 'The app token carries no Graph roles — User.Read.All must be added as an APPLICATION permission and admin-consented'
          : `The app token carries ${roles.join(', ')} but none of ${GRANT_ROLES.join(', ')}`
    }
  } catch (err) {
    return {
      configured: true,
      granted: false,
      roles: [],
      tenant,
      reason: err instanceof Error ? err.message : String(err)
    }
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
