import type { FastifyInstance } from 'fastify'
import { adminBaseUrl } from '../admin-base.js'
import { config } from '../config.js'
import { db } from '../db/index.js'
import { requireAdmin, requireAuth } from '../middleware/authenticate.js'
import { activeMasquerades } from '../services/masquerade-marker.js'
import {
  presencePageLabel,
  presenceRowIdle,
  stuckLabel,
  stuckMinutes
} from '../services/presence-stuck.js'
import { currentTenantKey, tenantScopedRoom } from '../services/tenant-rooms.js'
import type { User } from '../types.js'

const KEY_PREFIX = 'presence:session:'

/**
 * Cloud: one Redis holds every tenant's presence sessions, so keys and the admin room carry
 * the tenant (tenant-rooms.ts, `t:<tenant>:`); self-hosted names are unchanged. Every caller
 * runs in its request's tenant context; the sweep walks tenants itself.
 */
export function sessionKeyPrefix(tenant = currentTenantKey()): string {
  return tenantScopedRoom(KEY_PREFIX, tenant)
}
export function adminRoom(tenant = currentTenantKey()): string {
  return tenantScopedRoom('presence:admin', tenant)
}

// Defaults used when DB columns are null/missing
const DEFAULT_SESSION_TTL = 90
const DEFAULT_SWEEP_INTERVAL = 8_000
const DEFAULT_PING_INTERVAL = 10_000

// Simple 30s in-process cache so every ping doesn't hit the DB
let _cfg: { ttl: number; sweep: number; cachedAt: number } | null = null

async function getPresenceCfg() {
  const now = Date.now()
  if (_cfg && now - _cfg.cachedAt < 30_000) return _cfg
  const row = await db('nivaro_settings')
    .first('presence_session_ttl', 'presence_sweep_interval')
    .catch(() => null)
  _cfg = {
    ttl: row?.presence_session_ttl ?? DEFAULT_SESSION_TTL,
    sweep: row?.presence_sweep_interval ?? DEFAULT_SWEEP_INTERVAL,
    cachedAt: now
  }
  return _cfg
}

interface PresencePing {
  sessionId: string
  userId?: string | null
  userEmail?: string | null
  userName?: string | null
  pageUrl: string
  pageTitle?: string | null
  referrer?: string | null
  deviceType?: string | null
  screenWidth?: number | null
  screenHeight?: number | null
  viewportWidth?: number | null
  viewportHeight?: number | null
}

interface PresenceSession extends PresencePing {
  ip: string | null
  userAgent: string | null
  firstSeen: string
  lastSeen: string
}

function sanitizeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64)
}

async function getActiveSessions(
  app: FastifyInstance,
  tenant = currentTenantKey()
): Promise<PresenceSession[]> {
  const sessions: PresenceSession[] = []
  let cursor = '0'
  do {
    const [next, keys] = await app.redis.scan(
      cursor,
      'MATCH',
      `${sessionKeyPrefix(tenant)}*`,
      'COUNT',
      100
    )
    cursor = next
    if (keys.length) {
      const values = await app.redis.mget(...(keys as string[]))
      for (const v of values) {
        if (v) {
          try {
            sessions.push(JSON.parse(v) as PresenceSession)
          } catch {}
        }
      }
    }
  } while (cursor !== '0')
  return sessions.sort((a, b) => b.lastSeen.localeCompare(a.lastSeen))
}

/** Tenants with live presence sessions ('' self-hosted). */
export async function sessionTenants(app: FastifyInstance): Promise<string[]> {
  if (!process.env.CLOUD_META_DB_URL) return ['']
  const tenants = new Set<string>()
  let cursor = '0'
  do {
    const [next, keys] = await app.redis.scan(cursor, 'MATCH', `t:*:${KEY_PREFIX}*`, 'COUNT', 200)
    cursor = next
    for (const k of keys as string[]) {
      const m = /^t:([^:]+):/.exec(k)
      if (m) tenants.add(m[1])
    }
  } while (cursor !== '0')
  return [...tenants]
}

export function buildScript(pingInterval = DEFAULT_PING_INTERVAL): string {
  return embeddableScript(pingInterval)
}

function embeddableScript(pingInterval: number): string {
  return `(function(){
  var script = document.currentScript || (function(){
    var s = document.getElementsByTagName('script');
    return s[s.length - 1];
  })();

  var cfg = window.NivaroPresence || {};
  var apiUrl = (cfg.apiUrl || script.getAttribute('data-api-url') || '').replace(/\\/$/,'');
  var userId = cfg.userId || script.getAttribute('data-user-id') || '';
  var userEmail = cfg.userEmail || script.getAttribute('data-user-email') || '';
  var userName = cfg.userName || script.getAttribute('data-user-name') || '';

  if (!apiUrl) return;

  var STORAGE_KEY = 'nvr_presence_sid';
  var sessionId;
  try {
    sessionId = localStorage.getItem(STORAGE_KEY) || generateId();
    localStorage.setItem(STORAGE_KEY, sessionId);
  } catch(e) { sessionId = generateId(); }

  function generateId() {
    if (window.crypto && window.crypto.randomUUID) return window.crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c){
      var r = Math.random() * 16 | 0;
      return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
  }

  function deviceType() {
    var ua = navigator.userAgent;
    if (/tablet|ipad|playbook|silk/i.test(ua)) return 'tablet';
    if (/mobile|iphone|ipod|android|blackberry|mini|windows\\sce|palm/i.test(ua)) return 'mobile';
    return 'desktop';
  }

  function payload() {
    return {
      sessionId: sessionId,
      userId: userId || null,
      userEmail: userEmail || null,
      userName: userName || null,
      pageUrl: location.href,
      pageTitle: document.title,
      referrer: document.referrer || null,
      deviceType: deviceType(),
      screenWidth: screen.width,
      screenHeight: screen.height,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
    };
  }

  function send(path, data) {
    var url = apiUrl + path;
    var body = JSON.stringify(data);
    // fetch+keepalive is the spec-recommended replacement for sendBeacon.
    // sendBeacon forces credentials:'include' which breaks cross-origin * CORS.
    fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body, keepalive: true }).catch(function(){});
  }

  function ping() { send('/api/presence/ping', payload()); }
  function disconnect() { send('/api/presence/disconnect', { sessionId: sessionId }); }

  // ── Page-view analytics ───────────────────────────────────────────────────
  var _vid = null;
  var _vs = 0;

  function trackView(prevDur) {
    var body = JSON.stringify({
      sessionId: sessionId, userId: userId||null, userEmail: userEmail||null,
      userName: userName||null, pageUrl: location.href, pageTitle: document.title,
      referrer: document.referrer||null, deviceType: deviceType(),
      previousViewId: (prevDur!=null&&_vid)?_vid:null,
      previousDuration: (prevDur!=null)?Math.max(0,prevDur):null,
    });
    _vs = Date.now(); _vid = null;
    fetch(apiUrl+'/api/analytics/pageview',{method:'POST',headers:{'Content-Type':'application/json'},body:body,keepalive:true})
      .then(function(r){return r.json();}).then(function(d){if(d&&d.id)_vid=d.id;}).catch(function(){});
  }

  function closeView() {
    if(!_vid) return;
    var dur = Math.round((Date.now()-_vs)/1000);
    fetch(apiUrl+'/api/analytics/pageview/'+_vid,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({duration:dur,sessionId:sessionId}),keepalive:true}).catch(function(){});
    _vid = null;
  }

  ping();
  trackView(null);
  var iv = setInterval(ping, ${pingInterval});

  document.addEventListener('visibilitychange', function(){
    if (document.visibilityState === 'visible') ping();
  });

  var lastUrl = location.href;
  var origPush = history.pushState;
  history.pushState = function(){
    var prevDur = _vid ? Math.round((Date.now()-_vs)/1000) : null;
    origPush.apply(this, arguments);
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      setTimeout(function(){ ping(); trackView(prevDur); }, 100);
    }
  };
  window.addEventListener('popstate', function(){
    var prevDur = _vid ? Math.round((Date.now()-_vs)/1000) : null;
    setTimeout(function(){ ping(); trackView(prevDur); }, 100);
  });
  window.addEventListener('pagehide', function(){ disconnect(); closeView(); });
  window.addEventListener('beforeunload', function(){ closeView(); });
  window.addEventListener('unload', function(){ clearInterval(iv); });

  window.NivaroPresenceClient = {
    ping: ping,
    disconnect: disconnect,
    trackView: trackView,
    sessionId: sessionId,
    setUser: function(id, email, name){
      userId = id || '';
      userEmail = email || '';
      userName = name || '';
    },
  };
})();`
}

// Public routes — no auth, called from external sites under open CORS scope
export async function presencePublicRoutes(app: FastifyInstance) {
  // ── POST /ping ───────────────────────────────────────────────────────────
  app.post<{ Body: PresencePing }>(
    '/ping',
    {
      schema: {
        body: {
          type: 'object',
          required: ['sessionId', 'pageUrl'],
          additionalProperties: false,
          properties: {
            sessionId: { type: 'string', maxLength: 64 },
            userId: { type: ['string', 'null'], maxLength: 128 },
            userEmail: { type: ['string', 'null'], maxLength: 254 },
            userName: { type: ['string', 'null'], maxLength: 128 },
            pageUrl: { type: 'string', maxLength: 2048 },
            pageTitle: { type: ['string', 'null'], maxLength: 256 },
            referrer: { type: ['string', 'null'], maxLength: 2048 },
            deviceType: { type: ['string', 'null'], maxLength: 16 },
            screenWidth: { type: ['number', 'null'] },
            screenHeight: { type: ['number', 'null'] },
            viewportWidth: { type: ['number', 'null'] },
            viewportHeight: { type: ['number', 'null'] }
          }
        }
      }
    },
    async (req, reply) => {
      if (!app.redis) return reply.code(503).send({ error: 'Redis unavailable' })
      const body = req.body
      const sessionId = sanitizeId(body.sessionId)
      const key = sessionKeyPrefix() + sessionId

      const existing = await app.redis.get(key)
      const firstSeen = existing
        ? (JSON.parse(existing) as PresenceSession).firstSeen
        : new Date().toISOString()

      const session: PresenceSession = {
        sessionId,
        userId: body.userId ?? null,
        userEmail: body.userEmail ?? null,
        userName: body.userName ?? null,
        pageUrl: body.pageUrl,
        pageTitle: body.pageTitle ?? null,
        referrer: body.referrer ?? null,
        deviceType: body.deviceType ?? 'desktop',
        screenWidth: body.screenWidth ?? null,
        screenHeight: body.screenHeight ?? null,
        viewportWidth: body.viewportWidth ?? null,
        viewportHeight: body.viewportHeight ?? null,
        ip: req.ip ?? null,
        userAgent: req.headers['user-agent'] ?? null,
        firstSeen,
        lastSeen: new Date().toISOString()
      }

      const { ttl } = await getPresenceCfg()
      await app.redis.setex(key, ttl, JSON.stringify(session))

      if (app.io) {
        const sessions = await getActiveSessions(app)
        app.io.to(adminRoom()).emit('presence:update', { sessions })
      }

      return reply.code(204).send()
    }
  )

  // ── POST /disconnect ─────────────────────────────────────────────────────
  app.post<{ Body: { sessionId?: string } }>('/disconnect', async (req, reply) => {
    if (app.redis && req.body?.sessionId) {
      const sessionId = sanitizeId(req.body.sessionId)
      if (sessionId) {
        await app.redis.del(sessionKeyPrefix() + sessionId)
        if (app.io) {
          const sessions = await getActiveSessions(app)
          app.io.to(adminRoom()).emit('presence:update', { sessions })
        }
      }
    }
    return reply.code(204).send()
  })

  // Self-rescheduling sweep so interval picks up DB changes within 30s
  app.addHook('onReady', async () => {
    if (!app.redis || !app.io) return
    async function sweep() {
      try {
        const { sweep: ms } = await getPresenceCfg()
        // The sweep runs outside any request: self-hosted one list; cloud one per tenant that
        // has live sessions, each to its own admin room.
        for (const tenant of await sessionTenants(app)) {
          const sessions = await getActiveSessions(app, tenant)
          app.io!.to(adminRoom(tenant)).emit('presence:update', { sessions })
        }
        setTimeout(sweep, ms)
      } catch {
        setTimeout(sweep, DEFAULT_SWEEP_INTERVAL)
      }
    }
    sweep()
  })
}

/** Matches the client's own threshold (packages/shared/src/lib/idle.ts). */
const IDLE_AFTER_MS = 5 * 60_000

/**
 * GET /online — the enriched online list the chat panels render.
 *
 * Presence rows themselves stay dumb (a heartbeat writes name/path); everything
 * shown UNDER a name is resolved here so admin and any headless host
 * agree without each re-implementing it:
 *   role    — the user's role name
 *   scopes  — their RESTRICTED user-scope values per dimension, as labels
 *             ("Zone 1"), which is what "restricted zone/region" means
 *   page    — a human label for current_path, not the raw route
 * Which of those appear is instance config (nivaro_settings.presence_display).
 * `recording_id` is attached for ADMINS only — the live session recording, so
 * an admin can jump from the online list straight into session replay.
 */

// The page text lives with stuckLabel so the stuck chip and the page line name a place the
// same way; re-exported for this route's callers.
export { presencePageLabel } from '../services/presence-stuck.js'

/**
 * "Requests › REQ-1234", not "Requests › 98765".
 *
 * The label has to come from the server: rendering a record's display template
 * needs the template and the row, and the chat panel has neither. Resolved in
 * one query per collection over the whole online list rather than per row.
 */
export async function resolveRecordLabels(
  paths: Array<string | null | undefined>,
  viewer: User
): Promise<Map<string, string>> {
  const wanted = new Map<string, Set<string>>()
  const out = new Map<string, string>()
  for (const raw of paths) {
    if (!raw) continue
    // /records/<collection>/<id> and /collections/<collection>/<id>
    const m = /^\/(?:records|collections)\/([A-Za-z0-9_]+)\/([^/?#]+)/.exec(raw)
    if (!m) continue
    const [, collection, id] = m
    if (id === 'new') continue
    if (/^(nivaro_|directus_|staging_)/i.test(collection)) continue
    const set = wanted.get(collection) ?? new Set<string>()
    set.add(id)
    wanted.set(collection, set)
  }
  if (wanted.size === 0) return out

  // Labels come through the caller's own read (role, row filter, User Scopes, field access):
  // only ids the viewer could read get a label. A record they cannot read is not named, and
  // callers show the collection title alone.
  const registered = new Set<string>()
  for (const collection of wanted.keys()) {
    // current_path is written by the CLIENT, so the collection name in it is untrusted.
    // It must be a REGISTERED collection, not an arbitrary table someone names.
    const meta = await db('nivaro_collections')
      .where({ collection })
      .first('collection')
      .catch(() => undefined)
    if (meta) registered.add(collection)
  }
  const byTarget = new Map<string, Set<string>>()
  for (const [collection, ids] of wanted)
    if (registered.has(collection)) byTarget.set(collection, ids)
  const { linkLabelsAsUser } = await import('../services/ai-link-labels.js')
  const labels = await linkLabelsAsUser(viewer, byTarget).catch(
    () => ({}) as Record<string, string>
  )
  for (const [k, v] of Object.entries(labels)) out.set(k, v)
  return out
}

/**
 * Who a viewer may see in presence (the Online list, chat badges, last seen).
 * A restricted user sees only people restricted the SAME way, plus admins
 * (visible to everyone). Each dimension the VIEWER restricts must overlap: a
 * Zone-1 viewer sees Zone-1 people; a Zone-1 + BLT viewer sees only people who
 * are both. Someone with NO restriction on a dimension the viewer restricts is
 * broader than the viewer and is therefore not shown — that is what makes more
 * restrictions mean a narrower view. Returns upper-cased ids.
 *
 * Enforced on the server because it is a visibility boundary. (The raw
 * user_presence collection is still readable through /items for anyone with
 * read permission — sealing that needs a row filter on the collection.)
 */
export async function visibleToViewer(
  viewer: { id: string },
  isAdmin: boolean,
  ids: string[]
): Promise<Set<string>> {
  const all = new Set(ids.map((i) => String(i).toUpperCase()))
  if (isAdmin || all.size === 0) return all
  const viewerRestrictions = new Map<string, Set<string>>()
  const own = (await db('nivaro_user_scopes')
    .where({ user: viewer.id, mode: 'restrict' })
    .select('dimension', 'values')) as Array<Record<string, unknown>>
  for (const r of own) {
    const vals = parseScopeValues(r.values)
    if (vals.length > 0) viewerRestrictions.set(String(r.dimension), new Set(vals))
  }
  if (viewerRestrictions.size === 0) return all
  const listedIds = [...all]
  const [adminRows, scopeRows] = await Promise.all([
    db('nivaro_users as u')
      .join('nivaro_roles as ro', 'ro.id', 'u.role')
      .whereIn('u.id', listedIds)
      .where('ro.admin_access', true)
      .select('u.id') as Promise<Array<{ id: string }>>,
    db('nivaro_user_scopes')
      .whereIn('user', listedIds)
      .where({ mode: 'restrict' })
      .select('user', 'dimension', 'values') as Promise<Array<Record<string, unknown>>>
  ])
  const admins = new Set(adminRows.map((a) => String(a.id).toUpperCase()))
  const theirs = new Map<string, Map<string, Set<string>>>()
  for (const r of scopeRows) {
    const key = String(r.user).toUpperCase()
    const perDim = theirs.get(key) ?? new Map<string, Set<string>>()
    perDim.set(String(r.dimension), new Set(parseScopeValues(r.values)))
    theirs.set(key, perDim)
  }
  const me = String(viewer.id).toUpperCase()
  const out = new Set<string>()
  for (const uid of listedIds) {
    if (uid === me || admins.has(uid)) {
      out.add(uid)
      continue
    }
    const perDim = theirs.get(uid)
    if (!perDim) continue
    let ok = true
    for (const [dim, allowed] of viewerRestrictions) {
      const mine = perDim.get(dim)
      if (!mine || mine.size === 0 || ![...mine].some((v) => allowed.has(v))) {
        ok = false
        break
      }
    }
    if (ok) out.add(uid)
  }
  return out
}

function parseScopeValues(raw: unknown): string[] {
  try {
    const parsed = raw ? JSON.parse(String(raw)) : []
    return Array.isArray(parsed) ? parsed.map(String) : []
  } catch {
    return []
  }
}

/** preferences JSON → object, tolerant of the nvarchar shape and bad blobs. */
function parsePrefs(raw: unknown): Record<string, unknown> {
  try {
    return typeof raw === 'string'
      ? ((JSON.parse(raw) as Record<string, unknown>) ?? {})
      : ((raw as Record<string, unknown>) ?? {})
  } catch {
    return {}
  }
}

/** "Appear away" (preferences.presence_override) in force right now? */
function awayOverride(prefs: Record<string, unknown>): boolean {
  const po = prefs.presence_override as { mode?: string; until?: string | null } | null | undefined
  if (!po || po.mode !== 'away') return false
  if (po.until && new Date(po.until).getTime() < Date.now()) return false
  return true
}

export async function presenceOnlineRoutes(app: FastifyInstance) {
  app.get('/online', { preHandler: requireAuth }, async (req, reply) => {
    // A live socket is the authoritative signal: it ends the moment the tab
    // closes, where the timestamp window can only expire slowly. The window
    // stays as a fallback for a host with no socket, and covers the seconds
    // between an HTTP heartbeat and a socket connecting.
    // last_seen freshness is the ONLY authority for being online: the socket
    // flips is_online on disconnect, but its bookkeeping is per-process
    // memory, so every API restart stranded is_online=true bits and those
    // rows read as online FOREVER (the reported ghost-online bug). Beats
    // re-assert is_online=true every ~25s, so a false bit self-heals in one
    // beat while a closed tab (socket flip + no more beats) drops instantly.
    const windowMs = 70_000
    const since = new Date(Date.now() - windowMs)
    const rows = (await db('user_presence')
      .where('last_seen', '>=', since)
      .where((qb) => void qb.where('is_online', true).orWhereNull('is_online'))
      .orderBy('last_seen', 'desc')
      .limit(200)) as Array<Record<string, unknown>>

    // ── Who this viewer may see ──────────────────────────────────────────
    // A restricted user sees only people restricted the SAME way, plus admins
    // (who are visible to everyone). Each dimension the VIEWER restricts must
    // overlap: a Zone-1 viewer sees Zone-1 people; a Zone-1 + BLT viewer sees
    // only people who are both. Someone with NO restriction on a dimension the
    // viewer restricts is broader than the viewer and is therefore not shown —
    // that is what makes more restrictions mean a narrower view.
    //
    // Enforced here rather than in the client: this is a visibility boundary.
    // (The raw user_presence collection is still readable through /items for
    // anyone with read permission — sealing that needs a row filter on the
    // collection, which this does not attempt.)
    const visibleIds = await visibleToViewer(
      req.user!,
      !!req.isAdmin,
      rows.map((r) => String(r.user_id)).filter(Boolean)
    )
    const visibleRows = rows.filter((row) =>
      visibleIds.has(String(row.user_id ?? '').toUpperCase())
    )

    let cfg: { fields?: string[]; scope_dimensions?: string[] } | null = null
    try {
      const settings = (await db('nivaro_settings').where({ id: 1 }).first()) as
        | Record<string, unknown>
        | undefined
      cfg = settings?.presence_display ? JSON.parse(String(settings.presence_display)) : null
    } catch {
      cfg = null
    }
    const fields = cfg?.fields?.length ? cfg.fields : ['role', 'page']
    const dimensions = cfg?.scope_dimensions ?? []
    let dimensionMeta: Array<{ name: string; label: string }> = []
    if (dimensions.length > 0) {
      try {
        const { listScopeDimensions } = await import('../services/user-scopes.js')
        dimensionMeta = (await listScopeDimensions())
          .filter((d) => dimensions.includes(d.name))
          .map((d) => ({ name: d.name, label: d.label }))
      } catch {
        dimensionMeta = dimensions.map((n) => ({ name: n, label: n }))
      }
    }

    // Scope labels: one query per dimension for every listed user, not per user.
    const userIds = visibleRows.map((r) => String(r.user_id)).filter(Boolean)
    const scopesByUser = new Map<string, Map<string, string[]>>()
    if (fields.includes('scopes') && dimensions.length > 0 && userIds.length > 0) {
      try {
        const { resolveScopeLabelsForUsers } = await import('../services/user-scopes.js')
        const resolved = await resolveScopeLabelsForUsers(userIds, dimensions)
        for (const [uid, perDim] of resolved) scopesByUser.set(uid.toUpperCase(), perDim)
      } catch {
        // Scope labels are decoration — never fail the online list over them.
      }
    }

    // Live recordings, admin only (replay is an admin surface).
    const recordingByUser = new Map<string, string>()
    if (req.isAdmin && userIds.length > 0) {
      try {
        const recs = (await db('nivaro_session_recordings')
          .whereIn('user', userIds)
          .whereNull('ended_at')
          .orderBy('last_event_at', 'desc')
          .select('id', 'user')) as Array<{ id: string; user: string }>
        for (const r of recs) {
          const key = String(r.user).toUpperCase()
          if (!recordingByUser.has(key)) recordingByUser.set(key, String(r.id))
        }
      } catch {
        // Recording may be disabled entirely — absence just hides the action.
      }
    }

    // Custom statuses (#33) and "appear away", from user preferences.
    const statusByUser = new Map<string, { text: string; emoji: string | null }>()
    const awayByUser = new Set<string>()
    if (userIds.length > 0) {
      try {
        const prefRows = (await db('nivaro_users')
          .whereIn('id', userIds)
          .select('id', 'preferences')) as Array<{ id: string; preferences: unknown }>
        for (const pr of prefRows) {
          const prefs = parsePrefs(pr.preferences)
          const uid = String(pr.id).toUpperCase()
          if (awayOverride(prefs)) awayByUser.add(uid)
          const cs = prefs.custom_status as
            | { text?: string; emoji?: string | null; expires_at?: string | null }
            | null
            | undefined
          if (!cs?.text) continue
          if (cs.expires_at && new Date(cs.expires_at).getTime() < Date.now()) continue
          statusByUser.set(uid, {
            text: String(cs.text),
            emoji: cs.emoji ? String(cs.emoji) : null
          })
        }
      } catch {
        /* decoration only */
      }
    }

    // Who is really at the keyboard: an admin masquerading as this user
    // refreshes a short-lived marker on every request (masquerade-marker.ts).
    const masqByUser = await activeMasquerades(app.redis, userIds.map(String))
    const adminNames = new Map<string, string>()
    if (masqByUser.size) {
      try {
        const admins = (await db('nivaro_users')
          .whereIn('id', [...new Set(masqByUser.values())])
          .select('id', 'first_name', 'last_name', 'email')) as Array<Record<string, unknown>>
        for (const a of admins)
          adminNames.set(
            String(a.id).toUpperCase(),
            [a.first_name, a.last_name].filter(Boolean).join(' ') || String(a.email ?? '')
          )
      } catch {
        /* decoration only */
      }
    }

    const recordLabels = await resolveRecordLabels(
      visibleRows.map((r) => (r.current_path as string | null) ?? null),
      req.user!
    )
    const pageLabel = (path: string | null | undefined) => presencePageLabel(path, recordLabels)

    // #1394 — stuck: at the keyboard, same route, nothing saved for ten
    // minutes. Shown to admins and to the person's own manager only: it reads
    // their request log, which is more than the page they are on.
    const stuckByUser = new Map<string, { minutes: number; label: string | null }>()
    try {
      let mayKnow: Set<string> | null = null
      if (!req.isAdmin) {
        const mine = userIds.length
          ? ((await db('nivaro_users')
              .whereIn('id', userIds)
              .where('manager_id', req.user!.id)
              .select('id')) as Array<{ id: string }>)
          : []
        mayKnow = new Set(mine.map((m) => String(m.id).toUpperCase()))
      }
      const people = visibleRows
        .filter((r) => !mayKnow || mayKnow.has(String(r.user_id ?? '').toUpperCase()))
        .map((r) => ({
          id: String(r.user_id ?? ''),
          idle: presenceRowIdle(r, awayByUser.has(String(r.user_id ?? '').toUpperCase())),
          lastActive: r.last_active ? new Date(r.last_active as string).getTime() : null
        }))
      if (people.length > 0) {
        const stuck = await stuckMinutes(people)
        for (const r of visibleRows) {
          const uid = String(r.user_id ?? '').toUpperCase()
          const minutes = stuck.get(uid)
          if (minutes != null)
            stuckByUser.set(uid, {
              minutes,
              label: stuckLabel(r.current_path as string | null, recordLabels)
            })
        }
      }
    } catch {
      /* decoration only */
    }

    return reply.send({
      data: visibleRows.map((r) => {
        const uid = String(r.user_id ?? '').toUpperCase()
        return {
          user_id: r.user_id,
          display_name: r.display_name,
          role_name: r.role_name,
          // The raw route can carry a record id the viewer may not read; everyone gets `page`
          // (labelled only through their own read access). Administrators keep the route.
          current_path: req.isAdmin ? r.current_path : undefined,
          last_seen: r.last_seen,
          // Reported by the client: the heartbeat alone cannot tell a person
          // at their desk from a tab left open. Older rows (written before the
          // column existed, or by a client that does not report it) read as
          // active rather than guessing at idle.
          // The flag is a client's claim; last_active is when it last saw real
          // input. Trusting the flag alone left people idle forever whenever a
          // client wrote presence without reporting it — the row said idle and
          // nothing ever said otherwise. Recent activity wins.
          // "Appear away" beats activity: the person asked to read as away.
          away: awayByUser.has(uid),
          is_idle: presenceRowIdle(r, awayByUser.has(uid)),
          // #1394 — 'active' | 'idle' | 'stuck'; stuck only for viewers who
          // may know it (admins, the person's manager), else active/idle.
          state: presenceRowIdle(r, awayByUser.has(uid))
            ? 'idle'
            : stuckByUser.has(uid)
              ? 'stuck'
              : 'active',
          stuck: stuckByUser.get(uid) ?? null,
          // How long they've been away from the keyboard, for the "Idle · 12m"
          // label — null while active or unknown.
          idle_minutes: (() => {
            if (awayByUser.has(uid)) return null
            const active = r.last_active ? new Date(r.last_active as string).getTime() : 0
            if (!active) return null
            const mins = Math.floor((Date.now() - active) / 60_000)
            return mins >= Math.floor(IDLE_AFTER_MS / 60_000) ? mins : null
          })(),
          last_active: r.last_active ?? null,
          // Rendered here because only the server can: the panel has neither
          // the display template nor the row.
          page: pageLabel(r.current_path as string | null),
          app: (r.app as string | null) ?? null,
          typing_room: r.typing_room,
          // Flat list for the subtitle line, keyed map for grouping.
          custom_status: statusByUser.get(uid) ?? null,
          scopes: [...(scopesByUser.get(uid)?.values() ?? [])].flat(),
          scopes_by_dimension: Object.fromEntries(scopesByUser.get(uid) ?? []),
          recording_id: recordingByUser.get(uid) ?? null,
          // Set while an admin is masquerading as this user — the row is
          // theirs, the person behind it is someone else.
          masquerade: masqByUser.has(uid)
            ? {
                admin_id: masqByUser.get(uid) ?? null,
                admin_name: adminNames.get(masqByUser.get(uid) ?? '') ?? 'an administrator'
              }
            : null
        }
      }),
      config: {
        fields,
        scope_dimensions: dimensions,
        // Where session replay lives. A headless host is served from its own
        // origin, so a relative link would hit ITS router and 404 — the admin
        // SPA is served by the API, so hand back an absolute URL and any host
        // can offer the action without hardcoding an environment.
        admin_url: adminBaseUrl(),
        // Human labels so a "Group by" control can offer "Zone" not "division".
        dimensions: dimensionMeta
      }
    })
  })
  /**
   * Last seen + time zone for chosen people (#950, #951), under the same
   * visibility rule as /online — someone the viewer may not see is simply
   * absent from the answer. `timezone` is the person's own setting, else the
   * zone their browser reported at sign-in (`timezone_source` says which); null
   * when neither is known, so a header never claims a zone nobody reported.
   */
  app.get('/people', { preHandler: requireAuth }, async (req, reply) => {
    const raw = String((req.query as { ids?: string }).ids ?? '')
    const ids = [
      ...new Set(
        raw
          .split(',')
          .map((s) => s.trim())
          .filter((s) => /^[0-9a-f-]{36}$/i.test(s))
      )
    ].slice(0, 100)
    if (ids.length === 0) return reply.send({ data: [] })
    const visible = [...(await visibleToViewer(req.user!, !!req.isAdmin, ids))]
    if (visible.length === 0) return reply.send({ data: [] })
    const [presenceRows, userRows] = await Promise.all([
      db('user_presence').whereIn('user_id', visible).select('user_id', 'last_seen') as Promise<
        Array<{ user_id: string; last_seen: Date | null }>
      >,
      db('nivaro_users')
        .whereIn('id', visible)
        .select(
          'id',
          'last_access',
          'preferences',
          'is_out_of_office',
          'ooo_end',
          'delegate_id',
          'delegate_expires_at'
        ) as Promise<
        Array<{
          id: string
          last_access: Date | null
          preferences: unknown
          is_out_of_office: boolean | number | null
          ooo_end: Date | null
          delegate_id: string | null
          delegate_expires_at: Date | null
        }>
      >
    ])
    // Out of office + who covers (#973, #988). A delegate is named only when
    // the delegation is live and the delegate can act — suspended or redacted
    // people are never suggested as the one to ask instead.
    const now = Date.now()
    const delegateIds = [
      ...new Set(
        userRows
          .filter(
            (u) =>
              !!u.is_out_of_office &&
              u.delegate_id &&
              (!u.delegate_expires_at || new Date(u.delegate_expires_at).getTime() > now)
          )
          .map((u) => String(u.delegate_id))
      )
    ]
    const delegates = delegateIds.length
      ? ((await db('nivaro_users')
          .whereIn('id', delegateIds)
          .where((q) => q.whereNull('status').orWhereNot('status', 'suspended'))
          .where((q) => q.whereNull('is_redacted').orWhere('is_redacted', false))
          .select('id', 'first_name', 'last_name', 'email')) as Array<{
          id: string
          first_name: string | null
          last_name: string | null
          email: string | null
        }>)
      : []
    const delegateById = new Map(
      delegates.map((d) => [
        String(d.id).toUpperCase(),
        {
          id: d.id,
          name: [d.first_name, d.last_name].filter(Boolean).join(' ') || d.email || 'their delegate'
        }
      ])
    )
    const seen = new Map<string, number>()
    for (const r of presenceRows) {
      const t = r.last_seen ? new Date(r.last_seen).getTime() : 0
      const k = String(r.user_id).toUpperCase()
      if (t > (seen.get(k) ?? 0)) seen.set(k, t)
    }
    const data = userRows.map((u) => {
      const k = String(u.id).toUpperCase()
      const prefs = parsePrefs(u.preferences)
      const access = u.last_access ? new Date(u.last_access).getTime() : 0
      const last = Math.max(seen.get(k) ?? 0, access)
      const profileTz = typeof prefs.timezone === 'string' && prefs.timezone ? prefs.timezone : null
      // Profile zone first, else the zone their browser reported at sign-in (#2484).
      const browserTz =
        typeof prefs.browser_timezone === 'string' && prefs.browser_timezone
          ? prefs.browser_timezone
          : null
      const tz = profileTz ?? browserTz
      const wh = prefs.working_hours as { start?: unknown; end?: unknown } | null | undefined
      return {
        user_id: u.id,
        last_seen: last ? new Date(last).toISOString() : null,
        timezone: tz,
        timezone_source: profileTz ? 'profile' : browserTz ? 'browser' : null,
        working_hours:
          wh && typeof wh.start === 'string' && typeof wh.end === 'string'
            ? { start: wh.start, end: wh.end }
            : null,
        away: awayOverride(prefs),
        out_of_office: !!u.is_out_of_office,
        ooo_end: u.is_out_of_office && u.ooo_end ? new Date(u.ooo_end).toISOString() : null,
        delegate:
          u.is_out_of_office && u.delegate_id
            ? (delegateById.get(String(u.delegate_id).toUpperCase()) ?? null)
            : null
      }
    })
    return reply.send({ data })
  })
}

// Admin routes — requireAdmin, registered under strict CORS scope
export async function presenceAdminRoutes(app: FastifyInstance) {
  // ── GET /sessions ────────────────────────────────────────────────────────
  app.get('/sessions', { preHandler: requireAdmin }, async (_req, reply) => {
    if (!app.redis) return reply.code(503).send({ error: 'Redis unavailable' })
    const sessions = await getActiveSessions(app)
    return { data: sessions, total: sessions.length }
  })

  // ── DELETE /sessions/:sessionId ──────────────────────────────────────────
  app.delete<{ Params: { sessionId: string } }>(
    '/sessions/:sessionId',
    { preHandler: requireAdmin },
    async (req, reply) => {
      if (!app.redis) return reply.code(503).send({ error: 'Redis unavailable' })
      const sessionId = sanitizeId(req.params.sessionId)
      await app.redis.del(sessionKeyPrefix() + sessionId)
      if (app.io) {
        const sessions = await getActiveSessions(app)
        app.io.to(adminRoom()).emit('presence:update', { sessions })
      }
      return reply.code(204).send()
    }
  )

  // ── GET /users/:userId ──────────────────────────────────────────────────
  // Online status for a specific CMS user — used by the UserChip contact card.
  app.get<{ Params: { userId: string } }>(
    '/users/:userId',
    { preHandler: requireAuth },
    async (req, reply) => {
      if (!app.redis) return reply.send({ online: false })
      const sessions = await getActiveSessions(app)
      const online = sessions.some((s) => s.userId === req.params.userId)
      return reply.send({ online })
    }
  )

  // ── GET /:collection/:item ───────────────────────────────────────────────
  // Current viewers of a specific item (for the admin UI item editor).
  // Matches active presence sessions whose pageUrl path is /collections/:collection/:item.
  app.get<{ Params: { collection: string; item: string } }>(
    '/:collection/:item',
    { preHandler: requireAuth },
    async (req, reply) => {
      if (!app.redis) return reply.code(503).send({ error: 'Redis unavailable' })
      const { collection, item } = req.params
      const suffix = `/collections/${collection}/${item}`

      const sessions = await getActiveSessions(app)
      const seen = new Set<string>()
      const viewers: Array<{ user: string | null; name: string | null; since: string }> = []

      for (const s of sessions) {
        let path: string
        try {
          path = new URL(s.pageUrl).pathname
        } catch {
          path = s.pageUrl
        }
        if (path !== suffix && !path.endsWith(suffix)) continue

        const key = s.userId ?? s.sessionId
        if (seen.has(key)) continue
        seen.add(key)
        viewers.push({
          user: s.userId ?? null,
          name: s.userName ?? s.userEmail ?? null,
          since: s.firstSeen
        })
      }

      return reply.send({ data: viewers })
    }
  )
}
