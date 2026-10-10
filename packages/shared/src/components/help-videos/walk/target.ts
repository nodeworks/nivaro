// What a click hit, and finding that thing again.
//
// The recorder describes the element under each click on its own tab (its
// accessible name, role and nearest stable data-* hook); "Show me on this
// page" finds an element with the same description on the live screen. Both
// sides use the same name and role rules, so what was recorded is what is
// searched for. The server re-checks every field (api/src/services/
// help-video-walk.ts — keep CLICK_LIMITS in step).
//
// Privacy: an input's value or anything typed is never read, only its label;
// inside `.nvr-no-record` / `[data-nvr-no-record]` (the session-replay mask)
// nothing but the click's position is kept.

export const CLICK_LIMITS = { label: 80, hookValue: 79, path: 300 }

/** The recorded fields that say what was clicked (all optional). */
export type ClickTarget = {
  label?: string
  role?: string
  hook?: string
  page_key?: string
  path?: string
  origin?: string
}

const MASKED = '.nvr-no-record, [data-nvr-no-record]'
/** The recorder's own bar and the walk overlay are never what a tutorial is about. */
const OWN_UI = '[data-hv-recorder-bar], [data-hv-walk]'
const INTERACTIVE = [
  'button',
  'a[href]',
  'input',
  'textarea',
  'select',
  'summary',
  'label',
  '[role]',
  '[contenteditable=""]',
  '[contenteditable="true"]',
  '[tabindex]:not([tabindex="-1"])'
].join(', ')
/** Roles that are layout, not something a person clicks. */
const PASSIVE_ROLES = new Set([
  'presentation',
  'none',
  'group',
  'region',
  'main',
  'navigation',
  'banner',
  'contentinfo',
  'complementary',
  'list',
  'listitem',
  'document',
  'application',
  'img',
  'status',
  'alert',
  'log',
  'toolbar',
  'tablist',
  'menu',
  'menubar',
  'listbox',
  'grid',
  'table',
  'rowgroup',
  'dialog',
  'tabpanel',
  'tooltip',
  'separator'
])
/** Fields: only their label is ever read. */
const FIELD_ROLES = new Set(['textbox', 'searchbox', 'combobox', 'spinbutton', 'slider'])
/** data-* attributes that describe state or a library's internals, not a thing. */
const SKIP_DATA =
  /^data-(state|side|align|orientation|disabled|highlighted|placeholder|active|selected|open|closed|checked|pressed|expanded|focus.*|hover.*|tip|empty|pending|loading|value|index|key|radix.*|rfd.*|dnd.*|remote-editor|nvr-popover-marker|aria-.*|headlessui.*|sonner.*|vaul.*)$/

const collapse = (s: string) => s.replace(/\s+/g, ' ').trim()
const cut = (s: string, max: number) => (s.length > max ? s.slice(0, max).trimEnd() : s)

function inputRole(el: HTMLInputElement): string {
  const t = (el.getAttribute('type') || 'text').toLowerCase()
  if (t === 'checkbox') return 'checkbox'
  if (t === 'radio') return 'radio'
  if (t === 'range') return 'slider'
  if (t === 'number') return 'spinbutton'
  if (t === 'search') return 'searchbox'
  if (t === 'button' || t === 'submit' || t === 'reset' || t === 'image') return 'button'
  return 'textbox'
}

/** The element's role: its own `role`, else what its tag means. Null for plain elements. */
export function roleOf(el: Element): string | null {
  const explicit = el.getAttribute('role')?.trim().split(/\s+/)[0]?.toLowerCase()
  if (explicit && /^[a-z]{1,24}$/.test(explicit)) return explicit
  const tag = el.tagName.toLowerCase()
  if (tag === 'button' || tag === 'summary') return 'button'
  if (tag === 'a' && el.hasAttribute('href')) return 'link'
  if (tag === 'input') return inputRole(el as HTMLInputElement)
  if (tag === 'textarea') return 'textbox'
  if (tag === 'select') return 'combobox'
  if (tag === 'option') return 'option'
  if ((el as HTMLElement).isContentEditable || el.getAttribute('contenteditable') === 'true')
    return 'textbox'
  return null
}

function isField(el: Element, role: string | null): boolean {
  const tag = el.tagName.toLowerCase()
  if (tag === 'textarea' || tag === 'select') return true
  if (tag === 'input') {
    const r = inputRole(el as HTMLInputElement)
    return r !== 'button' && r !== 'checkbox' && r !== 'radio'
  }
  if ((el as HTMLElement).isContentEditable) return true
  return !!role && FIELD_ROLES.has(role)
}

/** Visible text without hidden parts (jsdom has no innerText: textContent there). */
function visibleText(el: Element): string {
  const h = el as HTMLElement
  const t = typeof h.innerText === 'string' ? h.innerText : (el.textContent ?? '')
  return collapse(t)
}

function byIds(el: Element, attr: string): string {
  const ids = el.getAttribute(attr)?.trim()
  if (!ids) return ''
  const doc = el.ownerDocument
  return collapse(
    ids
      .split(/\s+/)
      .map((id) => {
        const ref = doc.getElementById(id)
        // A field named by another field would read its value: never.
        return ref && !isField(ref, roleOf(ref)) ? (ref.textContent ?? '') : ''
      })
      .join(' ')
  )
}

/** Text of the field's <label>s, without the text of fields inside them. */
function labelText(el: Element): string {
  const labels = (el as HTMLInputElement).labels
  const list: Element[] = labels ? Array.from(labels) : []
  if (!list.length) {
    const wrap = el.closest('label')
    if (wrap) list.push(wrap)
  }
  return collapse(
    list
      .map((l) => {
        const copy = l.cloneNode(true) as Element
        for (const f of Array.from(copy.querySelectorAll('input, textarea, select'))) f.remove()
        return copy.textContent ?? ''
      })
      .join(' ')
  )
}

/**
 * A field without a label of its own: the nearest <label> just above it in
 * a small wrapper (form rows often render an unattached label beside the
 * field). Its text, without a required-marker asterisk.
 */
function nearbyLabel(el: Element): string {
  let node: Element | null = el.parentElement
  for (let depth = 0; node && depth < 4; depth++, node = node.parentElement) {
    // A wrapper holding other fields too: a label in it could be theirs.
    if (node.querySelectorAll('input, textarea, select, [contenteditable="true"]').length > 1) break
    const label = Array.from(node.querySelectorAll('label')).find(
      (l) =>
        !l.contains(el) &&
        !l.querySelector('input, textarea, select') &&
        // Before the field in the page: a label belongs to what follows it.
        !!(l.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING)
    )
    if (label) {
      const t = collapse(label.textContent ?? '').replace(/\s*\*$/, '')
      if (t && t.length <= CLICK_LIMITS.label) return t
    }
  }
  return ''
}

/**
 * The element's accessible name (≤ 80 characters): aria-label, aria-labelledby,
 * a field's <label>, alt, the visible text, then title. A field (text box,
 * select, combobox…) is named only by its label, placeholder or title — never
 * by its value or what was typed into it.
 */
export function accessibleName(el: Element): string {
  const role = roleOf(el)
  const pick = (...vals: Array<string | null | undefined>) => {
    for (const v of vals) {
      const t = collapse(v ?? '')
      if (t) return cut(t, CLICK_LIMITS.label)
    }
    return ''
  }
  const aria = el.getAttribute('aria-label')
  if (isField(el, role)) {
    return pick(
      aria,
      byIds(el, 'aria-labelledby'),
      labelText(el),
      el.getAttribute('placeholder'),
      el.getAttribute('title'),
      nearbyLabel(el)
    )
  }
  const tag = el.tagName.toLowerCase()
  if (tag === 'input') {
    // Buttons, checkboxes and radios: the value of a button input IS its caption.
    const t = (el as HTMLInputElement).type
    return pick(
      aria,
      byIds(el, 'aria-labelledby'),
      labelText(el),
      t === 'button' || t === 'submit' || t === 'reset' ? (el as HTMLInputElement).value : '',
      el.getAttribute('alt'),
      el.getAttribute('title')
    )
  }
  return pick(
    aria,
    byIds(el, 'aria-labelledby'),
    tag === 'img' ? el.getAttribute('alt') : '',
    tag === 'label' ? labelText(el) : '',
    // A thing containing a field shows the field's value as text: skip it.
    el.querySelector('input, textarea, select, [contenteditable="true"]') ? '' : visibleText(el),
    el.getAttribute('title')
  )
}

/** The nearest element a person means to click: the target or an interactive ancestor. */
export function interactiveTarget(target: Element): Element {
  let el: Element | null = target
  for (let depth = 0; el && depth < 8; depth++, el = el.parentElement) {
    if (el.matches(INTERACTIVE)) {
      const role = el.getAttribute('role')?.trim().toLowerCase()
      if (!role || !PASSIVE_ROLES.has(role)) return el
    }
  }
  return target
}

/**
 * The first meaningful data-* attribute on the element or up to three of its
 * ancestors, as `data-name` or `data-name=value` — never a state attribute
 * (data-state, data-radix-*…) nor a value that is long or holds a quote.
 */
export function stableHook(el: Element): string | undefined {
  let node: Element | null = el
  for (let depth = 0; node && depth < 4; depth++, node = node.parentElement) {
    for (const a of Array.from(node.attributes)) {
      const name = a.name.toLowerCase()
      if (!name.startsWith('data-') || SKIP_DATA.test(name)) continue
      if (!/^data-[a-z0-9][a-z0-9_-]{0,59}$/.test(name)) continue
      const value = a.value
      if (value.length > CLICK_LIMITS.hookValue || /["\n\r\\]/.test(value)) continue
      return value ? `${name}=${value}` : name
    }
  }
  return undefined
}

/**
 * What a click hit, ready to store with the click. Inside a masked area (or
 * the recorder's own UI) it is nothing at all: only the position is kept.
 */
export function describeClickTarget(
  target: EventTarget | null,
  where: { pageKey?: string | null; path?: string; origin?: string } = {}
): ClickTarget {
  if (!(target instanceof Element) || target.closest(`${MASKED}, ${OWN_UI}`)) return {}
  const el = interactiveTarget(target)
  const out: ClickTarget = {}
  const label = accessibleName(el)
  if (label) out.label = label
  const role = roleOf(el)
  if (role) out.role = role
  const hook = stableHook(el)
  if (hook) out.hook = hook
  if (where.pageKey) out.page_key = where.pageKey
  if (where.path) out.path = where.path.split(/[?#]/)[0].slice(0, CLICK_LIMITS.path)
  if (where.origin) out.origin = where.origin
  return out
}

/** At most this many labels go in a page's "labels seen" report (#1495). */
export const PAGE_LABELS_LIMIT = 300

/**
 * The accessible names of the click targets on the screen right now, for the
 * nightly "may be out of date" check (the server compares a published
 * recording's click labels with what the page shows). Visible interactive
 * elements only, named the way the recorder names a click (never a field's
 * value), deduplicated with case and spacing ignored, at most 300.
 */
export function collectPageLabels(
  root: ParentNode = document,
  opts: { visible?: (el: Element) => boolean } = {}
): string[] {
  const visible = opts.visible ?? isVisibleElement
  const out: string[] = []
  const seen = new Set<string>()
  for (const el of Array.from(root.querySelectorAll(INTERACTIVE))) {
    if (interactiveTarget(el) !== el) continue
    if (el.closest(`${MASKED}, ${OWN_UI}`) || !visible(el)) continue
    const label = accessibleName(el)
    if (!label) continue
    const key = label.replace(/\s+/g, ' ').trim().toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(label)
    if (out.length >= PAGE_LABELS_LIMIT) break
  }
  return out
}

/** A path with record ids folded (`/collections/workflows/12` → `/collections/workflows/:id`). */
export function normalizePath(path: string): string {
  return (
    path
      .split(/[?#]/)[0]
      .split('/')
      .map((seg) => {
        if (!seg) return seg
        if (/^\d+$/.test(seg)) return ':id'
        if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seg))
          return ':id'
        // Friendly record ids such as CR26-80329 or TP26-78750.
        if (/\d/.test(seg) && /^[A-Za-z]{0,6}\d[\w-]*$/.test(seg) && seg.length >= 4) return ':id'
        return seg
      })
      .join('/')
      .replace(/\/+$/, '') || '/'
  )
}

/** The step fields a match needs. */
export type StepWhere = { page_key: string | null; path: string | null }
export type Here = { pageKey: string | null; path: string }

/** True when the step was recorded on this screen (same page key, or same path shape). */
export function stepMatchesHere(step: StepWhere, here: Here): boolean {
  if (step.page_key && here.pageKey && step.page_key === here.pageKey) return true
  return !!step.path && normalizePath(step.path) === normalizePath(here.path)
}

/** Where to look for the step: `here`, `elsewhere`, or `here` when it does not say. */
export function stepScreen(step: StepWhere, here: Here): 'here' | 'elsewhere' {
  if (stepMatchesHere(step, here)) return 'here'
  return step.page_key || step.path ? 'elsewhere' : 'here'
}

/** A selector for a stored hook, or null when it is not one we wrote. */
export function hookSelector(hook: string): string | null {
  const m = /^(data-[a-z0-9][a-z0-9_-]{0,59})(?:=([^"\n\r\\]{0,79}))?$/.exec(hook)
  if (!m) return null
  return m[2] === undefined ? `[${m[1]}]` : `[${m[1]}="${m[2]}"]`
}

const norm = (s: string) => collapse(s).toLowerCase()

export type FindOptions = {
  root?: ParentNode
  /** Layout check; the default needs a box on screen. */
  visible?: (el: Element) => boolean
  /** Prefer an element in the viewport; the default reads its box. */
  inView?: (el: Element) => boolean
}

/** On screen with a box: connected, not hidden, not transparent. */
export function isVisibleElement(el: Element): boolean {
  if (!el.isConnected || el.closest('[hidden], [aria-hidden="true"], [inert]')) return false
  const r = el.getBoundingClientRect()
  if (r.width <= 0 && r.height <= 0) return false
  const s = getComputedStyle(el)
  const transparent = s.opacity !== '' && Number(s.opacity) <= 0.01
  return s.visibility !== 'hidden' && s.display !== 'none' && !transparent
}

function defaultInView(el: Element): boolean {
  const r = el.getBoundingClientRect()
  return r.bottom > 0 && r.right > 0 && r.top < window.innerHeight && r.left < window.innerWidth
}

/**
 * The element on the live screen a step is about, or null. The hook first;
 * then visible elements with the same role and accessible name (case and
 * spacing ignored); a step without a role matches the deepest element whose
 * text is the label. Among several, one in the viewport wins.
 */
export function findStepElement(
  step: { label: string; role: string | null; hook: string | null },
  opts: FindOptions = {}
): Element | null {
  const root = opts.root ?? document
  const visible = opts.visible ?? isVisibleElement
  const inView = opts.inView ?? defaultInView
  const want = norm(step.label)
  const nameOk = (el: Element) => {
    const n = norm(accessibleName(el))
    return n === want || (want.length >= CLICK_LIMITS.label - 2 && n.startsWith(want))
  }
  const roleOk = (el: Element) => !step.role || roleOf(el) === step.role
  const usable = (el: Element) => !el.closest('[data-hv-walk]') && visible(el)
  const best = (list: Element[]) => list.find(inView) ?? list[0] ?? null

  if (step.hook) {
    const sel = hookSelector(step.hook)
    if (sel) {
      let hooked: Element[] = []
      try {
        hooked = Array.from(root.querySelectorAll(sel)).filter(usable)
      } catch {
        hooked = []
      }
      // The hook may sit on an ancestor of what was clicked: look inside too.
      const named = hooked.flatMap((h) =>
        [h, ...Array.from(h.querySelectorAll(INTERACTIVE))].filter(
          (el) => usable(el) && roleOk(el) && nameOk(el)
        )
      )
      if (named.length) return best(named)
      // One hooked element of the same kind, renamed since (a count in its
      // text): still the one. A hooked wrapper (no such role) is not.
      if (hooked.length === 1 && step.role && roleOf(hooked[0]) === step.role) return hooked[0]
    }
  }
  if (step.role) {
    const list = Array.from(root.querySelectorAll(INTERACTIVE)).filter(
      (el) => interactiveTarget(el) === el && roleOk(el) && usable(el) && nameOk(el)
    )
    return best(list)
  }
  // No role: the deepest visible element whose own text is the label.
  const hits = Array.from(root.querySelectorAll('*')).filter((el) => {
    if (el.tagName === 'SCRIPT' || el.tagName === 'STYLE' || el.tagName === 'TEMPLATE') return false
    const t = el.textContent ?? ''
    // Cheap length check before normalizing: most elements hold far more text.
    return t.length <= want.length * 3 + 40 && norm(t) === want && usable(el)
  })
  const deepest = hits.filter((el) => !hits.some((o) => o !== el && el.contains(o)))
  return best(deepest)
}
