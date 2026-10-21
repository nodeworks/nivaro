import { randomBytes, randomUUID } from 'node:crypto'
import { db } from '../db/index.js'
import type { FormLayoutStructure } from './form-layout.js'

/**
 * Shareable form preview (#2666): a read-only, expiring link to a form for business people
 * who are not administrators. They read the form's structure (sections, fields, choices —
 * never record data) and pin comments to fields; the comments show in the layout editor.
 *
 * No migration (DB freeze): a link is a nivaro_share_links row whose item is
 * FORM_PREVIEW_ITEM and whose layout_id names the form (the record share renderer never
 * finds a record by that item, so the token is useless there); comments are
 * nivaro_extension_settings rows ('nivaro-core', 'layout_preview_comment:<layout>:<id>').
 * The form renders as the link's creator would see it: only fields the creator may read.
 */

export const FORM_PREVIEW_ITEM = '__form_preview__'
const CORE_EXT = 'nivaro-core'
const COMMENT_PREFIX = 'layout_preview_comment:'
export const MAX_COMMENTS_PER_LAYOUT = 300
export const MAX_PREVIEW_DAYS = 90

export interface PreviewLink {
  id: string
  token: string
  layout_id: number
  collection: string
  expires_at: string | null
  view_count: number
  created_by: string | null
  created_at: string | null
}

export interface PreviewComment {
  id: string
  layout_id: number
  link_id: string
  field: string | null
  name: string
  text: string
  at: string
}

const iso = (v: unknown) => (v == null ? null : new Date(v as string).toISOString())

function toLink(r: Record<string, unknown>): PreviewLink {
  return {
    id: String(r.id),
    token: String(r.token),
    layout_id: Number(r.layout_id),
    collection: String(r.collection),
    expires_at: iso(r.expires_at),
    view_count: Number(r.view_count ?? 0),
    created_by: r.created_by == null ? null : String(r.created_by),
    created_at: iso(r.created_at)
  }
}

export async function createPreviewLink(input: {
  layoutId: number
  collection: string
  days: number
  userId: string
}): Promise<PreviewLink> {
  const days = Math.min(MAX_PREVIEW_DAYS, Math.max(1, Math.round(input.days)))
  const id = randomUUID()
  await db('nivaro_share_links').insert({
    id,
    collection: input.collection,
    item: FORM_PREVIEW_ITEM,
    token: randomBytes(24).toString('hex'),
    layout_id: input.layoutId,
    expires_at: new Date(Date.now() + days * 86_400_000),
    is_active: 1,
    view_count: 0,
    created_by: input.userId,
    created_at: new Date()
  })
  const row = (await db('nivaro_share_links').where({ id }).first()) as Record<string, unknown>
  return toLink(row)
}

export async function listPreviewLinks(layoutId: number): Promise<PreviewLink[]> {
  const rows = (await db('nivaro_share_links')
    .where({ item: FORM_PREVIEW_ITEM, layout_id: layoutId, is_active: 1 })
    .orderBy('created_at', 'desc')) as Array<Record<string, unknown>>
  return rows.map(toLink)
}

export async function revokePreviewLink(linkId: string): Promise<boolean> {
  const n = await db('nivaro_share_links').where({ id: linkId, item: FORM_PREVIEW_ITEM }).delete()
  return Number(n) > 0
}

/** A live link by token: active, with an expiry still ahead. null otherwise (a preview link
 *  without an expiry was not made by createPreviewLink, so it never works). */
export async function previewLinkByToken(token: string): Promise<PreviewLink | null> {
  if (!/^[0-9a-f]{16,64}$/i.test(token)) return null
  const row = (await db('nivaro_share_links')
    .where({ token, item: FORM_PREVIEW_ITEM })
    .first()
    .catch(() => null)) as Record<string, unknown> | null | undefined
  if (!row?.is_active || row.layout_id == null) return null
  if (row.expires_at == null) return null
  const expires = new Date(row.expires_at as string).getTime()
  if (!Number.isFinite(expires) || expires < Date.now()) return null
  return toLink(row)
}

export function countPreviewView(linkId: string): void {
  void db('nivaro_share_links')
    .where({ id: linkId })
    .update({ view_count: db.raw('view_count + 1'), last_viewed_at: new Date() })
    .catch(() => undefined)
}

// ─── Comments ────────────────────────────────────────────────────────────────

/** Validated comment input, or the reason it is refused. */
export function cleanComment(
  body: unknown,
  fieldPaths: string[]
): { field: string | null; name: string; text: string } | { error: string } {
  const b = (body ?? {}) as { field?: unknown; name?: unknown; text?: unknown }
  const text = typeof b.text === 'string' ? b.text.trim() : ''
  const name = typeof b.name === 'string' ? b.name.trim() : ''
  if (!text) return { error: 'Write a comment first' }
  if (text.length > 2000) return { error: 'Comments are limited to 2000 characters' }
  if (!name) return { error: 'Add your name so the form’s designer knows who wrote this' }
  if (name.length > 80) return { error: 'Names are limited to 80 characters' }
  const field = typeof b.field === 'string' && b.field ? b.field : null
  if (field && !fieldPaths.includes(field)) return { error: 'That field is not on this form' }
  return { field, name, text }
}

function parseComment(key: string, value: string | null): PreviewComment | null {
  const m = key.slice(COMMENT_PREFIX.length).match(/^(\d+):([0-9a-f]+)$/)
  if (!m || !value) return null
  try {
    const v = JSON.parse(value) as Partial<PreviewComment>
    return {
      id: m[2],
      layout_id: Number(m[1]),
      link_id: String(v.link_id ?? ''),
      field: v.field ? String(v.field) : null,
      name: String(v.name ?? ''),
      text: String(v.text ?? ''),
      at: String(v.at ?? '')
    }
  } catch {
    return null
  }
}

export async function listPreviewComments(
  layoutId: number,
  linkId?: string
): Promise<PreviewComment[]> {
  const rows = (await db('nivaro_extension_settings')
    .where({ extension_id: CORE_EXT })
    .where('key', 'like', `${COMMENT_PREFIX}${layoutId}:%`)
    .select('key', 'value')) as Array<{ key: string; value: string | null }>
  return rows
    .map((r) => parseComment(r.key, r.value))
    .filter((c): c is PreviewComment => !!c && (!linkId || c.link_id === linkId))
    .sort((a, b) => a.at.localeCompare(b.at))
}

export async function addPreviewComment(
  link: PreviewLink,
  c: { field: string | null; name: string; text: string }
): Promise<PreviewComment | { error: string }> {
  const existing = await listPreviewComments(link.layout_id)
  if (existing.length >= MAX_COMMENTS_PER_LAYOUT)
    return { error: 'This form has collected as many comments as it can hold' }
  const id = randomBytes(6).toString('hex')
  const at = new Date().toISOString()
  await db('nivaro_extension_settings').insert({
    extension_id: CORE_EXT,
    key: `${COMMENT_PREFIX}${link.layout_id}:${id}`,
    value: JSON.stringify({ link_id: link.id, field: c.field, name: c.name, text: c.text, at }),
    updated_at: new Date()
  })
  return { id, layout_id: link.layout_id, link_id: link.id, ...c, at }
}

export async function deletePreviewComment(layoutId: number, commentId: string): Promise<boolean> {
  if (!/^[0-9a-f]{1,32}$/.test(commentId)) return false
  const n = await db('nivaro_extension_settings')
    .where({ extension_id: CORE_EXT, key: `${COMMENT_PREFIX}${layoutId}:${commentId}` })
    .delete()
  return Number(n) > 0
}

// ─── Page ────────────────────────────────────────────────────────────────────

const esc = (v: unknown) =>
  String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')

const TYPE_WORDS: Record<string, string> = {
  string: 'Text',
  text: 'Long text',
  integer: 'Whole number',
  bigInteger: 'Whole number',
  float: 'Number',
  decimal: 'Number',
  boolean: 'Yes / No',
  date: 'Date',
  dateTime: 'Date and time',
  datetime: 'Date and time',
  timestamp: 'Date and time',
  time: 'Time',
  json: 'List',
  uuid: 'Link'
}

/** The preview page: the form's sections and fields, read-only, with a comment box per field. */
export function renderFormPreviewHtml(input: {
  title: string
  layoutName: string
  structure: FormLayoutStructure
  comments: PreviewComment[]
  token: string
  expiresAt: string | null
  /** CSP nonce for the page's one inline script. */
  nonce?: string
}): string {
  const byField = new Map<string, PreviewComment[]>()
  for (const c of input.comments) {
    const k = c.field ?? ''
    byField.set(k, [...(byField.get(k) ?? []), c])
  }
  const thread = (field: string) =>
    (byField.get(field) ?? [])
      .map(
        (c) =>
          `<li><b>${esc(c.name)}</b> <span class="when">${esc(new Date(c.at).toLocaleDateString('en-US'))}</span><div>${esc(c.text)}</div></li>`
      )
      .join('')
  const box = (field: string, label: string) =>
    `<div class="cm" data-field="${esc(field)}"><ul>${thread(field)}</ul><button type="button" class="add" aria-label="Comment on ${esc(label)}">Comment</button></div>`

  const sections = input.structure.sections
    .map((sec) => {
      const rows = sec.fields
        .map((f) => {
          const kind = f.choices?.length
            ? `One of: ${f.choices
                .slice(0, 8)
                .map((c) => c.text)
                .join(', ')}${f.choices.length > 8 ? ', …' : ''}`
            : (TYPE_WORDS[f.db_type] ?? 'Value')
          return `<div class="row"><div class="k">${esc(f.label)}${f.required ? ' <span class="req" aria-label="required">*</span>' : ''}</div><div class="v"><div class="ph">${esc(f.placeholder || kind)}</div>${box(f.path, f.label)}</div></div>`
        })
        .join('')
      return `<section>${sec.label ? `<h2>${esc(sec.label)}</h2>` : ''}${rows}</section>`
    })
    .join('')

  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">
<title>${esc(input.layoutName)} · preview</title><style>
:root{--bg:#f6f8fa;--card:#fff;--line:#e2e8f0;--soft:#f1f5f9;--text:#111827;--muted:#6b7280;--accent:#0089ad;--ph:#f6f8fa;--danger:#ef4444}
@media (prefers-color-scheme: dark){:root{--bg:#0b1220;--card:#111a2b;--line:#23324a;--soft:#1a2639;--text:#e2e8f0;--muted:#94a3b8;--accent:#38d6ff;--ph:#0f1828;--danger:#f87171}}
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'DM Sans',system-ui,sans-serif;font-size:13px;color:var(--text);background:var(--bg);padding:32px 16px;line-height:1.5}
.wrap{max-width:720px;margin:0 auto;background:var(--card);border:1px solid var(--line);border-radius:8px;padding:28px}
h1{font-size:18px;font-weight:600;letter-spacing:-.01em}
.meta{color:var(--muted);font-size:12px;margin:4px 0 4px}
.hint{color:var(--muted);font-size:12px;margin-bottom:18px}
h2{font-size:13px;margin:22px 0 8px;padding-bottom:6px;border-bottom:1px solid var(--line)}
.row{display:flex;gap:16px;padding:8px 0;border-bottom:1px solid var(--soft)}
.k{width:34%;color:var(--muted);font-size:12.5px;padding-top:6px}
.req{color:var(--danger)}
.v{flex:1;min-width:0}
.ph{height:32px;border:1px solid var(--line);border-radius:6px;background:var(--ph);color:var(--muted);font-size:12px;padding:6px 10px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.cm ul{list-style:none;margin-top:6px}
.cm li{font-size:12.5px;background:var(--soft);border-radius:6px;padding:6px 8px;margin-top:4px;word-break:break-word}
.when{color:var(--muted);font-size:11px;margin-left:4px}
.add{margin-top:4px;background:none;border:0;color:var(--accent);font-size:12px;cursor:pointer;padding:2px 0}
.add:hover{text-decoration:underline}
form.new{margin-top:6px;display:flex;flex-direction:column;gap:6px}
form.new input,form.new textarea{font:inherit;font-size:12.5px;color:var(--text);background:var(--card);border:1px solid var(--line);border-radius:6px;padding:6px 8px}
form.new textarea{min-height:64px;resize:vertical}
form.new .bar{display:flex;gap:8px;align-items:center}
form.new button{font:inherit;font-size:12px;border-radius:6px;padding:5px 10px;cursor:pointer;border:1px solid var(--line);background:var(--card);color:var(--text)}
form.new button.send{background:#00ceff;border-color:#00ceff;color:#fff}
.err{color:var(--danger);font-size:12px}
.general{margin-top:24px;border-top:1px solid var(--line);padding-top:12px}
.foot{margin-top:24px;text-align:center;color:var(--muted);font-size:11px}
@media (max-width:560px){.row{flex-direction:column;gap:4px}.k{width:auto;padding-top:0}}
</style></head><body><div class="wrap">
<h1>${esc(input.layoutName)}</h1>
<p class="meta">${esc(input.title)} · read-only preview${input.expiresAt ? ` · link expires ${esc(new Date(input.expiresAt).toLocaleDateString('en-US'))}` : ''}</p>
<p class="hint">This is how the form is laid out. Nothing here can be changed — leave a comment on any field and the form’s designer will see it.</p>
${sections}
<div class="general"><h2>About the whole form</h2>${box('', 'the whole form')}</div>
<p class="foot">Form preview</p>
</div>
<script${input.nonce ? ` nonce="${esc(input.nonce)}"` : ''}>
(function(){
  var token=${JSON.stringify(input.token)};
  var key='nvr-form-preview-name';
  function getName(){try{return localStorage.getItem(key)||''}catch(e){return ''}}
  function setName(v){try{localStorage.setItem(key,v)}catch(e){}}
  function el(tag,attrs,text){var n=document.createElement(tag);for(var k in attrs)n.setAttribute(k,attrs[k]);if(text)n.textContent=text;return n}
  document.querySelectorAll('.cm .add').forEach(function(btn){
    btn.addEventListener('click',function(){
      var box=btn.parentNode;if(box.querySelector('form'))return;
      var f=el('form',{'class':'new'});
      var name=el('input',{placeholder:'Your name',maxlength:'80','aria-label':'Your name'});name.value=getName();
      var text=el('textarea',{placeholder:'Your comment',maxlength:'2000','aria-label':'Your comment'});
      var bar=el('div',{'class':'bar'});
      var send=el('button',{type:'submit','class':'send'},'Post comment');
      var cancel=el('button',{type:'button'},'Cancel');
      var err=el('span',{'class':'err',role:'status'});
      bar.appendChild(send);bar.appendChild(cancel);bar.appendChild(err);
      f.appendChild(name);f.appendChild(text);f.appendChild(bar);
      box.insertBefore(f,btn);btn.style.display='none';(name.value?text:name).focus();
      cancel.addEventListener('click',function(){f.remove();btn.style.display=''});
      f.addEventListener('submit',function(e){
        e.preventDefault();err.textContent='';send.disabled=true;
        fetch(location.pathname.replace(/\\/$/,'')+'/comments',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({field:box.getAttribute('data-field'),name:name.value,text:text.value})})
          .then(function(r){return r.json().then(function(b){return {ok:r.ok,b:b}})})
          .then(function(res){
            send.disabled=false;
            if(!res.ok){err.textContent=(res.b&&res.b.error)||'Could not post the comment';return}
            setName(name.value.trim());
            var li=el('li',{});var b=el('b',{},res.b.data.name);li.appendChild(b);li.appendChild(el('span',{'class':'when'},'just now'));li.appendChild(el('div',{},res.b.data.text));
            box.querySelector('ul').appendChild(li);f.remove();btn.style.display='';
          })
          .catch(function(){send.disabled=false;err.textContent='Could not post the comment'});
      });
    });
  });
})();
</script></body></html>`
}
