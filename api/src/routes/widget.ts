import { randomBytes } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { requireAdmin } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import type { QueueRow } from '../services/queues.js'
import { fetchQueueItems } from '../services/queues.js'
import { type SseEvent, sseEventForTenant, subscribeSse } from '../services/sse-hub.js'
import { currentTenantKey } from '../services/tenant-rooms.js'
import type { User } from '../types.js'
import { canReadQueue } from './queues.js'

// ─── Helpers ──────────────────────────────────────────────────────────────────

const FIELD_NAME_RE = /^[a-zA-Z0-9_]+$/

function parseJson<T>(v: string | null | undefined): T | null {
  if (!v) return null
  try {
    return JSON.parse(v) as T
  } catch {
    return null
  }
}

function toJsonStr(val: unknown): string | null {
  if (val == null) return null
  if (typeof val === 'string') return val
  return JSON.stringify(val)
}

function generateToken(): string {
  return randomBytes(16).toString('hex') // 32 hex chars
}

function formatFeed(row: Record<string, unknown>) {
  return {
    ...row,
    fields: parseJson<string[]>(row.fields as string) ?? [],
    filters: parseJson<Record<string, unknown>>(row.filters as string),
    is_active: !!row.is_active
  }
}

/** Validates collection is registered in nivaro_collections and not a system table. */
async function validateCollection(collection: string): Promise<string | null> {
  if (!collection || collection.startsWith('nivaro_')) {
    return 'collection must be a registered, non-system collection'
  }
  const row = await db('nivaro_collections').where({ collection }).first()
  if (!row) return `collection "${collection}" is not registered`
  return null
}

function validateFields(fields: unknown): string | null {
  if (!Array.isArray(fields) || fields.length === 0) {
    return 'fields must be a non-empty array of field names'
  }
  for (const f of fields) {
    if (typeof f !== 'string' || !FIELD_NAME_RE.test(f)) {
      return `invalid field name: ${String(f)}`
    }
  }
  return null
}

function validateFilters(filters: unknown): string | null {
  if (filters == null) return null
  if (typeof filters !== 'object' || Array.isArray(filters)) {
    return 'filters must be an object of field → value equality pairs'
  }
  for (const key of Object.keys(filters as Record<string, unknown>)) {
    if (!FIELD_NAME_RE.test(key)) return `invalid filter field name: ${key}`
  }
  return null
}

// ─── The embeddable widget script ─────────────────────────────────────────────
// Self-contained vanilla JS IIFE, no dependencies, no iframes. All data-derived
// text is injected via textContent / createElement — never innerHTML.

export function buildWidgetScript(): string {
  return `(function(){
  var sc = document.currentScript || (function(){ var s=document.getElementsByTagName('script'); return s[s.length-1]; })();
  if (!sc) return;
  var mode = sc.getAttribute('data-nivaro-widget');
  var token = sc.getAttribute('data-token');
  if (!mode || !token) return;

  var origin;
  try { origin = new URL(sc.src).origin; } catch (e) { origin = window.location.origin; }
  var theme = sc.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
  var limit = sc.getAttribute('data-limit');
  var titleField = sc.getAttribute('data-title-field');
  var linkTemplate = sc.getAttribute('data-link-template');
  var p = 'nvrw' + Math.random().toString(36).slice(2, 8);

  // ── Mount target ──
  var root;
  var sel = sc.getAttribute('data-target');
  if (sel) { try { root = document.querySelector(sel); } catch (e) { root = null; } }
  if (!root) {
    root = document.createElement('div');
    if (sc.parentNode) sc.parentNode.insertBefore(root, sc.nextSibling);
    else document.body.appendChild(root);
  }
  root.className = (root.className ? root.className + ' ' : '') + p;

  // ── Scoped styles (class prefix — no global pollution) ──
  var dk = theme === 'dark';
  var c = dk
    ? { bg:'#0f172a', fg:'#e2e8f0', mut:'#94a3b8', bd:'#1e293b', ac:'#00ceff', hov:'#1e293b', err:'#f87171', ok:'#4ade80', inbg:'#1e293b' }
    : { bg:'#ffffff', fg:'#0f172a', mut:'#64748b', bd:'#e2e8f0', ac:'#0891b2', hov:'#f8fafc', err:'#dc2626', ok:'#16a34a', inbg:'#ffffff' };
  var css = ''
    + '.'+p+'{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;font-size:14px;line-height:1.5;color:'+c.fg+';background:'+c.bg+';border:1px solid '+c.bd+';border-radius:8px;padding:12px;box-sizing:border-box;max-width:100%}'
    + '.'+p+' *{box-sizing:border-box;margin:0}'
    + '.'+p+'-list{list-style:none;padding:0}'
    + '.'+p+'-item{padding:8px 6px;border-bottom:1px solid '+c.bd+'}'
    + '.'+p+'-item:last-child{border-bottom:0}'
    + '.'+p+'-title{font-weight:600;color:'+c.fg+';text-decoration:none;display:block}'
    + 'a.'+p+'-title:hover{color:'+c.ac+'}'
    + '.'+p+'-sub{font-size:12px;color:'+c.mut+';margin-top:2px}'
    + '.'+p+'-fld{margin-bottom:10px}'
    + '.'+p+'-lbl{display:block;font-size:12px;font-weight:600;margin-bottom:3px;color:'+c.fg+'}'
    + '.'+p+'-in{width:100%;padding:7px 9px;font:inherit;font-size:13px;color:'+c.fg+';background:'+c.inbg+';border:1px solid '+c.bd+';border-radius:6px;outline:none}'
    + '.'+p+'-in:focus{border-color:'+c.ac+'}'
    + '.'+p+'-btn{display:inline-block;padding:8px 16px;font:inherit;font-size:13px;font-weight:600;color:#fff;background:'+c.ac+';border:0;border-radius:6px;cursor:pointer}'
    + '.'+p+'-btn:disabled{opacity:.6;cursor:default}'
    + '.'+p+'-err{font-size:12px;color:'+c.err+';margin-top:6px}'
    + '.'+p+'-ok{font-size:13px;color:'+c.ok+';font-weight:500}'
    + '.'+p+'-mut{font-size:12px;color:'+c.mut+'}'
    + '.'+p+'-hp{position:absolute!important;left:-9999px!important;width:1px;height:1px;overflow:hidden}';
  var st = document.createElement('style');
  st.appendChild(document.createTextNode(css));
  document.head.appendChild(st);

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = String(text); // textContent only — XSS safe
    return e;
  }
  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }
  function fmt(v) {
    if (v == null) return '';
    if (typeof v === 'object') { try { return JSON.stringify(v); } catch (e) { return ''; } }
    return String(v);
  }

  root.appendChild(el('div', p + '-mut', 'Loading\\u2026'));

  // ── LIST MODE ──
  // data-live="true": the server PUSHES a bare "changed" signal (server-sent events) whenever
  // the feed's data is written, and the list re-reads at once. If push is unavailable the list
  // falls back to re-reading every 60 s (or data-refresh).
  // data-refresh="<seconds>" (30–3600) re-reads on a timer instead.
  // Either way the list is swapped only when it changed (no flicker), a failed refresh keeps
  // the last list, and nothing runs while the tab is hidden (a returning visitor catches up).
  if (mode === 'list') {
    var url = origin + '/api/widget/public/feed/' + encodeURIComponent(token);
    if (limit) url += '?limit=' + encodeURIComponent(limit);
    var live = (sc.getAttribute('data-live') || '').toLowerCase();
    live = live !== '' && live !== 'false' && live !== '0' && typeof EventSource !== 'undefined';
    var every = parseInt(sc.getAttribute('data-refresh') || '', 10);
    every = isFinite(every) && every > 0 ? Math.min(Math.max(every, 30), 3600) * 1000 : 0;
    var dirty = false;
    var lastSig = null, lastAt = 0, timer = null, shown = false;
    function render(res) {
      var rows = (res && res.data) || [];
      var flds = (res && res.fields) || [];
      if (!rows.length) return el('div', p + '-mut', 'No items.');
      var tf = titleField && flds.indexOf(titleField) !== -1 ? titleField : flds[0];
      var secondary = [];
      for (var i = 0; i < flds.length && secondary.length < 2; i++) {
        if (flds[i] !== tf && flds[i] !== 'id') secondary.push(flds[i]);
      }
      var ul = el('ul', p + '-list');
      rows.forEach(function (row) {
        var li = el('li', p + '-item');
        var titleText = fmt(row[tf]) || '(untitled)';
        var t;
        if (linkTemplate) {
          t = el('a', p + '-title', titleText);
          var href = linkTemplate.replace(/\\{([a-zA-Z0-9_]+)\\}/g, function (_, k) {
            return encodeURIComponent(fmt(row[k]));
          });
          t.setAttribute('href', href);
          t.setAttribute('target', '_blank');
          t.setAttribute('rel', 'noopener noreferrer');
        } else {
          t = el('div', p + '-title', titleText);
        }
        li.appendChild(t);
        secondary.forEach(function (sf) {
          var v = fmt(row[sf]);
          if (v) li.appendChild(el('div', p + '-sub', v));
        });
        ul.appendChild(li);
      });
      return ul;
    }
    function schedule() {
      if (!every) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(function () {
        timer = null;
        if (document.hidden) return; // resumed by visibilitychange
        load();
      }, every);
    }
    function load() {
      lastAt = Date.now();
      // A refresh revalidates past the browser cache; the first read may use it.
      fetch(url, shown ? { cache: 'no-cache' } : undefined)
        .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
        .then(function (res) {
          var sig;
          try { sig = JSON.stringify([res && res.fields, res && res.data]); } catch (e) { sig = null; }
          if (!shown || sig === null || sig !== lastSig) {
            var node = render(res);
            clear(root);
            root.appendChild(node);
          }
          lastSig = sig;
          shown = true;
        })
        .catch(function () {
          // Keep what is on screen; only a first load with nothing to show says so.
          if (!shown) {
            clear(root);
            root.appendChild(el('div', p + '-err', 'Unable to load content.'));
          }
        })
        .then(schedule);
    }
    function startPolling() {
      if (!every) every = 60000;
      schedule();
    }
    if (live) {
      var es = new EventSource(origin + '/api/widget/public/feed/' + encodeURIComponent(token) + '/stream');
      var opened = false;
      es.addEventListener('changed', function () {
        if (document.hidden) { dirty = true; return; }
        load();
      });
      es.addEventListener('gone', function () { es.close(); });
      es.onopen = function () {
        // A reconnect may have missed signals: catch up once.
        if (opened) load();
        opened = true;
      };
      es.onerror = function () {
        // EventSource retries by itself; a stream the server refused stays CLOSED → poll.
        if (es.readyState === 2 && !timer) startPolling();
      };
    }
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) return;
      if (dirty) { dirty = false; load(); return; }
      if (every && Date.now() - lastAt >= every) load();
      else if (every && !timer) schedule();
    });
    load();
    return;
  }

  // ── FORM MODE ──
  if (mode === 'form') {
    var formUrl = origin + '/api/submission-forms/public/' + encodeURIComponent(token);
    fetch(formUrl)
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (res) {
        clear(root);
        var def = (res && res.data) || {};
        var fields = def.fields || [];
        var form = document.createElement('form');
        form.setAttribute('novalidate', 'novalidate');
        if (def.name) form.appendChild(el('div', p + '-lbl', def.name));

        var inputs = [];
        fields.forEach(function (f) {
          // Supports plain string field names and { field, label, type, options } configs
          var name = typeof f === 'string' ? f : (f && f.field) || '';
          if (!name) return;
          var label = (typeof f === 'object' && f.label) || name;
          var type = (typeof f === 'object' && f.type) || 'text';
          var wrap = el('div', p + '-fld');
          var lb = el('label', p + '-lbl', label);
          wrap.appendChild(lb);
          var input;
          if (type === 'textarea' || type === 'text_long') {
            input = document.createElement('textarea');
            input.rows = 4;
          } else if (type === 'select' && typeof f === 'object' && Array.isArray(f.options)) {
            input = document.createElement('select');
            input.appendChild(el('option', null, ''));
            f.options.forEach(function (o) {
              var val = typeof o === 'object' ? o.value : o;
              var txt = typeof o === 'object' ? (o.label || o.value) : o;
              var op = el('option', null, txt);
              op.value = fmt(val);
              input.appendChild(op);
            });
          } else {
            input = document.createElement('input');
            input.type = type === 'number' || type === 'integer' || type === 'decimal' ? 'number' : 'text';
          }
          input.className = p + '-in';
          input.name = name;
          wrap.appendChild(input);
          var fe = el('div', p + '-err');
          fe.style.display = 'none';
          wrap.appendChild(fe);
          form.appendChild(wrap);
          inputs.push({ name: name, input: input, err: fe });
        });

        var pwInput = null;
        if (def.has_password) {
          var pw = el('div', p + '-fld');
          pw.appendChild(el('label', p + '-lbl', 'Password'));
          pwInput = document.createElement('input');
          pwInput.type = 'password';
          pwInput.className = p + '-in';
          pwInput.name = '_password';
          pw.appendChild(pwInput);
          form.appendChild(pw);
        }

        // Honeypot — hidden from humans, bots fill it
        var hp = document.createElement('input');
        hp.type = 'text';
        hp.name = 'website_url';
        hp.className = p + '-hp';
        hp.tabIndex = -1;
        hp.setAttribute('autocomplete', 'off');
        hp.setAttribute('aria-hidden', 'true');
        form.appendChild(hp);

        var btn = el('button', p + '-btn', 'Submit');
        btn.type = 'submit';
        form.appendChild(btn);
        var msg = el('div', p + '-err');
        msg.style.display = 'none';
        form.appendChild(msg);
        root.appendChild(form);

        form.addEventListener('submit', function (ev) {
          ev.preventDefault();
          msg.style.display = 'none';
          inputs.forEach(function (i) { i.err.style.display = 'none'; });
          if (hp.value) { // bot — pretend success
            clear(root);
            root.appendChild(el('div', p + '-ok', def.success_message || 'Submitted successfully'));
            return;
          }
          var data = {};
          inputs.forEach(function (i) { data[i.name] = i.input.value; });
          var body = { data: data };
          if (pwInput) body.password = pwInput.value;
          btn.disabled = true;
          btn.textContent = 'Submitting\\u2026';
          fetch(formUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          })
            .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, status: r.status, json: j }; }); })
            .then(function (r) {
              if (r.ok) {
                clear(root);
                root.appendChild(el('div', p + '-ok', (r.json && r.json.data && r.json.data.message) || def.success_message || 'Submitted successfully'));
                return;
              }
              btn.disabled = false;
              btn.textContent = 'Submit';
              var errText = (r.json && r.json.error) || 'Submission failed. Please try again.';
              var errs = (r.json && r.json.errors) || null;
              if (errs && typeof errs === 'object') {
                inputs.forEach(function (i) {
                  if (errs[i.name]) { i.err.textContent = fmt(errs[i.name]); i.err.style.display = 'block'; }
                });
              }
              msg.textContent = errText;
              msg.style.display = 'block';
            })
            .catch(function () {
              btn.disabled = false;
              btn.textContent = 'Submit';
              msg.textContent = 'Network error. Please try again.';
              msg.style.display = 'block';
            });
        });
      })
      .catch(function () {
        clear(root);
        root.appendChild(el('div', p + '-err', 'Unable to load form.'));
      });
  }
})();`
}

// ─── Routes ───────────────────────────────────────────────────────────────────

/** The feed's creator while they may still act (active, not redacted); null otherwise. */
export async function activeFeedCreator(createdBy: unknown): Promise<User | null> {
  if (createdBy == null || createdBy === '') return null
  const creator = (await db('nivaro_users')
    .where({ id: String(createdBy) })
    .first()
    .catch(() => null)) as (User & { is_redacted?: boolean | number | null }) | null | undefined
  if (!creator) return null
  if (creator.status && creator.status !== 'active') return null
  if (creator.is_redacted === true || creator.is_redacted === 1) return null
  return creator
}

/** Push stream limits: a wall of embeds on one page shares an IP, an abuser doesn't get more. */
const FEED_STREAM_PER_IP = 20
const FEED_STREAM_HEARTBEAT_MS = 25_000
/** Writes within this window collapse into one "changed" signal. */
const FEED_STREAM_COALESCE_MS = 2_000

/** Collections whose writes can change what a feed shows. */
export async function feedWatchCollections(feed: {
  collection?: string | null
  queue_id?: string | null
}): Promise<Set<string>> {
  if (!feed.queue_id) return new Set(feed.collection ? [String(feed.collection)] : [])
  const rows = (await db('nivaro_queue_sources')
    .where({ queue_id: feed.queue_id })
    .select('collection')) as Array<{ collection: string | null }>
  return new Set(rows.map((r) => r.collection).filter((c): c is string => !!c))
}

/** Whether a token still serves (active feed, creator still able to sign in). */
async function feedStillServes(token: string): Promise<Record<string, unknown> | null> {
  const feed = await db('nivaro_widget_feeds').where({ token }).first()
  if (!feed?.is_active) return null
  const creator = await activeFeedCreator(feed.created_by)
  const legacy = feed.created_by == null && !feed.queue_id
  return creator || legacy ? feed : null
}

export async function widgetRoutes(app: FastifyInstance) {
  // ── GET /widget.js — the embeddable script (no auth, cached 1h) ────────────
  // Lands at /api/widget/widget.js; a root-level alias in routes/index.ts is
  // recommended for cleaner embed URLs (see report).
  app.get('/widget.js', async (_req, reply) => {
    reply
      .header('Content-Type', 'application/javascript; charset=utf-8')
      .header('Cache-Control', 'public, max-age=3600')
    return reply.send(buildWidgetScript())
  })

  // ── GET /public/feed/:token/stream — push "changed" signals (no auth) ──────
  // Server-sent events for embeds with data-live: one bare `changed` event (no ids, no fields,
  // no values — the data still comes only from the feed route) whenever a write lands on a
  // collection the feed reads, coalesced to one per 2 s. The feed is re-checked every heartbeat
  // (deactivated / creator gone → `gone`, then closed). Capped per IP; closed in preClose.
  const feedStreams = new Set<() => void>()
  const streamsByIp = new Map<string, number>()
  app.addHook('preClose', async () => {
    for (const end of [...feedStreams]) end()
  })
  app.get<{ Params: { token: string } }>(
    '/public/feed/:token/stream',
    { compress: false },
    async (req, reply) => {
      const { token } = req.params
      if (!token || !/^[a-f0-9]{32}$/i.test(token)) {
        return reply.code(404).send({ error: 'Feed not found' })
      }
      const feed = await feedStillServes(token)
      if (!feed) return reply.code(404).send({ error: 'Feed not found' })
      const ip = req.ip || 'unknown'
      if ((streamsByIp.get(ip) ?? 0) >= FEED_STREAM_PER_IP) {
        return reply
          .code(429)
          .header('Retry-After', '60')
          .send({ error: 'Too many live feeds from this address' })
      }
      const watch = await feedWatchCollections(feed)
      const tenant = currentTenantKey()

      reply.hijack()
      const raw = reply.raw
      raw.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
        'access-control-allow-origin': '*'
      })
      raw.write('retry: 5000\n: connected\n\n')
      streamsByIp.set(ip, (streamsByIp.get(ip) ?? 0) + 1)

      let closed = false
      let pending: ReturnType<typeof setTimeout> | null = null
      const send = (frame: string) => {
        if (closed) return
        // A slow reader past 64 KB unwritten just misses signals; the next one refetches anyway.
        if ((raw.writableLength ?? 0) > 64 * 1024) return
        try {
          raw.write(frame)
        } catch {
          end()
        }
      }
      const unsubscribe = subscribeSse((ev: SseEvent) => {
        if (closed || pending) return
        if (!sseEventForTenant(ev, tenant) || !watch.has(ev.collection)) return
        pending = setTimeout(() => {
          pending = null
          send('event: changed\ndata: {}\n\n')
        }, FEED_STREAM_COALESCE_MS)
      })
      const heartbeat = setInterval(() => {
        void feedStillServes(token)
          .then((still) => {
            if (closed) return
            if (still) send(': hb\n\n')
            else {
              send('event: gone\ndata: {}\n\n')
              end()
            }
          })
          .catch(() => send(': hb\n\n'))
      }, FEED_STREAM_HEARTBEAT_MS)
      heartbeat.unref()

      function end(): void {
        if (closed) return
        closed = true
        clearInterval(heartbeat)
        if (pending) clearTimeout(pending)
        unsubscribe()
        feedStreams.delete(end)
        const n = (streamsByIp.get(ip) ?? 1) - 1
        if (n > 0) streamsByIp.set(ip, n)
        else streamsByIp.delete(ip)
        try {
          raw.end()
        } catch {
          /* already gone */
        }
      }
      feedStreams.add(end)
      req.raw.on('close', end)
    }
  )

  // ── GET /public/feed/:token — public feed data (no auth) ──────────────────
  app.get<{ Params: { token: string }; Querystring: { limit?: string } }>(
    '/public/feed/:token',
    async (req, reply) => {
      // Permissive CORS on this route only (global CORS already allows *, but
      // these are explicit per the widget contract)
      reply.header('Access-Control-Allow-Origin', '*').header('Cache-Control', 'public, max-age=60')

      const { token } = req.params
      if (!token || !/^[a-f0-9]{32}$/i.test(token)) {
        return reply.code(404).send({ error: 'Feed not found' })
      }

      const feed = await db('nivaro_widget_feeds').where({ token }).first()
      if (!feed?.is_active) return reply.code(404).send({ error: 'Feed not found' })
      // A feed is its creator's curation: it stops when they can no longer
      // sign in (suspended, deactivated, redacted or removed).
      // (A legacy collection feed with no recorded creator keeps serving.)
      const creator = await activeFeedCreator(feed.created_by)
      const legacy = feed.created_by == null && !feed.queue_id
      if (!creator && !legacy) return reply.code(404).send({ error: 'Feed not found' })

      if (feed.queue_id) {
        // Queue-backed feed: resolved using the FEED CREATOR's identity, not
        // the anonymous public viewer's — there is no viewer to check
        // permissions against on a public route. This matches how
        // collection-backed feeds already work: the creator configures the
        // feed once at creation time (canReadQueue gated there), and it is
        // then served identically to every public viewer forever after, with
        // zero per-request RBAC re-check.
        try {
          const stored = Number(feed.limit_count) || 20
          const qLimit = req.query.limit ? Number(req.query.limit) : NaN
          const limit = Math.min(
            100,
            Math.max(1, Number.isFinite(qLimit) && qLimit > 0 ? Math.min(qLimit, stored) : stored)
          )
          // Cap resolution at the small number of rows this public route will
          // actually return, instead of resolving the full QUEUE_SANITY_CEILING
          // (up to 20,000 rows/source) only to discard everything past `limit`.
          const { items } = await fetchQueueItems(feed.queue_id, creator!, 'all', {
            ceiling: limit
          })
          const fields = ['id', 'label', 'state', 'sla_status', 'aging_hours']
          const rows = items.slice(0, limit).map((it) => ({
            id: it.item_id,
            label: it.label,
            state: it.state ?? '',
            sla_status: it.sla_status ?? '',
            aging_hours: it.aging_hours ?? ''
          }))
          return reply.send({ data: rows, fields, total: rows.length })
        } catch (err) {
          app.log.error({ err, feed: feed.id }, 'widget queue feed failed')
          return reply.code(500).send({ error: 'Feed unavailable' })
        }
      }

      const fields = (parseJson<string[]>(feed.fields) ?? []).filter((f) => FIELD_NAME_RE.test(f))
      if (fields.length === 0) return reply.code(404).send({ error: 'Feed not found' })

      const stored = Number(feed.limit_count) || 20
      const qLimit = req.query.limit ? Number(req.query.limit) : NaN
      const limit = Math.min(
        100,
        Math.max(1, Number.isFinite(qLimit) && qLimit > 0 ? Math.min(qLimit, stored) : stored)
      )

      try {
        // SELECT only the whitelisted fields — other columns are never exposed
        let q = db(feed.collection).select(fields).limit(limit)

        const filters = parseJson<Record<string, unknown>>(feed.filters)
        if (filters) {
          for (const [key, value] of Object.entries(filters)) {
            if (FIELD_NAME_RE.test(key)) q = q.where(key, value as string)
          }
        }

        if (feed.sort && typeof feed.sort === 'string') {
          const desc = feed.sort.startsWith('-')
          const sortField = desc ? feed.sort.slice(1) : feed.sort
          if (FIELD_NAME_RE.test(sortField)) {
            q = q.orderBy(sortField, desc ? 'desc' : 'asc')
          }
        }

        const rows = await q
        return reply.send({ data: rows, fields, total: rows.length })
      } catch (err) {
        app.log.error({ err, feed: feed.id }, 'widget feed query failed')
        return reply.code(500).send({ error: 'Feed unavailable' })
      }
    }
  )

  // ── Admin: feed management ─────────────────────────────────────────────────

  // GET / — list all feeds
  app.get('/', { preHandler: requireAdmin }, async (_req, reply) => {
    const rows = await db('nivaro_widget_feeds').orderBy('created_at', 'desc')
    return reply.send({ data: rows.map((r: Record<string, unknown>) => formatFeed(r)) })
  })

  // POST / — create feed (token generated server-side)
  app.post('/', { preHandler: requireAdmin }, async (req, reply) => {
    const body = req.body as {
      name?: string
      collection?: string
      queue_id?: string
      fields?: string[]
      filters?: Record<string, unknown> | null
      limit_count?: number
      sort?: string | null
      is_active?: boolean
    }

    if (!body.name?.trim()) return reply.code(400).send({ error: 'name is required' })

    const hasCollection = !!body.collection?.trim()
    const hasQueue = !!body.queue_id?.trim()
    if (hasCollection === hasQueue) {
      return reply.code(400).send({ error: 'exactly one of collection or queue_id is required' })
    }

    let collection = ''
    if (hasCollection) {
      collection = body.collection?.trim() ?? ''
      const colErr = await validateCollection(collection)
      if (colErr) return reply.code(400).send({ error: colErr })

      const fieldsErr = validateFields(body.fields)
      if (fieldsErr) return reply.code(400).send({ error: fieldsErr })

      const filtersErr = validateFilters(body.filters)
      if (filtersErr) return reply.code(400).send({ error: filtersErr })
    } else {
      const queue = await db('nivaro_queues').where({ id: body.queue_id }).first()
      if (!queue) return reply.code(404).send({ error: 'Queue not found' })
      if (!canReadQueue(queue as QueueRow, req)) {
        return reply.code(403).send({ error: 'Forbidden' })
      }
    }

    const token = generateToken()
    const [inserted] = await db('nivaro_widget_feeds')
      .insert({
        name: body.name.trim(),
        token,
        collection: hasCollection ? collection : null,
        queue_id: hasQueue ? body.queue_id : null,
        fields: hasCollection ? toJsonStr(body.fields) : null,
        filters: hasCollection && body.filters != null ? toJsonStr(body.filters) : null,
        limit_count: Math.min(100, Math.max(1, Number(body.limit_count) || 20)),
        sort: hasCollection ? body.sort?.trim() || null : null,
        is_active: body.is_active !== false ? 1 : 0,
        created_by: req.user?.id,
        created_at: new Date()
      })
      .returning('id')
    const id = typeof inserted === 'object' ? (inserted as { id: number }).id : inserted

    const row = await db('nivaro_widget_feeds').where({ id }).first()

    await logActivity({
      action: 'create',
      collection: 'nivaro_widget_feeds',
      item: String(id),
      user: req.user?.id,
      req
    })

    return reply.code(201).send({ data: formatFeed(row as Record<string, unknown>) })
  })

  // PATCH /:id — update feed
  app.patch<{ Params: { id: string } }>(
    '/:id',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const { id } = req.params
      const existing = await db('nivaro_widget_feeds').where({ id }).first()
      if (!existing) return reply.code(404).send({ error: 'Not found' })

      const body = req.body as {
        name?: string
        collection?: string
        fields?: string[]
        filters?: Record<string, unknown> | null
        limit_count?: number
        sort?: string | null
        is_active?: boolean
      }

      // queue_id is immutable post-creation (not accepted here at all) — a
      // queue-backed feed can never be converted into a collection-backed
      // one (or vice versa) via PATCH, keeping the "exactly one of
      // collection/queue_id" invariant enforced at creation intact.
      if (
        existing.queue_id &&
        (body.collection !== undefined || body.fields !== undefined || body.filters !== undefined)
      ) {
        return reply
          .code(400)
          .send({ error: 'collection, fields, and filters cannot be set on a queue-backed feed' })
      }

      const patch: Record<string, unknown> = {}
      if (body.name !== undefined) {
        if (!body.name.trim()) return reply.code(400).send({ error: 'name cannot be empty' })
        patch.name = body.name.trim()
      }
      if (body.collection !== undefined) {
        const collection = body.collection.trim()
        const colErr = await validateCollection(collection)
        if (colErr) return reply.code(400).send({ error: colErr })
        patch.collection = collection
      }
      if (body.fields !== undefined) {
        const fieldsErr = validateFields(body.fields)
        if (fieldsErr) return reply.code(400).send({ error: fieldsErr })
        patch.fields = toJsonStr(body.fields)
      }
      if (body.filters !== undefined) {
        const filtersErr = validateFilters(body.filters)
        if (filtersErr) return reply.code(400).send({ error: filtersErr })
        patch.filters = body.filters != null ? toJsonStr(body.filters) : null
      }
      if (body.limit_count !== undefined) {
        patch.limit_count = Math.min(100, Math.max(1, Number(body.limit_count) || 20))
      }
      if (body.sort !== undefined) patch.sort = body.sort?.trim() || null
      if (body.is_active !== undefined) patch.is_active = body.is_active ? 1 : 0

      if (Object.keys(patch).length > 0) {
        await db('nivaro_widget_feeds').where({ id }).update(patch)
      }
      const updated = await db('nivaro_widget_feeds').where({ id }).first()

      await logActivity({
        action: 'update',
        collection: 'nivaro_widget_feeds',
        item: String(id),
        user: req.user?.id,
        req
      })

      return reply.send({ data: formatFeed(updated as Record<string, unknown>) })
    }
  )

  // DELETE /:id — delete feed
  app.delete<{ Params: { id: string } }>(
    '/:id',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const { id } = req.params
      const existing = await db('nivaro_widget_feeds').where({ id }).first()
      if (!existing) return reply.code(404).send({ error: 'Not found' })

      await db('nivaro_widget_feeds').where({ id }).delete()

      await logActivity({
        action: 'delete',
        collection: 'nivaro_widget_feeds',
        item: String(id),
        user: req.user?.id,
        req
      })

      return reply.code(204).send()
    }
  )

  // POST /:id/rotate-token — invalidate old token, issue a new one
  app.post<{ Params: { id: string } }>(
    '/:id/rotate-token',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const { id } = req.params
      const existing = await db('nivaro_widget_feeds').where({ id }).first()
      if (!existing) return reply.code(404).send({ error: 'Not found' })

      const token = generateToken()
      await db('nivaro_widget_feeds').where({ id }).update({ token })
      const updated = await db('nivaro_widget_feeds').where({ id }).first()

      await logActivity({
        action: 'update',
        collection: 'nivaro_widget_feeds',
        item: String(id),
        user: req.user?.id,
        req
      })

      return reply.send({ data: formatFeed(updated as Record<string, unknown>) })
    }
  )
}
