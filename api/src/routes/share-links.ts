import { createHash, randomBytes, randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { requireAuth } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import { CC_KIOSK_ITEM, isKioskItem } from '../services/command-center/kiosk.js'
import { loadFormLayout } from '../services/form-layout.js'
import { readOne } from '../services/items.js'
import { FORM_PREVIEW_ITEM } from '../services/layout-preview.js'
import { can } from '../services/permissions.js'
import { SignalStreamRoute, sharedSignature } from '../services/public-signal-stream.js'
import { currentTenantKey } from '../services/tenant-rooms.js'
import { takeBudget } from '../services/widget-live.js'
import type { User } from '../types.js'

/**
 * Record share links — "send the vendor this PO's status": an expiring
 * token URL rendering ONE record read-only through a grouped layout.
 * The creator decides whom they hand the link to, but never what it may show
 * beyond their own access: a link can only be made for (and listed on) a
 * record the creator can read, and the public page reads the record AS THE
 * CREATOR, field allow-list included — a suspended creator's links stop.
 *
 * Form preview links (#2666) share this table under item FORM_PREVIEW_ITEM; they are made,
 * listed and revoked only through /layout-collab (admin), so every route here refuses them.
 * Command Center wallboard links (CC-23) live here too under item CC_KIOSK_ITEM, managed only
 * through /command-center/kiosk-links (admin): every route here refuses them the same way.
 */

// SQL Server compares item case-insensitively and ignores trailing spaces, so
// '__FORM_PREVIEW__ ' finds the preview rows: compare the way the database does. The queries
// below also exclude the preview item themselves (the collation covers the variants).
export const isPreviewItem = (item: unknown) =>
  String(item ?? '')
    .trim()
    .toLowerCase() === FORM_PREVIEW_ITEM

/** An item marker this table reserves for another feature (form previews, wallboard links). */
export const isReservedItem = (item: unknown) => isPreviewItem(item) || isKioskItem(item)

function esc(v: unknown): string {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

/** The record as `user` reads it (User Scopes, row filter, field allow-list), or null. */
async function readAs(
  user: User,
  collection: string,
  item: string,
  workspaceId?: string | null
): Promise<Record<string, unknown> | null> {
  try {
    return ((await readOne(user, collection, item, workspaceId ?? undefined)) ?? null) as Record<
      string,
      unknown
    > | null
  } catch {
    return null
  }
}

function formatValue(dbType: string, v: unknown): string {
  if (v == null || v === '') return '—'
  if (typeof v === 'boolean') return v ? 'Yes' : 'No'
  if (dbType === 'boolean') return v === 1 || v === true || v === 'true' ? 'Yes' : 'No'
  if (v instanceof Date) return v.toLocaleString('en-US')
  if (
    (dbType === 'date' || dbType === 'datetime' || dbType === 'timestamp') &&
    typeof v === 'string'
  ) {
    const d = new Date(v)
    if (!Number.isNaN(d.getTime()))
      return dbType === 'date' ? d.toLocaleDateString('en-US') : d.toLocaleString('en-US')
  }
  return String(v)
}

export async function shareLinksRoutes(app: FastifyInstance) {
  // ── Authenticated management ────────────────────────────────────────────
  app.post('/', { preHandler: requireAuth }, async (req, reply) => {
    const b = req.body as {
      collection?: string
      item?: string | number
      layout_id?: number | null
      expires_in_days?: number | null
    }
    if (!b.collection || b.item == null) {
      return reply.code(400).send({ error: 'collection and item are required' })
    }
    if (isReservedItem(b.item)) {
      return reply.code(400).send({ error: 'That record cannot be shared' })
    }
    if (b.collection.startsWith('nivaro_')) {
      return reply.code(400).send({ error: 'System collections cannot be shared' })
    }
    if (!req.isAdmin && !(await can(req.user!, 'read', b.collection))) {
      return reply.code(403).send({ error: 'Forbidden' })
    }
    // Only a record the creator can see — a hidden id answers like a missing one.
    if (!(await readAs(req.user!, b.collection, String(b.item), req.workspaceId))) {
      return reply.code(404).send({ error: 'Record not found' })
    }
    if (b.layout_id != null) {
      const layout = await db('nivaro_collection_layouts').where({ id: b.layout_id }).first()
      if (!layout || layout.collection !== b.collection) {
        return reply.code(400).send({ error: 'That layout does not belong to this collection' })
      }
    }
    const id = randomUUID()
    const token = randomBytes(24).toString('hex')
    const expiresAt =
      b.expires_in_days && b.expires_in_days > 0
        ? new Date(Date.now() + b.expires_in_days * 86_400_000)
        : null
    await db('nivaro_share_links').insert({
      id,
      collection: b.collection,
      item: String(b.item),
      token,
      layout_id: b.layout_id ?? null,
      expires_at: expiresAt,
      is_active: 1,
      created_by: req.user?.id ?? null,
      created_at: new Date()
    })
    await logActivity({
      action: 'share-link-create',
      collection: b.collection,
      item: String(b.item),
      user: req.user?.id,
      req
    })
    const row = await db('nivaro_share_links').where({ id }).first()
    return reply.code(201).send({ data: { ...row, url: `/share/${token}` } })
  })

  app.get('/for/:collection/:item', { preHandler: requireAuth }, async (req, reply) => {
    const { collection, item } = req.params as { collection: string; item: string }
    if (isReservedItem(item)) return reply.code(404).send({ error: 'Not found' })
    if (!req.isAdmin && !(await can(req.user!, 'read', collection))) {
      return reply.code(403).send({ error: 'Forbidden' })
    }
    if (!req.isAdmin && !(await readAs(req.user!, collection, item, req.workspaceId))) {
      return reply.code(404).send({ error: 'Not found' })
    }
    // A token is a credential: people see their own links, admins every link.
    const q = db('nivaro_share_links')
      .where({ collection, item })
      .whereNot('item', FORM_PREVIEW_ITEM)
      .whereNot('item', CC_KIOSK_ITEM)
    if (!req.isAdmin) void q.where({ created_by: req.user!.id })
    const rows = await q.orderBy('created_at', 'desc')
    return reply.send({
      data: rows.map((r: Record<string, unknown>) => ({
        ...r,
        is_active: !!r.is_active,
        url: `/share/${String(r.token)}`
      }))
    })
  })

  app.delete('/:id', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const row = await db('nivaro_share_links').where({ id }).first()
    if (!row || isReservedItem(row.item)) return reply.code(404).send({ error: 'Not found' })
    if (!req.isAdmin && row.created_by !== req.user?.id) {
      return reply.code(403).send({ error: 'Only the creator can revoke this link' })
    }
    await db('nivaro_share_links').where({ id }).delete()
    await logActivity({
      action: 'share-link-revoke',
      collection: String(row.collection),
      item: String(row.item),
      user: req.user?.id,
      req
    })
    return reply.code(204).send()
  })
}

// ── Public renderer — registered WITHOUT the /api prefix ───────────────────

type SharePage =
  | { ok: false; title: string; msg: string }
  | {
      ok: true
      link: Record<string, unknown>
      collection: string
      title: string
      /** The record part of the page (what changes when the record does). */
      body: string
    }

/** A live share link's row, or null (unknown, revoked, reserved for another feature, expired). */
async function liveShareLink(token: string): Promise<Record<string, unknown> | null> {
  const link = (await db('nivaro_share_links')
    .where({ token })
    .whereNot('item', FORM_PREVIEW_ITEM)
    .whereNot('item', CC_KIOSK_ITEM)
    .first()
    .catch(() => null)) as Record<string, unknown> | null | undefined
  if (!link?.is_active || isReservedItem(link.item)) return null
  if (link.expires_at && new Date(link.expires_at as string) < new Date()) return null
  return link
}

/** Everything the page shows, read as the link's creator — the one place the page is built. */
async function buildSharePage(token: string): Promise<SharePage> {
  const raw = (await db('nivaro_share_links')
    .where({ token })
    .whereNot('item', FORM_PREVIEW_ITEM)
    .whereNot('item', CC_KIOSK_ITEM)
    .first()
    .catch(() => null)) as Record<string, unknown> | null | undefined
  if (!raw?.is_active || isReservedItem(raw.item))
    return {
      ok: false,
      title: 'Link not found',
      msg: 'This share link does not exist or was revoked.'
    }
  if (raw.expires_at && new Date(raw.expires_at as string) < new Date())
    return { ok: false, title: 'Link expired', msg: 'This share link is no longer available.' }
  const link = raw

  const collection = String(link.collection)
  let layoutId = link.layout_id ? Number(link.layout_id) : null
  if (!layoutId) {
    const active = await db('nivaro_collection_layouts')
      .where({ collection, is_active: 1 })
      .where((qb) => qb.where('layout_type', 'grouped').orWhereNull('layout_type'))
      .first()
    layoutId = active ? Number(active.id) : null
  }
  const layout = layoutId
    ? await loadFormLayout(layoutId, collection, { includeReadonly: true })
    : null

  // Read as the creator: the page never shows more than they could see now.
  const creator = link.created_by
    ? ((await db('nivaro_users')
        .where({ id: link.created_by })
        .first()
        .catch(() => null)) as User | null)
    : null
  if (creator?.status !== 'active') {
    return {
      ok: false,
      title: 'Link not found',
      msg: 'This share link does not exist or was revoked.'
    }
  }
  const record = await readAs(creator, collection, String(link.item))
  if (!record)
    return { ok: false, title: 'Record unavailable', msg: 'The shared record no longer exists.' }

  const colMeta = await db('nivaro_collections').where({ collection }).first()
  const title = String(colMeta?.display_name ?? collection)

  // No layout → nothing curated to show; refuse rather than dump raw columns
  if (!layout) {
    return {
      ok: false,
      title: 'Not shareable',
      msg: 'No layout is configured for this record type.'
    }
  }

  const body = layout.sections
    .map((sec) => {
      const rows = sec.fields
        // Fields outside the creator's read allow-list are not in the record.
        .filter((f) => Object.hasOwn(record, f.path))
        .map((f) => {
          const choice = f.choices?.find((c) => String(c.value) === String(record[f.path]))
          const val = choice ? choice.text : formatValue(f.db_type, record[f.path])
          return `<div class="row" data-k="${esc(f.path)}"><div class="k">${esc(f.label)}</div><div class="v">${esc(val)}</div></div>`
        })
        .join('')
      return `<section>${sec.label ? `<h2>${esc(sec.label)}</h2>` : ''}${rows}</section>`
    })
    .join('')
  return { ok: true, link, collection, title, body }
}

/**
 * The page's live script (nonce'd): listen on /share/:token/stream for a bare `changed`, refetch
 * the page through the share route itself (`?refresh=1`: not counted as a view), and swap the
 * changed values in place with a short fade — same rows keep their place, nothing scrolls. A
 * hidden tab waits until it is shown; `gone` reloads into the page's own "not found" answer.
 */
const LIVE_SCRIPT = `(function(){
if(!window.EventSource||!window.fetch||!window.DOMParser)return;
var base=location.pathname.replace(/\\/+$/,'');var busy=false,again=false,owed=false;
function swap(t){var doc=new DOMParser().parseFromString(t,'text/html');var next=doc.getElementById('nvr-share-body');var cur=document.getElementById('nvr-share-body');if(!next||!cur)return;
var a=cur.querySelectorAll('.row'),b=next.querySelectorAll('.row');var same=a.length===b.length;
for(var i=0;same&&i<a.length;i++){if(a[i].getAttribute('data-k')!==b[i].getAttribute('data-k'))same=false}
if(!same){cur.replaceWith(next);return}
for(var j=0;j<a.length;j++){var v=a[j].querySelector('.v'),w=b[j].querySelector('.v');if(v&&w&&v.textContent!==w.textContent){v.textContent=w.textContent;a[j].classList.remove('chg');void a[j].offsetWidth;a[j].classList.add('chg')}}}
function refresh(){if(document.hidden){owed=true;return}if(busy){again=true;return}busy=true;
fetch(base+'?refresh=1',{credentials:'omit',cache:'no-store'}).then(function(r){if(r.status===404){location.reload();return null}return r.ok?r.text():null}).then(function(t){if(t)swap(t)}).catch(function(){}).then(function(){busy=false;if(again){again=false;refresh()}})}
document.addEventListener('visibilitychange',function(){if(!document.hidden&&owed){owed=false;refresh()}});
var es=new EventSource(base+'/stream');es.addEventListener('changed',refresh);es.addEventListener('gone',function(){es.close();location.reload()});
})();`

function sharePageHtml(page: Extract<SharePage, { ok: true }>, nonce: string): string {
  const { link, title, body } = page
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">
<meta name="color-scheme" content="light dark">
<title>${esc(title)}</title><style>
*{box-sizing:border-box;margin:0;padding:0}
:root{--bg:#f8fafc;--card:#fff;--fg:#0f172a;--muted:#64748b;--line:#e2e8f0;--line2:#f1f5f9;--h2:#334155;--foot:#94a3b8;--chg:rgba(0,206,255,.16)}
@media (prefers-color-scheme:dark){:root{--bg:#0b1120;--card:#111827;--fg:#e2e8f0;--muted:#94a3b8;--line:#1f2937;--line2:#1a2332;--h2:#cbd5e1;--foot:#64748b;--chg:rgba(0,206,255,.18)}}
body{font-family:-apple-system,'Segoe UI',Roboto,sans-serif;font-size:14px;color:var(--fg);background:var(--bg);padding:32px 16px;line-height:1.5}
.wrap{max-width:640px;margin:0 auto;background:var(--card);border:1px solid var(--line);border-radius:12px;padding:32px}
@media (max-width:480px){.wrap{padding:20px 16px}.row{flex-direction:column;gap:2px}.k{width:auto}}
h1{font-size:19px;letter-spacing:-.01em}
.meta{color:var(--muted);font-size:12px;margin:4px 0 20px}
h2{font-size:13px;margin:22px 0 8px;padding-bottom:6px;border-bottom:1px solid var(--line);color:var(--h2)}
.row{display:flex;gap:16px;padding:6px 0;border-bottom:1px solid var(--line2)}
.k{width:38%;color:var(--muted);font-size:12px;padding-top:1px}
.v{flex:1;font-size:13px;word-break:break-word}
.row.chg .v{animation:nvrchg 1.6s ease-out}
@keyframes nvrchg{from{background:var(--chg)}to{background:transparent}}
@media (prefers-reduced-motion:reduce){.row.chg .v{animation:none}}
.foot{margin-top:24px;text-align:center;color:var(--foot);font-size:11px}
</style></head><body><div class="wrap">
<h1>${esc(title)} · Record ${esc(link.item)}</h1>
<p class="meta">Read-only shared view${link.expires_at ? ` · expires ${new Date(link.expires_at as string).toLocaleDateString('en-US')}` : ''}</p>
<div id="nvr-share-body">${body}</div>
<p class="foot">Shared via Nivaro</p>
</div><script nonce="${nonce}">${LIVE_SCRIPT}</script></body></html>`
}

/** The page's policy: its own inline style, its nonce'd live script, reads of its own origin. */
export function shareCsp(nonce: string): string {
  return [
    "default-src 'none'",
    "style-src 'unsafe-inline'",
    `script-src 'nonce-${nonce}'`,
    "connect-src 'self'",
    "frame-ancestors 'self'",
    "base-uri 'none'",
    "form-action 'none'"
  ].join('; ')
}

const SHARE_STREAM_PER_IP = 20
const SHARE_STREAM_HEARTBEAT_MS = 25_000
const SHARE_STREAM_COALESCE_MS = 1_000
const shareSigs = new Map<string, { at: number; sig: Promise<string | null> }>()

/** Fingerprint of the record part of the page, shared per token for a moment, budgeted. */
function shareSignature(token: string): Promise<string | null> {
  const tenant = currentTenantKey()
  return sharedSignature(
    shareSigs,
    `${tenant}|${token}`,
    async () => {
      const page = await buildSharePage(token)
      return page.ok ? createHash('sha256').update(page.body).digest('hex') : 'gone'
    },
    { budget: () => takeBudget(tenant) }
  )
}

export async function sharePublicRoutes(app: FastifyInstance) {
  // ── GET /share/:token/stream — live "changed" signal for an open share page ─
  // Token-scoped: only writes to THIS link's record prompt a check, the page's own answer (read
  // as the creator) must actually change, and the event carries nothing — the page refetches
  // through /share/:token. Mechanics shared with embed feeds (services/public-signal-stream.ts).
  const streams = new SignalStreamRoute()
  app.addHook('preClose', async () => {
    streams.closeAll()
  })
  app.get<{ Params: { token: string } }>(
    '/share/:token/stream',
    { compress: false },
    async (req, reply) => {
      const { token } = req.params
      if (!token || token.length > 128) return reply.code(404).send({ error: 'Not found' })
      await streams.serve(req, reply, {
        perIp: SHARE_STREAM_PER_IP,
        heartbeatMs: SHARE_STREAM_HEARTBEAT_MS,
        coalesceMs: SHARE_STREAM_COALESCE_MS,
        async open() {
          const link = await liveShareLink(token)
          if (!link) return { ok: false, code: 404, body: { error: 'Not found' } }
          const collection = String(link.collection)
          const item = String(link.item).toLowerCase()
          return {
            ok: true,
            subject: {
              watches: (ev) =>
                ev.collection === collection &&
                (ev.item === '*' || String(ev.item).toLowerCase() === item),
              signature: () => shareSignature(token),
              stillServes: async () => !!(await liveShareLink(token))
            }
          }
        }
      })
    }
  )

  app.get<{ Params: { token: string }; Querystring: { refresh?: string } }>(
    '/share/:token',
    async (req, reply) => {
      const page = await buildSharePage(req.params.token)
      if (!page.ok) {
        return reply
          .code(404)
          .type('text/html')
          .send(
            `<!doctype html><html><body style="font-family:sans-serif;padding:60px;text-align:center;color:#334155"><h2>${esc(page.title)}</h2><p>${esc(page.msg)}</p></body></html>`
          )
      }
      // A live refresh of an open page is not a new view.
      if (req.query.refresh !== '1') {
        db('nivaro_share_links')
          .where({ id: page.link.id })
          .update({ view_count: db.raw('view_count + 1'), last_viewed_at: new Date() })
          .catch(() => {})
      }
      const nonce = randomBytes(16).toString('base64')
      return reply
        .type('text/html')
        .header('Cache-Control', 'no-store')
        .header('Content-Security-Policy', shareCsp(nonce))
        .send(sharePageHtml(page, nonce))
    }
  )
}
