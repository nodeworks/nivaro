import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'

// ─── Types ────────────────────────────────────────────────────────────────────

interface FieldConfig {
  label?: string
  placeholder?: string
  required?: boolean
  widget?: string
}

interface FormConfig {
  heading?: string
  description?: string
  submit_label?: string
  fields?: Record<string, FieldConfig>
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function parseJson<T>(v: string | null | undefined): T | null {
  if (!v) return null
  try {
    return JSON.parse(v) as T
  } catch {
    return null
  }
}

function escHtml(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

// Safe JSON for <script> blocks — prevents </script> breakout and LS/PS newline injection
function escJson(v: unknown): string {
  return JSON.stringify(v)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
}

function titleCase(s: string): string {
  return s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

function guessWidget(fieldPath: string, dbType: string): string {
  const l = fieldPath.toLowerCase()
  if (l.includes('email')) return 'email'
  if (l.includes('phone') || l.includes('tel') || l.includes('mobile')) return 'tel'
  if (l.includes('url') || l.includes('website') || l.includes('link')) return 'url'
  const map: Record<string, string> = {
    text: 'textarea',
    integer: 'number',
    bigInteger: 'number',
    decimal: 'number',
    float: 'number',
    boolean: 'checkbox',
    date: 'date',
    datetime: 'datetime-local'
  }
  return map[dbType] || 'text'
}

function renderField(path: string, cfg: FieldConfig, dbType: string): string {
  const widget = cfg.widget || guessWidget(path, dbType)
  const label = cfg.label || path.split('.').map(titleCase).join(' › ')
  const placeholder = escHtml(cfg.placeholder || '')
  const required = cfg.required ?? false
  const reqAttr = required ? ' required' : ''
  const reqMark = required ? '<span class="req" aria-hidden="true">*</span>' : ''
  const rawName = path.replace(/\./g, '__')
  const safeName = escHtml(rawName)

  if (widget === 'checkbox') {
    return `<div class="field">
  <div class="field-cb">
    <input type="checkbox" id="f_${safeName}" name="${safeName}" data-path="${escHtml(path)}"${reqAttr}>
    <label for="f_${safeName}">${escHtml(label)}${reqMark}</label>
  </div>
</div>`
  }

  if (widget === 'textarea') {
    return `<div class="field">
  <label for="f_${safeName}">${escHtml(label)}${reqMark}</label>
  <textarea id="f_${safeName}" name="${safeName}" data-path="${escHtml(path)}" placeholder="${placeholder}"${reqAttr}></textarea>
</div>`
  }

  return `<div class="field">
  <label for="f_${safeName}">${escHtml(label)}${reqMark}</label>
  <input type="${escHtml(widget)}" id="f_${safeName}" name="${safeName}" data-path="${escHtml(path)}" placeholder="${placeholder}"${reqAttr}>
</div>`
}

function buildHtml(params: {
  token: string
  formName: string
  formConfig: FormConfig
  fields: string[]
  fieldTypes: Record<string, string>
  hasPassword: boolean
  successMessage: string
}): string {
  const { token, formName, formConfig, fields, fieldTypes, hasPassword, successMessage } = params

  const heading = escHtml(formConfig.heading || formName)
  const description = formConfig.description
    ? `<p class="form-desc">${escHtml(formConfig.description)}</p>`
    : ''
  const submitLabel = escHtml(formConfig.submit_label || 'Submit')
  const fieldCfgs = formConfig.fields || {}

  const passwordBlock = hasPassword
    ? `<div class="field pw-wrap">
  <p class="pw-label">This form is password protected.</p>
  <label for="f__password">Password<span class="req" aria-hidden="true">*</span></label>
  <input type="password" id="f__password" name="__password" autocomplete="current-password" required>
</div>`
    : ''

  const fieldsHtml = fields
    .map((f) => renderField(f, fieldCfgs[f] || {}, fieldTypes[f] || ''))
    .join('\n')

  const submitJs = `(function(){
var TOKEN=${escJson(token)};
var SUBMIT_URL='/api/submission-forms/public/'+TOKEN;
var HAS_PW=${escJson(hasPassword)};
var SUBMIT_LABEL=${escJson(formConfig.submit_label || 'Submit')};
var SUCCESS_MSG=${escJson(successMessage)};
var form=document.getElementById('sf');
var msgEl=document.getElementById('msg');
function showMsg(text,type){msgEl.textContent=text;msgEl.className='msg '+type;msgEl.hidden=false;}
function hideMsg(){msgEl.hidden=true;}
form.addEventListener('submit',async function(e){
  e.preventDefault();
  var btn=form.querySelector('.submit');
  btn.disabled=true;btn.textContent='Submitting…';
  hideMsg();
  var data={};
  form.querySelectorAll('[data-path]').forEach(function(el){
    var path=el.getAttribute('data-path');
    data[path]=el.type==='checkbox'?el.checked:el.value;
  });
  var body={data:data};
  if(HAS_PW){var pw=form.querySelector('[name="__password"]');if(pw)body.password=pw.value;}
  try{
    var res=await fetch(SUBMIT_URL,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    var json=await res.json();
    if(!res.ok){showMsg(json.error||'Submission failed. Please try again.','err');btn.disabled=false;btn.textContent=SUBMIT_LABEL;}
    else{
      var doneEl=document.createElement('div');
      doneEl.className='done';
      doneEl.innerHTML='<div class="done-icon">&#10003;</div><p class="done-title">Submitted!</p><p class="done-msg"></p>';
      doneEl.querySelector('.done-msg').textContent=SUCCESS_MSG;
      document.getElementById('form-wrap').replaceChildren(doneEl);
    }
  }catch(err){
    showMsg('Network error. Please try again.','err');
    btn.disabled=false;btn.textContent=SUBMIT_LABEL;
  }
});
})();`

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${heading}</title>
  <style>
    *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
    :root{
      --bg:#fff;--surface:#f9fafb;--border:#e5e7eb;
      --text:#111827;--muted:#6b7280;
      --accent:#00ceff;--accent-h:#00b8e0;
      --r:6px;--err:#ef4444;--ok:#10b981
    }
    html,body{height:100%}
    body{
      font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
      font-size:14px;color:var(--text);background:var(--bg);
      padding:32px 20px;line-height:1.5
    }
    .wrap{max-width:540px;margin:0 auto}
    .form-title{font-size:22px;font-weight:600;letter-spacing:-.015em;margin-bottom:6px}
    .form-desc{color:var(--muted);font-size:13px;margin-bottom:24px}
    .msg{display:none;padding:11px 14px;border-radius:var(--r);font-size:13px;margin-bottom:16px}
    .msg.ok{background:rgba(16,185,129,.08);color:#065f46;border:1px solid rgba(16,185,129,.25)}
    .msg.err{background:rgba(239,68,68,.08);color:#991b1b;border:1px solid rgba(239,68,68,.25)}
    .field{margin-bottom:18px}
    .field label{display:block;font-size:13px;font-weight:500;margin-bottom:5px;color:var(--text)}
    .req{color:var(--err);margin-left:2px}
    .field input,.field textarea{
      width:100%;padding:8px 12px;
      border:1px solid var(--border);border-radius:var(--r);
      font:inherit;color:var(--text);background:var(--bg);
      outline:none;transition:border-color .12s,box-shadow .12s;
      -webkit-appearance:none;appearance:none
    }
    .field input:focus,.field textarea:focus{
      border-color:var(--accent);
      box-shadow:0 0 0 3px rgba(0,206,255,.12)
    }
    .field textarea{resize:vertical;min-height:96px}
    .field-cb{display:flex;align-items:center;gap:8px}
    .field-cb input[type=checkbox]{
      width:16px;height:16px;flex-shrink:0;
      border:1px solid var(--border);border-radius:3px;
      cursor:pointer;accent-color:var(--accent);
      -webkit-appearance:auto;appearance:auto
    }
    .field-cb label{font-weight:400;margin-bottom:0;cursor:pointer}
    .pw-wrap{background:var(--surface);border:1px solid var(--border);border-radius:var(--r);padding:16px}
    .pw-label{color:var(--muted);font-size:13px;margin-bottom:12px}
    .submit{
      width:100%;padding:10px 20px;
      background:var(--accent);color:#172940;
      border:none;border-radius:var(--r);
      font:600 14px/1 inherit;cursor:pointer;
      transition:background .12s
    }
    .submit:hover{background:var(--accent-h)}
    .submit:disabled{opacity:.55;cursor:not-allowed}
    .done{text-align:center;padding:48px 16px}
    .done-icon{font-size:36px;margin-bottom:12px;color:var(--ok)}
    .done-title{font-size:18px;font-weight:600;margin-bottom:8px}
    .done-msg{color:var(--muted)}
  </style>
</head>
<body>
<div class="wrap">
  <div id="form-wrap">
    <h1 class="form-title">${heading}</h1>
    ${description}
    <div id="msg" class="msg" role="alert" aria-live="polite" hidden></div>
    <form id="sf" novalidate>
      ${passwordBlock}
      ${fieldsHtml}
      <button type="submit" class="submit">${submitLabel}</button>
    </form>
  </div>
</div>
<script>${submitJs}</script>
</body>
</html>`
}

// ─── Route ────────────────────────────────────────────────────────────────────

export async function formRendererRoutes(app: FastifyInstance) {
  app.get<{ Params: { token: string } }>('/form/:token', async (req, reply) => {
    const { token } = req.params

    const form = await db('nivaro_submission_forms').where({ token }).first()

    if (!form) {
      return reply
        .code(404)
        .type('text/html')
        .send(errorPage('Form not found', 'This form does not exist or has been removed.'))
    }

    if (!form.is_active) {
      return reply
        .code(410)
        .type('text/html')
        .send(errorPage('Form unavailable', 'This form is no longer accepting submissions.'))
    }

    if (form.expires_at && new Date(form.expires_at as string) < new Date()) {
      return reply
        .code(410)
        .type('text/html')
        .send(
          errorPage('Form expired', 'This form has expired and is no longer accepting submissions.')
        )
    }

    const fields: string[] = parseJson<string[]>(form.fields as string) ?? []
    const formConfig: FormConfig = parseJson<FormConfig>(form.form_config as string) ?? {}

    // Fetch DB types for top-level fields to improve widget guessing
    const fieldTypes: Record<string, string> = {}
    if (fields.length && form.collection) {
      const topFields = [...new Set(fields.map((f: string) => f.split('.')[0]))]
      const rows = await db('nivaro_fields')
        .where({ collection: form.collection })
        .whereIn('field', topFields)
        .select('field', 'type')
      for (const r of rows) {
        fieldTypes[r.field as string] = r.type as string
      }
      for (const f of fields) {
        const top = f.split('.')[0]
        if (top !== f && fieldTypes[top]) fieldTypes[f] = fieldTypes[top]
      }
    }

    const html = buildHtml({
      token: form.token as string,
      formName: form.name as string,
      formConfig,
      fields,
      fieldTypes,
      hasPassword: !!form.password_hash,
      successMessage:
        (form.success_message as string) || 'Thank you! Your submission has been received.'
    })

    return reply
      .code(200)
      .type('text/html')
      .header('X-Frame-Options', 'ALLOWALL')
      .header('Content-Security-Policy', 'frame-ancestors *')
      .send(html)
  })
}

function errorPage(title: string, message: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escHtml(title)}</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
    display:flex;align-items:center;justify-content:center;min-height:100vh;
    background:#f9fafb;color:#111827}
    .box{text-align:center;padding:40px 24px;max-width:400px}
    h1{font-size:18px;font-weight:600;margin-bottom:8px}
    p{color:#6b7280;font-size:14px}
  </style>
</head>
<body>
<div class="box">
  <h1>${escHtml(title)}</h1>
  <p>${escHtml(message)}</p>
</div>
</body>
</html>`
}
