import { randomBytes } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { requireAdmin } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'

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
  if (mode === 'list') {
    var url = origin + '/api/widget/public/feed/' + encodeURIComponent(token);
    if (limit) url += '?limit=' + encodeURIComponent(limit);
    fetch(url)
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (res) {
        clear(root);
        var rows = (res && res.data) || [];
        var flds = (res && res.fields) || [];
        if (!rows.length) { root.appendChild(el('div', p + '-mut', 'No items.')); return; }
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
        root.appendChild(ul);
      })
      .catch(function () {
        clear(root);
        root.appendChild(el('div', p + '-err', 'Unable to load content.'));
      });
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
      fields?: string[]
      filters?: Record<string, unknown> | null
      limit_count?: number
      sort?: string | null
      is_active?: boolean
    }

    if (!body.name?.trim()) return reply.code(400).send({ error: 'name is required' })

    const collection = body.collection?.trim() ?? ''
    const colErr = await validateCollection(collection)
    if (colErr) return reply.code(400).send({ error: colErr })

    const fieldsErr = validateFields(body.fields)
    if (fieldsErr) return reply.code(400).send({ error: fieldsErr })

    const filtersErr = validateFilters(body.filters)
    if (filtersErr) return reply.code(400).send({ error: filtersErr })

    const token = generateToken()
    const [inserted] = await db('nivaro_widget_feeds')
      .insert({
        name: body.name.trim(),
        token,
        collection,
        fields: toJsonStr(body.fields),
        filters: body.filters != null ? toJsonStr(body.filters) : null,
        limit_count: Math.min(100, Math.max(1, Number(body.limit_count) || 20)),
        sort: body.sort?.trim() || null,
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
