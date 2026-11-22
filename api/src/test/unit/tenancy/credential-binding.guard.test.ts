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

/** Read one string or template literal starting at `i` (its opening quote); template `${…}`
 *  expressions, nested templates included, are kept in the text. */
function readLiteral(src: string, i: number): string {
  const q = src[i]
  let j = i + 1
  if (q !== '`') {
    while (j < src.length && src[j] !== q && src[j] !== '\n') j += src[j] === '\\' ? 2 : 1
    return src.slice(i + 1, j)
  }
  while (j < src.length && src[j] !== '`') {
    if (src[j] === '\\') j += 2
    else if (src[j] === '$' && src[j + 1] === '{') {
      let depth = 1
      j += 2
      while (j < src.length && depth > 0) {
        const c = src[j]
        if (c === '`') j = j + readLiteral(src, j).length + 1
        else if (c === '{') depth++
        else if (c === '}') depth--
        j++
      }
    } else j++
  }
  return src.slice(i + 1, j)
}

/** Every `nvr:` Redis key literal (string or template) outside comments, as `file :: prefix`
 *  (text before the first `${`), with whether its text names the app. */
const APP_PART =
  /appKeyPart\(\)|currentTenantKey\(\)|getTenantId\(\)|tenantScopedRoom\(|tenantPart\(|\$\{\s*(?:opts\.|meta\.|s\.)?(?:tenant|tid|t)\b/

function scanNvrKeys(): Map<string, boolean> {
  const out = new Map<string, boolean>()
  for (const rel of listSourceFiles(API_SRC)) {
    if (rel.startsWith('test/')) continue
    const src = stripCommentsKeepLines(readFileSync(join(API_SRC, rel), 'utf8'))
    for (const m of src.matchAll(/['"`]nvr:/g)) {
      const text = readLiteral(src, m.index ?? 0)
      const id = `${rel} :: ${text.split('${')[0]}`
      out.set(id, (out.get(id) ?? false) || APP_PART.test(text))
    }
  }
  return out
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
  'routes/hub-shared.ts :: key': P(
    'Hub-side shared-deployment status cache; a Hub (HUB=on) is never multi-tenant (deployment-mode.ts)'
  ),
  'services/hub/shared/sightings.ts :: observeKey(shared.id, version)': P(
    'Hub-side shared-deployment sighting key; a Hub (HUB=on) is never multi-tenant (deployment-mode.ts)'
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

// ─── nvr: Redis keys that need no app part (fix round 1, ruling P6-6) ─────────
// Every other `nvr:` key literal must name the app (appKeyPart(), currentTenantKey(), a
// tenant variable) — a new key holding app data that does not fails here.

const PROC = 'process-wide by design: per-process / per-instance operations state, not app data'
const TM =
  'Traffic Map / telemetry of the whole deployment (counts and timings, no app records; views filter by tenant)'
const LABEL =
  'a key-family label or SCAN prefix (Traffic Map / chaos key families), never a key itself'
const HUB = 'Hub-only (HUB=on), which a shared deployment refuses (deploymentModeProblem)'
const OFF =
  'the feature is off on any multi-tenant deployment (Teams bot, Hub sign-in, outside-write watch, change warms, chaos test job)'

const NVR_ALLOW: Record<string, string> = {
  'plugins/socketio.ts :: nvr:ping': PROC,
  'plugins/socketio.ts :: nvr:pong': PROC,
  'scripts/realtime-replay.ts :: nvr:ping': PROC,
  'scripts/realtime-replay.ts :: nvr:pong': PROC,
  'services/realtime-worker-source.ts :: nvr:ping': PROC,
  'services/realtime-worker-source.ts :: nvr:pong': PROC,
  'services/socket-health.ts :: nvr:ping': PROC,
  'services/socket-health.ts :: nvr:rt:health:': PROC,
  'services/boot-phases.ts :: nvr:boots:': PROC,
  'services/cloud-user-rooms.ts :: nvr:probe': PROC,
  'services/inflight-cluster.ts :: nvr:inflight:watch': PROC,
  'services/inflight-cluster.ts :: nvr:inflight:node:': PROC,
  'services/inflight-cluster.ts :: nvr:inflight:node:*': PROC,
  'services/instance-roster.ts :: nvr:instance:': PROC,
  'services/instance-roster.ts :: nvr:instance:*': PROC,
  'services/maintenance-windows.ts :: nvr:last-version': PROC,
  'services/ops-signals.ts :: nvr:ops-signals:': PROC,
  'services/pool-holders.ts :: nvr:pool-holders:watch': PROC,
  'services/pool-holders.ts :: nvr:pool-holders:node:': PROC,
  'services/pool-holders.ts :: nvr:pool-hogs': PROC,
  'services/pool-holders.ts :: nvr:pool-holders:node:*': PROC,
  'services/wait-reasons.ts :: nvr:wait:watch': PROC,
  'services/wait-reasons.ts :: nvr:wait:node:': PROC,
  'services/wait-reasons.ts :: nvr:wait:node:*': PROC,
  'services/realtime-ack-sample.ts :: nvr:rt:ack:st:': PROC,
  'services/realtime-ack-sample.ts :: nvr:rt:dlv:s:': PROC,
  'services/realtime-delivery-slo.ts :: nvr:rt:dlv:m:': PROC,
  'services/realtime-delivery-slo.ts :: nvr:rt:dlv:h:': PROC,
  'services/realtime-delivery-slo.ts :: nvr:rt:ack:who:': PROC,
  'services/realtime-leak-audit.ts :: nvr:rt:leak:findings': PROC,
  'services/realtime-leak-audit.ts :: nvr:rt:leak:stats': PROC,
  'services/realtime-leak-audit.ts :: nvr:rt:leak:state': PROC,
  'services/realtime-probe.ts :: nvr:rt:probe:results': PROC,
  'services/socket-access.ts :: nvr:access-recheck': PROC,
  'services/socket-chaos.ts :: nvr:rt:chaos:runs': PROC,
  'services/socket-chaos.ts :: nvr:rt:chaos:run:': PROC,
  'services/socket-chaos.ts :: nvr:rt:chaos': PROC,
  'services/huddle-turn-monitor.ts :: nvr:huddle:probe:history': PROC,
  'services/huddle-turn-monitor.ts :: nvr:huddle:probe:state': PROC,
  'services/infra-swarm/health.ts :: nvr:infra:health:': PROC,
  'services/cache-warm.ts :: nvr:warm:': PROC,
  'services/traffic-actions/temp-cache.ts :: nvr:tm:cache:stats:': TM,
  'services/traffic-actions/timed-rules.ts :: nvr:tm:actions': TM,
  'services/traffic-actions/timed-rules.ts :: nvr:tm:actions:end:': TM,
  'services/traffic-baselines.ts :: nvr:tm:roll:': TM,
  'services/traffic-breaker.ts :: nvr:tm:breakers': TM,
  'services/traffic-breaker.ts :: nvr:tm:brk:': TM,
  'services/traffic-inspect/request-capture.ts :: nvr:tm-trace-next': TM,
  'services/traffic-minutes.ts :: nvr:tm:min:': TM,
  'services/traffic-taps/change-markers.ts :: nvr:tm:boot-versions:': TM,
  'services/traffic-taps/redis.ts :: nvr:idem': LABEL,
  'services/traffic-taps/redis.ts :: nvr:transition': LABEL,
  'services/traffic-taps/redis.ts :: nvr:cron': LABEL,
  'services/traffic-taps/redis.ts :: nvr:ev': LABEL,
  'services/traffic-taps/redis.ts :: nvr:keyrl': LABEL,
  'services/traffic-taps/redis.ts :: nvr:masq': LABEL,
  'services/traffic-taps/redis.ts :: nvr:autofill': LABEL,
  'services/traffic-taps/redis.ts :: nvr:aichat': LABEL,
  'services/traffic-taps/redis.ts :: nvr:queue-backfill': LABEL,
  'services/traffic-taps/redis.ts :: nvr:bulk': LABEL,
  'services/traffic-taps/redis.ts :: nvr:boots': LABEL,
  'services/traffic-taps/redis.ts :: nvr:instance': LABEL,
  'services/traffic-taps/redis.ts :: nvr:chatreply': LABEL,
  'services/traffic-taps/redis.ts :: nvr:linkprev': LABEL,
  'services/traffic-taps/redis.ts :: nvr:epoch': LABEL,
  'services/traffic-taps/redis.ts :: nvr:mdl2': LABEL,
  'services/chaos/redis-keys.ts :: nvr:mdl2:': LABEL,
  'services/chaos/redis-keys.ts :: nvr:cron:': LABEL,
  'services/chaos/redis-keys.ts :: nvr:ev': LABEL,
  'services/chaos/redis-keys.ts :: nvr:idem': LABEL,
  'services/chaos/redis-keys.ts :: nvr:': LABEL,
  'routes/hub-app-link.ts :: nvr:hub:signins:new:': HUB,
  'routes/hub-docker.ts :: nvr:hub:check-name:': HUB,
  'services/hub/create/store.ts :: nvr:hub:create-repo:': HUB,
  'services/hub/create/store.ts :: nvr:hub:create-start': HUB,
  'services/hub/create/store.ts :: nvr:hub:create-cancel:': HUB,
  'services/hub/db/db-lock.ts :: nvr:hub:db:': HUB,
  'services/hub/deploy-evidence.ts :: nvr:hub:evidence:jobs:': HUB,
  'services/hub/deploys.ts :: nvr:hub:deploys:': HUB,
  'services/hub/oidc/codes.ts :: nvr:hub-oidc:code:': HUB,
  'services/hub/promote-lock.ts :: nvr:hub:promote:': HUB,
  'routes/hub-shared.ts :: nvr:hub:shared-status:': HUB,
  'services/hub/shared/sightings.ts :: nvr:hub:shared:': HUB,
  'services/hub/promote-lock.ts :: nvr:hub:promote-cancel:': HUB,
  'services/hub/promote-lock.ts :: nvr:hub:shared:': HUB,
  'services/hub/status.ts :: nvr:hub:status:': HUB,
  'routes/teams-bot.ts :: nvr:teams:act:': OFF,
  'services/teams-bot/actions.ts :: nvr:teams:nonce:': OFF,
  'services/teams-bot/stats.ts :: nvr:teams:stat:': OFF,
  'services/hub-signin/link-client.ts :: nvr:hub-signin-push:': OFF,
  'services/hub-signin/link-client.ts :: nvr:hub-switcher:': OFF,
  'services/outside-write-watch.ts :: nvr:rt:outside:': OFF,
  'services/cache-warm-on-change.ts :: nvr:warm:chg:plan': OFF,
  'services/cache-warm-on-change.ts :: nvr:warm:chg:plan:lock': OFF,
  'services/cache-warm-on-change.ts :: nvr:warm:chg:cd:': OFF,
  'services/cache-warm-on-change.ts :: nvr:warm:chg:stats:': OFF,
  'services/chaos/cron-test-job.ts :: nvr:cron:leader:chaos-test': OFF,
  'db/metadata-l2.ts :: nvr:mdl2':
    'metadata L2: genPrefix() adds getTenantId() and the DB incarnation',
  'plugins/cron.ts :: nvr:cron:leader':
    "scheduler leader lease of the deployment (one leader ticks every app's jobs)",
  'plugins/cron.ts :: nvr:cron:run:':
    "per-app job runs carry `@<tenant>` in the job id (P5-9); plugins/cron.ts is Task 8's",
  'plugins/cron.ts :: nvr:cron:active:':
    "per-app job runs carry `@<tenant>` in the job id (P5-9); plugins/cron.ts is Task 8's",
  'plugins/cron.ts :: nvr:cron:heavy':
    "heavy-slot lease; per-app runs suffix `:<tenant>` (P5-9); plugins/cron.ts is Task 8's",
  'plugins/cron.ts :: nvr:cron:held:':
    'held-slot marker per job id; per-app job ids carry `@<tenant>` (P5-9)',
  'routes/layout-collab.ts :: nvr:formpreview:rl:':
    'anti-abuse limiter keyed by a random preview token and the caller IP',
  'routes/oauth.ts :: nvr:oauth:rl:':
    'per-IP limiter on the OAuth endpoints; counts only, no app data',
  'services/agent-presence.ts :: nvr:agentp:':
    'keyed by a record room, which is tenantScopedRoom() (app-prefixed)',
  'services/ai-answer-cache.ts :: nvr:aichat:':
    'the tenant is inside the hashed part (scope.tenant in answerCacheKey)',
  'services/ai-ask-attachments.ts :: nvr:askdoc:rate:':
    'the key variable is currentTenantKey() + the user (takeUploadSlot)',
  'services/ai-explain.ts :: nvr:aiexplain:':
    'content-addressed: a hash of the exact instructions and facts, so the same input gives the same answer',
  'services/ai-stream-delivery.ts :: nvr:aistop:':
    'stop flag for a random Ask AI stream id, checked against the asker; grants nothing',
  'services/approval-changes.ts :: nvr:cab:':
    'the key variable starts with currentTenantKey() (burstKey)',
  'services/approval-changes.ts :: nvr:cab:chg:':
    'the key variable starts with currentTenantKey() (burstKey)',
  'services/cell-locks.ts :: nvr:cell-lock:': 'prefix; cellLockKey() adds currentTenantKey()',
  'services/chat-bot-stream.ts :: nvr:chatbot:stream:':
    'owner of a random chat-bot stream id (who may stop it); grants nothing',
  'services/chat-link-preview.ts :: nvr:linkprev:':
    'cache of a public URL preview keyed by the URL hash; holds no app data',
  'services/chat-send.ts :: nvr:chatreply:':
    'random one-time token; the value carries `t` and is refused in another app before it is spent',
  'services/event-journal.ts :: nvr:ev:seq':
    'deployment-wide event sequence; every event names a tenant-scoped room',
  'services/event-journal.ts :: nvr:ev:journal':
    'deployment-wide event journal; every event names a tenant-scoped room',
  'services/event-journal.ts :: nvr:ev:rseq:':
    'per-room counter; rooms are tenantScopedRoom() (app-prefixed)',
  'services/event-journal.ts :: nvr:ev:iseq:': 'per-record counter under a tenant-scoped room',
  'services/event-stream.ts :: nvr:ev:stream':
    'deployment-wide event stream; every event names a tenant-scoped room',
  'services/socket-replay.ts :: nvr:ev:stream':
    'reads the deployment-wide event stream; every event names a tenant-scoped room',
  'services/file-processing.ts :: nvr:fileproc:': 'keyOf() puts currentTenantKey() first',
  'services/job-runs.ts :: nvr:joblog:': 'logKey() puts currentTenantKey() first',
  'services/oauth-store.ts :: nvr:oauth:':
    'prefix; every record carries `t` and is refused in another app (sameTenant)',
  'services/oauth-store.ts :: nvr:oauth:rt-replay:v1:':
    "keyed by a spent refresh token's hash and encrypted with that token; the grant is app-checked first",
  'services/oauth-store.ts :: nvr:install:': 'hash input for a stored install id, not a Redis key',
  'services/permission-cache.ts :: nvr:permver':
    'prefix; the key helper adds getTenantId() and the cache is off on multi-tenant',
  'services/readiness.ts :: nvr:readiness:v1:': 'scope = currentTenantKey() + the API version',
  'services/readiness.ts :: nvr:readiness:lock:': 'scope = currentTenantKey() + the API version',
  'services/readiness.ts :: nvr:readiness:fresh:': 'scope = currentTenantKey() + the API version',
  'services/realtime-board.ts :: nvr:rt:board:':
    'per-instance board of record viewers keyed by tenant-scoped rooms',
  'services/security.ts :: nvr:maintenance':
    "on multi-tenant the deployment-wide operator freeze by design (P5 T7); each app's own maintenance is its settings row",
  'services/socket-health.ts :: nvr:rt:resync:':
    'keyed by a random browser tab id; a resync hint, grants nothing',
  'services/sql-checks/run.ts :: nvr:sqlchecks:lock:': 'runKey() = getTenantId()',
  'services/tenancy/hub-source.ts :: nvr:tenancy:hub:':
    "the deployment's own sealed tenant list (one per deployment by design)"
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

  it('every nvr: Redis key names the app on a shared deployment, or is allow-listed', () => {
    const keys = scanNvrKeys()
    const unbound = [...keys].filter(([id, bound]) => !bound && !NVR_ALLOW[id]).map(([id]) => id)
    expect(
      unbound,
      `add the app part (appKeyPart()) or allow-list with a reason:\n${unbound.join('\n')}`
    ).toEqual([])
    const stale = Object.keys(NVR_ALLOW).filter((id) => !keys.has(id) || keys.get(id))
    expect(
      stale,
      `remove from NVR_ALLOW (gone, or now names the app):\n${stale.join('\n')}`
    ).toEqual([])
  })

  it('every entry says why', () => {
    for (const e of [...Object.values(REDIS_SITES), ...Object.values(SECRET_SITES)])
      expect(e.why.length).toBeGreaterThan(10)
    for (const why of Object.values(NVR_ALLOW)) expect(why.length).toBeGreaterThan(10)
  })
})
