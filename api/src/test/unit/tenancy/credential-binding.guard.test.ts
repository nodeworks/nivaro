import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { listSourceFiles, stripCommentsKeepLines } from '../cloud-flag-scan.js'

// Hub phase 6 Task 12 (cross-app credential binding). A Hub shared deployment serves many apps
// from one process, one Redis and one SESSION_SECRET, and its apps are often copies of each
// other (same user ids, same row ids). Every credential a shared Redis or the shared HMAC key
// would let one app's value work in another is bound to its app. This guard lists every site
// that stores a credential-like value in Redis or signs with SESSION_SECRET, with how it is
// bound. A new site fails here until it is classified (and, when it is a credential, bound).
//
//   tenant-key  the Redis key carries the app (currentTenantKey()/tenant id)
//   tenant-tag  the stored/signed value carries the app (`t`, or the app in the HMAC input) and
//               the reader refuses another app's (tenantTagRefused / appCredentialRefused /
//               appBoundSigInput, services/tenancy/credential-binding.ts)
//   db-judged   the value is looked up in the app's own database
//   process     not a credential to an app (the reason says why)

type Cls = 'tenant-key' | 'tenant-tag' | 'db-judged' | 'process'
interface Entry {
  cls: Cls
  why: string
}

const API_SRC = join(fileURLToPath(new URL('.', import.meta.url)), '../../..')

// ─── The scan ────────────────────────────────────────────────────────────────

/** A Redis write call: `redis.set(` / `.setex(` / `.psetex(` (a pipeline or MULTI too). */
const REDIS_WRITE =
  /\b(?:redis|Redis|redisRef|_redis|pipe|tx|client)\??\s*\.\s*(?:set|setex|psetex)\s*\(|\.(?:setex|psetex)\s*\(|\)\s*\.\s*set\s*\(/g
/** Words that make a key (or its file) credential-like. */
const CREDENTIAL_WORD =
  /(masq|keysim|ws:token|ticket|token|share|kiosk|export|download|replay|sidtag|transfer|oauth|mcp|grant|nonce|sess|pkg|code|link|stream|signin|login|invite|otp|secret|claim|jti)/i
/** Reads of the shared HMAC key (directly, or the keyset helper that falls back to it). */
const SECRET_READ = /config\.SESSION_SECRET\b|process\.env\.SESSION_SECRET\b|keysetSecret\(\)/g

/** The first argument of a call whose `(` ends at `from`, whitespace folded. */
function firstArg(src: string, from: number): string {
  let depth = 0
  let out = ''
  for (let i = from; i < src.length; i++) {
    const c = src[i]
    if (c === '(' || c === '[' || c === '{') depth++
    else if (c === ')' || c === ']' || c === '}') {
      if (depth === 0) break
      depth--
    } else if (c === ',' && depth === 0) break
    out += c
  }
  return out.replace(/\s+/g, ' ').trim()
}

function scan(): { redis: string[]; secrets: Record<string, number> } {
  const redis = new Set<string>()
  const secrets: Record<string, number> = {}
  for (const rel of listSourceFiles(API_SRC)) {
    if (rel.startsWith('test/')) continue
    const src = stripCommentsKeepLines(readFileSync(join(API_SRC, rel), 'utf8'))
    const base = rel.split('/').pop() ?? rel
    for (const m of src.matchAll(REDIS_WRITE)) {
      const key = firstArg(src, (m.index ?? 0) + m[0].length)
      if (!key) continue
      if (CREDENTIAL_WORD.test(key) || CREDENTIAL_WORD.test(base)) redis.add(`${rel} :: ${key}`)
    }
    const n = [...src.matchAll(SECRET_READ)].length
    if (n > 0) secrets[rel] = n
  }
  return { redis: [...redis].sort(), secrets }
}

// ─── The classification ──────────────────────────────────────────────────────

const T = (why: string): Entry => ({ cls: 'tenant-tag', why })
const K = (why: string): Entry => ({ cls: 'tenant-key', why })
const P = (why: string): Entry => ({ cls: 'process', why })

const OAUTH = 'OAuth / phone sign-in record: carries `t`, refused on another app (sameTenant)'
const OAUTH_GRANT =
  'keyed by a random grant id / token hash, touched only after the grant itself was read for this app (sameTenant)'

const REDIS_SITES: Record<string, Entry> = {
  // ── Credentials, bound ──
  'routes/auth.ts :: `masq:${token}`': T(
    'View-as (nvm_): `t` checked by tenantTagRefused (HTTP) and mintedForThisTenant (socket); untagged refused on a shared deployment'
  ),
  'routes/auth.ts :: `ws:token:${token}`': T(
    'socket ws-token: `t` checked by mintedForThisTenant in plugins/socketio.ts; untagged refused on a shared deployment'
  ),
  'routes/api-keys.ts :: `keysim:${token}`': T(
    'run-as-key (nvq_): `t` checked by tenantTagRefused in authenticateSimulatedKey'
  ),
  'services/stream-ticket.ts :: `${TICKET_PREFIX}${ticket}`': T(
    'SSE / graphql-ws ticket: `t` must equal currentTenantKey() in redeemStreamTicket'
  ),
  'routes/help-videos.ts :: `${EXPORT_TICKET_PREFIX}${token}`': T(
    'help-video export link: exportTicketValue stamps `t`, readExportTicket refuses another app (Task 12 fix)'
  ),
  'services/chat-send.ts :: `nvr:chatreply:${token}`': T(
    'push-notification reply token: `t` stamped by mintReplyToken, refused by redeemReplyToken (Task 12 fix)'
  ),
  'routes/message-actions.ts :: usedKey(payload.jti as string)': K(
    'spent-decision marker keyed by currentTenantKey(); the link itself carries `t` (verifyActionToken)'
  ),
  'services/oauth-store.ts :: `${P}at:${hashToken(access)}`': T(OAUTH),
  'services/oauth-store.ts :: `${P}client:${client.client_id}`': T(OAUTH),
  'services/oauth-store.ts :: `${P}code:${hashToken(code)}`': T(OAUTH),
  'services/oauth-store.ts :: `${P}grant:${g.id}`': T(OAUTH),
  'services/oauth-store.ts :: `${P}grant:${grant.id}`': T(OAUTH),
  'services/oauth-store.ts :: `${P}rt:${hashToken(refresh)}`': T(OAUTH),
  'services/oauth-store.ts :: grantRtKey(fields.grant_id)': T(OAUTH_GRANT),
  'services/oauth-store.ts :: idleKey(grantId)': T(OAUTH_GRANT),
  'services/oauth-store.ts :: replayKey(hashToken(spentRefresh))': T(OAUTH_GRANT),
  'services/oauth-store.ts :: spentKey(h)': T(OAUTH_GRANT),
  'services/mcp-sessions.ts :: metaKey(meta.tenant, meta.id)': K(
    'MCP live session: keyed by the tenant routes/mcp-live.ts passes (currentTenantKey())'
  ),
  'services/mcp-sessions.ts :: metaKey(s.tenant, s.id)': K(
    'MCP live session: keyed by the tenant routes/mcp-live.ts passes (currentTenantKey())'
  ),
  'services/screen-share.ts :: shareKeys(tenant, share.ticket).share': K(
    'screen-share state: nvr:ss:<tenant>:<ticket>, tenant from currentTenantKey() / the socket tenant'
  ),
  'services/screen-share.ts :: `${tenant}|${id}`': K(
    'in-process ticket memo (a Map, not Redis) keyed by tenant + ticket id'
  ),
  'services/screen-share.ts :: key': K(
    'in-process person memo (a Map, not Redis) keyed by tenant + user id'
  ),
  'services/device-grants.ts :: registeredKey(rowId)': K(
    'phone push registration stamp: nvr:phone-push-reg:<currentTenantKey()>:<row>'
  ),
  'auth/login-limits.ts :: key': K('spent TOTP code: nvr:totp:used:<currentTenantKey()>:…'),
  'services/huddle.ts :: k.session': K(
    'huddle session id (also the LiveKit room salt): nvr:huddle:<tenant>:<room>'
  ),
  'services/idempotency.ts :: claim.redisKey': K(
    'stored answer of a write: names the app on a shared deployment (appKeyPart, Task 12 fix), so app B never replays app A'
  ),
  'services/masquerade-marker.ts :: masqueradeMarkerKey(userId)': K(
    '"someone is acting as this user": per app on a shared deployment (appKeyPart, Task 12 fix)'
  ),
  // ── Not credentials ──
  'auth/session.ts :: `${REVOKED_PREFIX}${sid}`': P(
    'revocation marker of a random session id: it only ever refuses; the session itself is app-stamped (P5-16)'
  ),
  'services/help-videos.ts :: `${SIDTAG_PREFIX}${tag}`': P(
    'maps an HMAC of a random session id back to that id; opens nothing (the media ticket is app-bound, the session app-stamped)'
  ),
  'routes/dashboard-links.ts :: key': K(
    'cached public-link answer: dlpub:<currentTenantKey()>:<link>; the link token itself is judged in the app database'
  ),
  'services/ai-stream-delivery.ts :: STOP_KEY(id)': P(
    'stop flag for a random Ask AI stream id, checked against the asker; grants nothing'
  ),
  'services/chat-bot-stream.ts :: OWNER_KEY(this.id)': P(
    'owner of a random chat-bot stream id (who may stop it); grants nothing'
  ),
  'services/chat-link-preview.ts :: key': P(
    'cache of a public URL preview keyed by the URL hash; holds no app data'
  ),
  'services/export-runs.ts :: cancelKey(runId)': K(
    'export cancel flag: exportCancelKey carries currentTenantKey()'
  ),
  'services/file-downloads.ts :: `filedl-s:${who}`': K(
    'download-log dedupe window: who = tenantScopedRoom(user:file)'
  ),
  'services/file-downloads.ts :: `filedl:${who}`': K(
    'download-log dedupe window: who = tenantScopedRoom(user:file)'
  ),
  "services/ops-proposals.ts :: keyOf(id, ':claim')": K(
    'ops assistant proposal claim: nvr:t:<tenant>:ops:proposal:<id>'
  ),
  'services/hub-signin/link-client.ts :: k': P(
    'Hub sign-in push throttle; Hub sign-in is off on any multi-tenant deployment (hub-signin/config.ts)'
  ),
  'services/hub-signin/link-client.ts :: key': P(
    'Hub app-switcher cache; Hub sign-in is off on any multi-tenant deployment (hub-signin/config.ts)'
  ),
  'services/hub/oidc/codes.ts :: `${P}${hashToken(code)}`': P(
    "the Hub's own OIDC codes: only with HUB=on, which a shared deployment refuses (deploymentModeProblem)"
  ),
  'services/hub/promote-lock.ts :: hubSharedLockKey(id)': P(
    'a Hub-side lock (HUB=on only), not a credential'
  ),
  'services/teams-bot/actions.ts :: KEY(nonce)': P(
    'Teams bot card nonce: the bot is off on any multi-tenant deployment (teams-bot/config.ts)'
  )
}

/** File → how many SESSION_SECRET reads it has, and how what it signs is bound. */
const SECRET_SITES: Record<string, Entry & { reads: number }> = {
  'auth/session.ts': {
    reads: 1,
    ...T('session cookie signature; the session blob carries its app (P5-16 stampSessionApp)')
  },
  'services/socket-handshake-session.ts': {
    reads: 1,
    ...T('unsigns the session cookie on a socket; the session blob is app-checked (sessionForeign)')
  },
  'routes/message-actions.ts': {
    reads: 1,
    ...T(
      'approval / message-action links: signed payload carries `t`, verifyActionToken refuses another app'
    )
  },
  'services/help-videos.ts': {
    reads: 2,
    ...T(
      'media ?st= tickets: the app is in the HMAC input (appBoundSigInput, Task 12 fix); sidTag hashes a random session id'
    )
  },
  'services/submission-status.ts': {
    reads: 1,
    ...T(
      'public submission status links: the app is in the HMAC input (appBoundSigInput, Task 12 fix); the token hash is also judged in the app database'
    )
  },
  'services/keyset-secret.ts': {
    reads: 2,
    ...P('defines the keyset-cursor key (SESSION_SECRET, else ENCRYPTION_KEY)')
  },
  'services/items.ts': {
    reads: 2,
    ...P(
      "keyset cursors: a page position in the reading app, under that app's own access rules; not a credential"
    )
  },
  'services/queue-keyset.ts': {
    reads: 2,
    ...P("queue keyset cursors: a page position, read under the app's own access rules")
  },
  'services/record-drafts.ts': {
    reads: 1,
    ...P("at-rest encryption of the app's own draft rows; a copied database already holds its copy")
  },
  'services/docker-source.ts': {
    reads: 2,
    ...P('Infrastructure env digests (HMAC so a stored hash cannot be brute-forced); no access')
  },
  'services/teams-bot/links.ts': {
    reads: 1,
    ...P('Teams connect token: the bot is off on any multi-tenant deployment (teams-bot/config.ts)')
  },
  'services/chaos/push-stop.ts': {
    reads: 1,
    ...P(
      'chaos Stop push token: chaos drills never run on a multi-tenant deployment (chaos/gate.ts)'
    )
  }
}

describe('credential binding guard (Hub phase 6 Task 12)', () => {
  const found = scan()

  it('every credential-like Redis write is classified', () => {
    const unlisted = found.redis.filter((k) => !REDIS_SITES[k])
    expect(unlisted, `classify these in REDIS_SITES:\n${unlisted.join('\n')}`).toEqual([])
  })

  it('no stale Redis entries (a listed site that is gone must leave the list)', () => {
    const live = new Set(found.redis)
    const stale = Object.keys(REDIS_SITES).filter((k) => !live.has(k))
    expect(stale, `remove from REDIS_SITES:\n${stale.join('\n')}`).toEqual([])
  })

  it('every SESSION_SECRET read is classified, with its count', () => {
    const wrong = Object.entries(found.secrets)
      .filter(([f, n]) => SECRET_SITES[f]?.reads !== n)
      .map(([f, n]) => `${f}: ${n} read(s)`)
    const stale = Object.keys(SECRET_SITES).filter((f) => !(f in found.secrets))
    expect([...wrong, ...stale.map((f) => `${f}: gone`)]).toEqual([])
  })

  it('every entry says why', () => {
    for (const e of [...Object.values(REDIS_SITES), ...Object.values(SECRET_SITES)])
      expect(e.why.length).toBeGreaterThan(10)
  })
})
