import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { type FormLayoutField, type FormLayoutStructure, loadFormLayout } from '../services/form-layout.js'

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

function renderLayoutField(f: FormLayoutField): string {
  const visAttr = f.visibility?.length
    ? ` data-vis='${escHtml(JSON.stringify(f.visibility))}'`
    : ''
  const reqAttr = f.required ? ' required' : ''
  const reqMark = f.required ? '<span class="req" aria-hidden="true">*</span>' : ''
  const safeName = escHtml(f.path.replace(/\./g, '__'))
  const label = escHtml(f.label)
  const placeholder = escHtml(f.placeholder ?? '')

  if (f.choices) {
    const opts = f.choices
      .map((c) => `<option value="${escHtml(c.value)}">${escHtml(c.text)}</option>`)
      .join('')
    return `<div class="field"${visAttr}>
  <label for="f_${safeName}">${label}${reqMark}</label>
  <select id="f_${safeName}" name="${safeName}" data-path="${escHtml(f.path)}"${reqAttr}>
    <option value="">${placeholder || 'Select…'}</option>${opts}
  </select>
</div>`
  }
  const widget = guessWidget(f.path, f.db_type)
  if (widget === 'checkbox') {
    return `<div class="field"${visAttr}>
  <div class="field-cb">
    <input type="checkbox" id="f_${safeName}" name="${safeName}" data-path="${escHtml(f.path)}"${reqAttr}>
    <label for="f_${safeName}">${label}${reqMark}</label>
  </div>
</div>`
  }
  if (widget === 'textarea') {
    return `<div class="field"${visAttr}>
  <label for="f_${safeName}">${label}${reqMark}</label>
  <textarea id="f_${safeName}" name="${safeName}" data-path="${escHtml(f.path)}" placeholder="${placeholder}"${reqAttr}></textarea>
</div>`
  }
  return `<div class="field"${visAttr}>
  <label for="f_${safeName}">${label}${reqMark}</label>
  <input type="${escHtml(widget)}" id="f_${safeName}" name="${safeName}" data-path="${escHtml(f.path)}" placeholder="${placeholder}"${reqAttr}>
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
  layout?: FormLayoutStructure | null
}): string {
  const { token, formName, formConfig, fields, fieldTypes, hasPassword, successMessage, layout } = params
  const steps = layout?.tab_mode === 'steps' && layout.sections.length > 1

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

  const fieldsHtml = layout
    ? layout.sections
        .map((sec, i) => {
          const inner = sec.fields.map(renderLayoutField).join('\n')
          const title = sec.label ? `<h2 class="sec-title">${escHtml(sec.label)}</h2>` : ''
          if (steps) {
            return `<div class="step" data-step="${i}"${i > 0 ? ' hidden' : ''}>${title}${inner}</div>`
          }
          return `<section class="sec">${title}${inner}</section>`
        })
        .join('\n')
    : fields.map((f) => renderField(f, fieldCfgs[f] || {}, fieldTypes[f] || '')).join('\n')

  const stepsBar = steps
    ? `<div class="steps-bar">${(layout?.sections ?? [])
        .map(
          (sec, i) =>
            `<div class="step-dot${i === 0 ? ' active' : ''}" data-dot="${i}"><span>${i + 1}</span>${sec.label ? escHtml(sec.label) : `Step ${i + 1}`}</div>`
        )
        .join('')}</div>`
    : ''

  const stepControls = steps
    ? `<div class="step-nav">
  <button type="button" class="step-btn back" id="step-back" hidden>Back</button>
  <button type="button" class="step-btn next" id="step-next">Next</button>
</div>`
    : ''

  const submitJs = `(function(){
var TOKEN=${escJson(token)};
var SUBMIT_URL='/api/submission-forms/public/'+TOKEN;
var HAS_PW=${escJson(hasPassword)};
var SUBMIT_LABEL=${escJson(formConfig.submit_label || 'Submit')};
var SUCCESS_MSG=${escJson(successMessage)};
var STEPS=${escJson(!!steps)};
var form=document.getElementById('sf');
var msgEl=document.getElementById('msg');
// ── Visibility rules ──
function fieldVal(path){var el=form.querySelector('[data-path="'+path+'"]');if(!el)return null;return el.type==='checkbox'?el.checked:el.value;}
function ruleMatch(r){var v=fieldVal(r.when);switch(r.op){
  case 'eq':return String(v)===String(r.value);
  case 'neq':return String(v)!==String(r.value);
  case 'null':return v===null||v===''||v===false;
  case 'nnull':return !(v===null||v===''||v===false);
  case 'contains':return String(v||'').indexOf(String(r.value))>=0;
  case 'in':return Array.isArray(r.value)&&r.value.map(String).indexOf(String(v))>=0;
  default:return true;}}
function applyVisibility(){form.querySelectorAll('[data-vis]').forEach(function(w){
  var rules;try{rules=JSON.parse(w.getAttribute('data-vis'))}catch(e){return}
  var visible=true;
  rules.forEach(function(r){var m=ruleMatch(r);
    if(r.action==='show'&&!m)visible=false;
    if(r.action==='hide'&&m)visible=false;});
  w.hidden=!visible;
  w.querySelectorAll('input,select,textarea').forEach(function(el){el.disabled=!visible;});
});}
form.addEventListener('input',applyVisibility);
form.addEventListener('change',applyVisibility);
applyVisibility();
// ── Step wizard ──
var curStep=0;
function stepEls(){return Array.prototype.slice.call(form.querySelectorAll('.step'));}
function showStep(i){var els=stepEls();if(!els.length)return;
  curStep=Math.max(0,Math.min(i,els.length-1));
  els.forEach(function(el,idx){el.hidden=idx!==curStep;});
  document.querySelectorAll('.step-dot').forEach(function(d,idx){
    d.classList.toggle('active',idx===curStep);
    d.classList.toggle('done',idx<curStep);});
  var back=document.getElementById('step-back');
  var next=document.getElementById('step-next');
  var submit=form.querySelector('.submit');
  if(back)back.hidden=curStep===0;
  if(next)next.hidden=curStep===els.length-1;
  if(submit&&STEPS)submit.hidden=curStep!==els.length-1;
  applyVisibility();}
function stepValid(){var els=stepEls();if(!els.length)return true;
  var bad=null;
  els[curStep].querySelectorAll('[required]').forEach(function(el){
    if(el.disabled||el.closest('[hidden]'))return;
    var v=el.type==='checkbox'?el.checked:el.value;
    if(!v&&bad===null)bad=el;});
  if(bad){bad.focus();bad.classList.add('invalid');setTimeout(function(){bad.classList.remove('invalid')},1200);return false;}
  return true;}
if(STEPS){
  var nextBtn=document.getElementById('step-next');
  var backBtn=document.getElementById('step-back');
  if(nextBtn)nextBtn.addEventListener('click',function(){if(stepValid())showStep(curStep+1);});
  if(backBtn)backBtn.addEventListener('click',function(){showStep(curStep-1);});
  showStep(0);
}
function showMsg(text,type){msgEl.textContent=text;msgEl.className='msg '+type;msgEl.hidden=false;}
function hideMsg(){msgEl.hidden=true;}
form.addEventListener('submit',async function(e){
  e.preventDefault();
  var btn=form.querySelector('.submit');
  btn.disabled=true;btn.textContent='Submitting…';
  hideMsg();
  if(STEPS&&!stepValid()){btn.disabled=false;btn.textContent=SUBMIT_LABEL;return;}
  var data={};
  form.querySelectorAll('[data-path]').forEach(function(el){
    if(el.disabled)return;
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
    .sec{margin-bottom:8px}
    .sec-title{font-size:14px;font-weight:600;margin:20px 0 12px;padding-bottom:6px;border-bottom:1px solid var(--border)}
    .field select{width:100%;padding:8px 12px;border:1px solid var(--border);border-radius:var(--r);font:inherit;color:var(--text);background:var(--bg);outline:none}
    .field select:focus{border-color:var(--accent);box-shadow:0 0 0 3px rgba(0,206,255,.12)}
    .field.invalid input,.field input.invalid,select.invalid,textarea.invalid,input.invalid{border-color:var(--err);box-shadow:0 0 0 3px rgba(239,68,68,.12)}
    .steps-bar{display:flex;gap:4px;margin-bottom:24px;flex-wrap:wrap}
    .step-dot{display:flex;align-items:center;gap:6px;font-size:11px;color:var(--muted);padding:4px 10px 4px 4px;border-radius:999px;background:var(--surface)}
    .step-dot span{display:flex;align-items:center;justify-content:center;width:20px;height:20px;border-radius:50%;background:var(--border);font-weight:600;font-size:10px}
    .step-dot.active{color:var(--text);background:rgba(0,206,255,.1)}
    .step-dot.active span{background:var(--accent);color:#172940}
    .step-dot.done span{background:var(--ok);color:#fff}
    .step-nav{display:flex;justify-content:space-between;gap:8px;margin-bottom:14px}
    .step-btn{padding:9px 18px;border-radius:var(--r);font:600 13px/1 inherit;cursor:pointer;border:1px solid var(--border);background:var(--bg);color:var(--text)}
    .step-btn.next{margin-left:auto;background:var(--accent);border-color:var(--accent);color:#172940}
    .step-btn.next:hover{background:var(--accent-h)}
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
    ${stepsBar}
    <form id="sf" novalidate>
      ${passwordBlock}
      ${fieldsHtml}
      ${stepControls}
      <button type="submit" class="submit"${steps ? ' hidden' : ''}>${submitLabel}</button>
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

    // Layout-backed form: resolve the referenced grouped layout; fall back to
    // the flat fields list when missing/invalid.
    const layout = form.layout_id
      ? await loadFormLayout(Number(form.layout_id), form.collection as string)
      : null

    const html = buildHtml({
      token: form.token as string,
      formName: form.name as string,
      formConfig,
      fields,
      fieldTypes,
      layout,
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
