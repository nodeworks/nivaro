import { getTeamsBotConfig, type TeamsBotConfig } from './config.js'

// Outbound auth: https://learn.microsoft.com/en-us/azure/bot-service/rest-api/bot-framework-rest-connector-authentication
// ("Authenticate requests from your bot to the Bot Connector service"): single-tenant bots POST
// client_credentials to https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token with scope
// https://api.botframework.com/.default; multi-tenant bots use the botframework.com tenant.

const TIMEOUT_MS = 10_000
const REFRESH_EARLY_MS = 5 * 60 * 1000

export class ConnectorError extends Error {
  status: number
  retryAfterMs?: number
  constructor(status: number, message: string, retryAfterMs?: number) {
    super(message)
    this.name = 'ConnectorError'
    this.status = status
    this.retryAfterMs = retryAfterMs
  }
}

function parseRetryAfter(v: string | null): number | undefined {
  if (!v) return undefined
  const s = Number(v)
  if (Number.isFinite(s)) return Math.max(0, Math.round(s * 1000))
  const at = Date.parse(v)
  return Number.isNaN(at) ? undefined : Math.max(0, at - Date.now())
}

async function failure(res: Response, what: string): Promise<ConnectorError> {
  // Body is read for nothing: it may echo request data, so it is never put in the message.
  await res.text().catch(() => '')
  return new ConnectorError(
    res.status,
    `${what} failed (${res.status})`,
    parseRetryAfter(res.headers.get('retry-after'))
  )
}

interface TokenEntry {
  token: string
  expiresAt: number
}
const tokens = new Map<string, TokenEntry>()
const inflight = new Map<string, Promise<string>>()

/** Test seam. */
export function resetConnectorCache(): void {
  tokens.clear()
  inflight.clear()
}

async function fetchToken(cfg: TeamsBotConfig, key: string): Promise<string> {
  const tenant = cfg.tenantId || 'botframework.com'
  const res = await fetch(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: cfg.appId,
      client_secret: cfg.appSecret,
      scope: 'https://api.botframework.com/.default'
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS)
  })
  if (!res.ok) throw await failure(res, 'bot token request')
  const body = (await res.json()) as { access_token?: string; expires_in?: number }
  if (!body.access_token) throw new ConnectorError(502, 'bot token response had no token')
  const ttl = (Number(body.expires_in) || 3600) * 1000
  tokens.set(key, { token: body.access_token, expiresAt: Date.now() + ttl })
  return body.access_token
}

/** Bot access token, cached until 5 minutes before expiry; concurrent callers share one request. */
export async function getBotToken(cfg: TeamsBotConfig): Promise<string> {
  const key = `${cfg.tenantId}|${cfg.appId}`
  const hit = tokens.get(key)
  if (hit && hit.expiresAt - REFRESH_EARLY_MS > Date.now()) return hit.token
  let p = inflight.get(key)
  if (!p) {
    p = fetchToken(cfg, key).finally(() => inflight.delete(key))
    inflight.set(key, p)
  }
  return p
}

function base(serviceUrl: string): string {
  // The token is only ever sent to the https service URL the verified activity carried.
  if (!/^https:\/\//i.test(serviceUrl)) throw new ConnectorError(400, 'service url must be https')
  return serviceUrl.replace(/\/+$/, '')
}

async function call(
  cfg: TeamsBotConfig | null,
  method: string,
  url: string,
  body: unknown,
  what: string
): Promise<Response> {
  const c = cfg ?? (await getTeamsBotConfig())
  if (!c.enabled || !c.appId || !c.appSecret)
    throw new ConnectorError(503, 'teams bot is not configured')
  const token = await getBotToken(c)
  const res = await fetch(url, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' })
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS)
  })
  if (res.status === 401) tokens.delete(`${c.tenantId}|${c.appId}`)
  if (!res.ok) throw await failure(res, what)
  return res
}

const conv = (id: string) => encodeURIComponent(id)

export async function sendActivity(
  serviceUrl: string,
  conversationId: string,
  activity: Record<string, unknown>
): Promise<{ id: string }> {
  const res = await call(
    null,
    'POST',
    `${base(serviceUrl)}/v3/conversations/${conv(conversationId)}/activities`,
    { type: 'message', ...activity },
    'send activity'
  )
  const j = (await res.json().catch(() => ({}))) as { id?: string }
  return { id: j.id ?? '' }
}

export async function updateActivity(
  serviceUrl: string,
  conversationId: string,
  activityId: string,
  activity: Record<string, unknown>
): Promise<void> {
  await call(
    null,
    'PUT',
    `${base(serviceUrl)}/v3/conversations/${conv(conversationId)}/activities/${conv(activityId)}`,
    { type: 'message', ...activity, id: activityId },
    'update activity'
  )
}

export async function getMembers(
  serviceUrl: string,
  conversationId: string
): Promise<Array<{ aadObjectId: string; name: string }>> {
  const res = await call(
    null,
    'GET',
    `${base(serviceUrl)}/v3/conversations/${conv(conversationId)}/members`,
    undefined,
    'get members'
  )
  const rows = (await res.json()) as Array<{ aadObjectId?: string; name?: string }>
  return (Array.isArray(rows) ? rows : [])
    .filter((r) => r.aadObjectId)
    .map((r) => ({ aadObjectId: String(r.aadObjectId), name: r.name ?? '' }))
}

/** Open (or find) the bot's 1:1 chat with a person and return its conversation id. */
export async function createPersonalConversation(
  serviceUrl: string,
  cfg: TeamsBotConfig,
  aadObjectId: string
): Promise<string> {
  const res = await call(
    cfg,
    'POST',
    `${base(serviceUrl)}/v3/conversations`,
    {
      bot: { id: cfg.appId },
      isGroup: false,
      tenantId: cfg.tenantId,
      members: [{ id: aadObjectId, aadObjectId }],
      channelData: { tenant: { id: cfg.tenantId } }
    },
    'create conversation'
  )
  const j = (await res.json()) as { id?: string }
  if (!j.id) throw new ConnectorError(502, 'create conversation returned no id')
  return j.id
}
