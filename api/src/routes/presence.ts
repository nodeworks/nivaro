import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { requireAdmin, requireAuth } from '../middleware/authenticate.js'

const KEY_PREFIX = 'presence:session:'

// Defaults used when DB columns are null/missing
const DEFAULT_SESSION_TTL = 20
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
