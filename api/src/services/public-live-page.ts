/**
 * The page shell for the small public status pages that update while open (realtime round 9):
 * the decision-link landing page (approval links from email / Teams) and the submission status
 * page of a public form. Server-rendered, no app bundle, a nonce'd inline script and a strict
 * CSP, light and dark from `prefers-color-scheme`.
 *
 * Live: the script listens on a token-scoped stream (services/public-signal-stream.ts) for a
 * bare `changed`, refetches the page's own address with `?refresh=1` and swaps the one
 * `#nvr-live` block in place — nothing scrolls, a focused button keeps its place when the block
 * did not change shape. A changed headline fades once (never with reduced motion or the
 * viewer's Calm / Off live setting). `gone` reloads into the page's own "no longer here" answer.
 * Times render in the reader's own time zone from `<time datetime>` (a UTC fallback without JS).
 */

export const esc = (v: unknown): string =>
  String(v ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string
  )

/** `<time>` the script turns into "10:42 AM" (today) or "Nov 14, 10:42 AM". */
export function timeTag(iso: string | Date | null | undefined): string {
  if (!iso) return ''
  const d = iso instanceof Date ? iso : new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const fallback = `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC`
  return `<time datetime="${esc(d.toISOString())}">${esc(fallback)}</time>`
}

export type LiveMode = 'normal' | 'calm' | 'off'

export interface PublicLivePageOptions {
  title: string
  /** Small line above the card content (the form or chain name). */
  context?: string | null
  /** The live block's HTML (already escaped). */
  liveHtml: string
  nonce: string
  /** Stream path, relative to the page (e.g. `/form-status/<t>/stream` or `stream?token=`). */
  streamUrl: string | null
  /** The address the script refetches (`?refresh=1` is appended). */
  refreshUrl: string
  /** The viewer's live setting when known (a signed-in approver); public pages are Normal. */
  liveMode?: LiveMode
  foot?: string | null
}

/** The policy: own inline style, the nonce'd script, reads and form posts to its own origin. */
export function publicLiveCsp(nonce: string, opts: { forms?: boolean } = {}): string {
  return [
    "default-src 'none'",
    "style-src 'unsafe-inline'",
    `script-src 'nonce-${nonce}'`,
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    `form-action ${opts.forms ? "'self'" : "'none'"}`
  ].join('; ')
}

const STYLE = `*{box-sizing:border-box;margin:0;padding:0}
:root{--bg:#f4f6f9;--card:#fff;--fg:#0f172a;--muted:#5b6678;--faint:#8792a3;--line:#e3e8ef;--accent:#00a9d1;--accent-ink:#06303d;--btn:#00ceff;
--ok:#0f7a52;--ok-bg:#e7f6ef;--bad:#b4232f;--bad-bg:#fbecee;--wait:#8a5a00;--wait-bg:#fdf4e2;--ask:#0b6c86;--ask-bg:#e3f6fb;--chg:rgba(0,206,255,.16);--sel:rgba(0,206,255,.22)}
@media (prefers-color-scheme:dark){:root{--bg:#0b1120;--card:#121a2b;--fg:#e5e9f0;--muted:#a3adbd;--faint:#7b8698;--line:#233047;--accent:#38d3f5;--accent-ink:#04222c;--btn:#00ceff;
--ok:#5fd3a2;--ok-bg:rgba(52,199,140,.12);--bad:#f5848d;--bad-bg:rgba(245,104,116,.12);--wait:#f1c169;--wait-bg:rgba(241,184,80,.12);--ask:#6fdcf5;--ask-bg:rgba(0,206,255,.11);--chg:rgba(0,206,255,.18);--sel:rgba(0,206,255,.3)}}
::selection{background:var(--sel)}
body{font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:14px;color:var(--fg);background:var(--bg);padding:48px 16px;line-height:1.5;-webkit-font-smoothing:antialiased}
.wrap{max-width:520px;margin:0 auto;background:var(--card);border:1px solid var(--line);border-radius:14px;padding:28px 28px 24px;box-shadow:0 1px 2px rgba(15,23,42,.04),0 8px 24px -12px rgba(15,23,42,.12)}
@media (max-width:480px){body{padding:20px 12px}.wrap{padding:22px 18px 18px}}
.ctx{color:var(--muted);font-size:12.5px;margin-bottom:14px;overflow-wrap:anywhere}
.state{display:flex;gap:12px;align-items:flex-start}
.dot{flex:none;width:10px;height:10px;border-radius:50%;margin-top:9px;background:var(--faint)}
.tone-done .dot{background:var(--fg)}.tone-ok .dot{background:var(--ok)}.tone-bad .dot{background:var(--bad)}.tone-wait .dot{background:var(--wait)}.tone-ask .dot{background:var(--ask)}
h1{font-size:21px;line-height:1.3;letter-spacing:-.015em;font-weight:650;text-wrap:balance}
.by{margin-top:4px;color:var(--muted);font-size:13.5px}
.by strong{color:var(--fg);font-weight:600}
.note{margin-top:14px;color:var(--muted);font-size:13px;max-width:60ch}
.chg h1{animation:nvrchg 1.4s cubic-bezier(.16,1,.3,1)}
@keyframes nvrchg{from{background:var(--chg);border-radius:4px}to{background:transparent}}
@media (prefers-reduced-motion:reduce){.chg h1{animation:none}}
.track{list-style:none;display:flex;margin:22px 0 4px;gap:0}
.track li{flex:1;position:relative;padding-top:18px;font-size:12px;color:var(--faint)}
.track li::before{content:'';position:absolute;top:4px;left:0;width:9px;height:9px;border-radius:50%;background:var(--card);border:2px solid var(--line);z-index:1}
.track li::after{content:'';position:absolute;top:8px;left:9px;right:0;height:2px;background:var(--line)}
.track li:last-child::after{display:none}
.track li.done{color:var(--muted)}.track li.done::before{background:var(--accent);border-color:var(--accent)}.track li.done::after{background:var(--accent)}
.track li.now{color:var(--fg);font-weight:600}.track li.now::before{background:var(--accent);border-color:var(--accent);box-shadow:0 0 0 4px var(--ask-bg)}
.actions{margin-top:20px;display:flex;flex-wrap:wrap;gap:10px;align-items:center}
button{font:inherit;font-size:14px;font-weight:650;padding:10px 22px;border:0;border-radius:8px;background:var(--btn);color:#06303d;cursor:pointer;transition:filter .15s}
button:hover{filter:brightness(.95)}
button.reject{background:transparent;color:var(--bad);border:1px solid currentColor}
button:disabled{opacity:.55;cursor:default}
a{color:var(--accent);text-underline-offset:3px;text-decoration-thickness:1px}
a:hover{text-decoration-thickness:2px}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px;border-radius:6px}
.foot{margin-top:22px;padding-top:14px;border-top:1px solid var(--line);color:var(--faint);font-size:11.5px;display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap}
time{font-variant-numeric:tabular-nums}`

/**
 * Live script: listen, refetch the page's own address (`?refresh=1`), swap `#nvr-live`. A
 * hidden tab waits until shown; the headline fades once when its text changed (motion allowed).
 */
function liveScript(streamUrl: string | null, refreshUrl: string, mode: LiveMode): string {
  return `(function(){
var MODE=${JSON.stringify(mode)};
function fmt(root){if(!window.Intl)return;var now=new Date();(root||document).querySelectorAll('time[datetime]').forEach(function(t){var d=new Date(t.getAttribute('datetime'));if(isNaN(d))return;
var same=d.toDateString()===now.toDateString();var o=same?{hour:'numeric',minute:'2-digit'}:{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'};if(!same&&d.getFullYear()!==now.getFullYear())o.year='numeric';
try{t.textContent=d.toLocaleString(undefined,o)}catch(e){}})}
fmt();
var STREAM=${JSON.stringify(streamUrl)};if(!STREAM||MODE==='off'||!window.EventSource||!window.fetch||!window.DOMParser)return;
var REFRESH=${JSON.stringify(refreshUrl)};var busy=false,again=false,owed=false;
function swap(t){var doc=new DOMParser().parseFromString(t,'text/html');var next=doc.getElementById('nvr-live');var cur=document.getElementById('nvr-live');if(!next||!cur)return;
if(next.innerHTML===cur.innerHTML)return;var h1=cur.querySelector('h1'),h2=next.querySelector('h1');var changed=!h1||!h2||h1.textContent!==h2.textContent;
var active=document.activeElement;var keepFocus=active&&cur.contains(active)&&active.getAttribute('data-k');
cur.innerHTML=next.innerHTML;fmt(cur);
if(keepFocus){var again2=cur.querySelector('[data-k="'+keepFocus+'"]');if(again2)again2.focus()}
if(changed&&MODE!=='calm'){cur.classList.remove('chg');void cur.offsetWidth;cur.classList.add('chg')}}
function refresh(){if(document.hidden){owed=true;return}if(busy){again=true;return}busy=true;
fetch(REFRESH+(REFRESH.indexOf('?')<0?'?':'&')+'refresh=1',{credentials:'same-origin',cache:'no-store'}).then(function(r){if(r.status===404||r.status===410){location.reload();return null}return r.ok?r.text():null}).then(function(t){if(t)swap(t)}).catch(function(){}).then(function(){busy=false;if(again){again=false;refresh()}})}
document.addEventListener('visibilitychange',function(){if(!document.hidden&&owed){owed=false;refresh()}});
var es=new EventSource(STREAM);es.addEventListener('changed',refresh);es.addEventListener('gone',function(){es.close();location.reload()});
})();`
}

export function publicLivePageHtml(o: PublicLivePageOptions): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex, nofollow">
<meta name="referrer" content="no-referrer"><meta name="color-scheme" content="light dark">
<title>${esc(o.title)}</title><style>${STYLE}</style></head><body><main class="wrap">
${o.context ? `<p class="ctx">${esc(o.context)}</p>` : ''}<div id="nvr-live" aria-live="polite">${o.liveHtml}</div>
${
  o.foot || o.streamUrl
    ? `<p class="foot"><span>${o.foot ? esc(o.foot) : 'This page updates while it is open.'}</span></p>`
    : ''
}
</main><script nonce="${esc(o.nonce)}">${liveScript(o.streamUrl, o.refreshUrl, o.liveMode ?? 'normal')}</script></body></html>`
}

/** A plain answer page (not found, expired, error) in the same look, no script. */
export function publicMessagePageHtml(title: string, message: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex, nofollow">
<meta name="referrer" content="no-referrer"><meta name="color-scheme" content="light dark">
<title>${esc(title)}</title><style>${STYLE}</style></head><body><main class="wrap">
<div class="state"><span class="dot" aria-hidden="true"></span><div><h1>${esc(title)}</h1><p class="note">${esc(message)}</p></div></div>
</main></body></html>`
}
