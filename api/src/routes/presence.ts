import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import type { User } from '../types.js'
import { can } from '../services/permissions.js'
import { resolveDisplayValue } from '../services/display-value.js'
import { requireAdmin, requireAuth } from '../middleware/authenticate.js'
import { config } from '../config.js'
import { adminBaseUrl } from '../admin-base.js'

const KEY_PREFIX = 'presence:session:'

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

async function getActiveSessions(app: FastifyInstance): Promise<PresenceSession[]> {
  const sessions: PresenceSession[] = []
  let cursor = '0'
  do {
    const [next, keys] = await app.redis.scan(cursor, 'MATCH', `${KEY_PREFIX}*`, 'COUNT', 100)
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
      const key = KEY_PREFIX + sessionId

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
        app.io.to('presence:admin').emit('presence:update', { sessions })
      }

      return reply.code(204).send()
    }
  )

  // ── POST /disconnect ─────────────────────────────────────────────────────
  app.post<{ Body: { sessionId?: string } }>('/disconnect', async (req, reply) => {
    if (app.redis && req.body?.sessionId) {
      const sessionId = sanitizeId(req.body.sessionId)
      if (sessionId) {
        await app.redis.del(KEY_PREFIX + sessionId)
        if (app.io) {
          const sessions = await getActiveSessions(app)
          app.io.to('presence:admin').emit('presence:update', { sessions })
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
        const sessions = await getActiveSessions(app)
        app.io!.to('presence:admin').emit('presence:update', { sessions })
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
 * shown UNDER a name is resolved here so admin, efp-new and any other host
 * agree without each re-implementing it:
 *   role    — the user's role name
 *   scopes  — their RESTRICTED user-scope values per dimension, as labels
 *             ("Zone 1"), which is what "restricted zone/region" means
 *   page    — a human label for current_path, not the raw route
 * Which of those appear is instance config (nivaro_settings.presence_display).
 * `recording_id` is attached for ADMINS only — the live session recording, so
 * an admin can jump from the online list straight into session replay.
 */

/** collection name → a heading a person would recognise. */
function titleCase(s: string): string {
  return s.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

/**
 * "Workflows › CR26-79811", not "Workflows › 371367".
 *
 * The label has to come from the server: rendering a record's display template
 * needs the template and the row, and the chat panel has neither. Resolved in
 * one query per collection over the whole online list rather than per row.
 */
async function resolveRecordLabels(
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

  for (const [collection, ids] of wanted) {
    try {
      // current_path is written by the CLIENT, so the collectionname in it is
      // untrusted input. Two gates before any row is read: it must be a
      // REGISTERED collection (not an arbitrary table someone names), and this
      // viewer must be allowed to read it — otherwise a person could park a
      // path on a table they cannot see and read labels back out of it.
      const meta = (await db('nivaro_collections')
        .where({ collection })
        .first('display_template')) as { display_template?: string | null } | undefined
      if (!meta) continue
      if (!(await can(viewer, 'read', collection))) continue
      const rows = (await db(collection)
        .whereIn('id', [...ids])
        .limit(200)) as Array<Record<string, unknown>>
      for (const row of rows) {
        const label = meta?.display_template
          ? String(resolveDisplayValue(row, meta.display_template) ?? '').trim()
          : ''
        const fallback = ['workflow_id', 'name', 'title', 'label', 'inventory_request_id']
          .map((f) => row[f])
          .find((v) => v != null && String(v).trim() !== '')
        const text = label || (fallback != null ? String(fallback) : '')
        if (text) out.set(`${collection}:${String(row.id)}`, text)
      }
    } catch {
      // A collection that cannot be read just keeps its raw id.
    }
  }
  return out
}

export async function presenceOnlineRoutes(app: FastifyInstance) {
  app.get('/online', { preHandler: requireAuth }, async (req, reply) => {
    // A live socket is the authoritative signal: it ends the moment the tab
    // closes, where the timestamp window can only expire slowly. The window
    // stays as a fallback for a host with no socket, and covers the seconds
    // between an HTTP heartbeat and a socket connecting.
    const windowMs = 60_000
    const since = new Date(Date.now() - windowMs)
    const rows = (await db('user_presence')
      .where((qb) => void qb.where('is_online', true).orWhere('last_seen', '>=', since))
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
    const viewerRestrictions = new Map<string, Set<string>>()
    if (!req.isAdmin) {
      const own = (await db('nivaro_user_scopes')
        .where({ user: req.user!.id, mode: 'restrict' })
        .select('dimension', 'values')) as Array<Record<string, unknown>>
      for (const r of own) {
        let vals: string[] = []
        try {
          const parsed = r.values ? JSON.parse(String(r.values)) : []
          vals = Array.isArray(parsed) ? parsed.map(String) : []
        } catch {
          vals = []
        }
        if (vals.length > 0) viewerRestrictions.set(String(r.dimension), new Set(vals))
      }
    }

    let visibleRows = rows
    if (viewerRestrictions.size > 0) {
      const listedIds = rows.map((r) => String(r.user_id)).filter(Boolean)
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
        let vals: string[] = []
        try {
          const parsed = r.values ? JSON.parse(String(r.values)) : []
          vals = Array.isArray(parsed) ? parsed.map(String) : []
        } catch {
          vals = []
        }
        const key = String(r.user).toUpperCase()
        const perDim = theirs.get(key) ?? new Map<string, Set<string>>()
        perDim.set(String(r.dimension), new Set(vals))
        theirs.set(key, perDim)
      }
      visibleRows = rows.filter((row) => {
        const uid = String(row.user_id ?? '').toUpperCase()
        if (uid === String(req.user!.id).toUpperCase()) return true
        if (admins.has(uid)) return true
        const perDim = theirs.get(uid)
        if (!perDim) return false
        for (const [dim, allowed] of viewerRestrictions) {
          const mine = perDim.get(dim)
          if (!mine || mine.size === 0) return false
          let overlaps = false
          for (const v of mine) {
            if (allowed.has(v)) {
              overlaps = true
              break
            }
          }
          if (!overlaps) return false
        }
        return true
      })
    }

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

    const recordLabels = await resolveRecordLabels(
      visibleRows.map((r) => (r.current_path as string | null) ?? null),
      req.user!
    )
    const pageLabel = (path: string | null | undefined): string | null => {
      if (!path) return null
      const m = /^\/(?:records|collections)\/([A-Za-z0-9_]+)\/([^/?#]+)/.exec(path)
      if (!m) return null
      const label = recordLabels.get(`${m[1]}:${m[2]}`)
      return label ? `${titleCase(m[1])} › ${label}` : null
    }

    return reply.send({
      data: visibleRows.map((r) => {
        const uid = String(r.user_id ?? '').toUpperCase()
        return {
          user_id: r.user_id,
          display_name: r.display_name,
          role_name: r.role_name,
          current_path: r.current_path,
          last_seen: r.last_seen,
          // Reported by the client: the heartbeat alone cannot tell a person
          // at their desk from a tab left open. Older rows (written before the
          // column existed, or by a client that does not report it) read as
          // active rather than guessing at idle.
          // The flag is a client's claim; last_active is when it last saw real
          // input. Trusting the flag alone left people idle forever whenever a
          // client wrote presence without reporting it — the row said idle and
          // nothing ever said otherwise. Recent activity wins.
          is_idle: (() => {
            const flag = r.is_idle === true || r.is_idle === 1
            if (!flag) return false
            const active = r.last_active ? new Date(r.last_active as string).getTime() : 0
            if (!active) return true
            return Date.now() - active > IDLE_AFTER_MS
          })(),
          last_active: r.last_active ?? null,
          // Rendered here because only the server can: the panel has neither
          // the display template nor the row.
          page: pageLabel(r.current_path as string | null),
          app: (r.app as string | null) ?? null,
          typing_room: r.typing_room,
          // Flat list for the subtitle line, keyed map for grouping.
          scopes: [...(scopesByUser.get(uid)?.values() ?? [])].flat(),
          scopes_by_dimension: Object.fromEntries(scopesByUser.get(uid) ?? []),
          recording_id: recordingByUser.get(uid) ?? null
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
      await app.redis.del(KEY_PREFIX + sessionId)
      if (app.io) {
        const sessions = await getActiveSessions(app)
        app.io.to('presence:admin').emit('presence:update', { sessions })
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
