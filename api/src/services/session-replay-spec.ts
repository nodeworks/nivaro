/**
 * A Playwright spec from a stretch of a recording (#1393).
 *
 * Walks the rrweb events the way buildReplayPlan does (the snapshot indexed by
 * node id, mutations folded in as they come — session-replay-script.ts) and
 * turns what the person DID between from and to into the golden-path
 * recorder's steps (admin/src/lib/e2e-recorder.ts RecordedStep): page changes
 * become gotos, clicks become clicks, typing becomes one fill per field.
 * The admin renders those steps with the recorder's own renderSpec, so a spec
 * made from a recording reads exactly like one recorded live, and it opens in
 * the recorder page to be edited and saved.
 *
 * Selectors, most stable first: a data-* hook on the element → role +
 * accessible name (rendered as getByRole) for buttons, links and the like →
 * #id → [aria-label] → name → placeholder → a short CSS path. Typed values were
 * masked at recording time, so every fill carries a placeholder naming its
 * field — `<value for data-field="po_number">` — for the author to replace.
 */
import {
  applyMutation,
  attr,
  indexTree,
  type NodeIndex,
  type SerializedNode,
  visibleText
} from './session-replay-script.js'

/** The golden-path recorder's step (admin/src/lib/e2e-recorder.ts). */
export type SpecStep =
  | { kind: 'goto'; path: string; at: number }
  | {
      kind: 'click'
      selector: string
      role?: { role: string; name: string }
      label: string
      at: number
    }
  | { kind: 'fill'; selector: string; value: string; label: string; at: number }
  | { kind: 'select'; selector: string; value: string; label: string; at: number }

export interface SpecPlan {
  steps: SpecStep[]
  /** The recording's viewport (its first Meta event). */
  viewport: { width: number; height: number } | null
  /** The page origin the recording ran on, from the Meta href. */
  origin: string | null
  /** Fills whose value is a placeholder (every one: inputs are masked). */
  placeholders: number
  /** Interactions whose node was not in the snapshot. */
  unresolved: number
}

type RrwebEvent = { type: number; timestamp: number; data?: Record<string, unknown> }

const MOUSE_CLICK = 2
const SOURCE_MUTATION = 0
const SOURCE_MOUSE = 2
const SOURCE_INPUT = 5

/** Same as the live recorder: framework / state attributes are never hooks. */
const SKIP_ATTR =
  /^data-(state|orientation|highlighted|radix|nvr-|react|v-|headlessui|tip|side|align|slot|rr-)/
const ATTR_VALUE = /^[\w.:/-]{1,60}$/
const TEXT_INPUT_TYPES = new Set([
  '',
  'text',
  'search',
  'email',
  'number',
  'password',
  'url',
  'tel',
  'date',
  'datetime-local',
  'time',
  'month',
  'week'
])

const q = (v: string) => v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')

/** What the live recorder treats as "the thing clicked" — the nearest of these up the tree. */
function isInteractive(n: SerializedNode): boolean {
  const tag = n.tagName ?? ''
  const role = attr(n, 'role') ?? ''
  if (['button', 'a', 'summary', 'select', 'option'].includes(tag)) return true
  if (tag === 'input' && ['checkbox', 'radio', 'submit', 'button'].includes(attr(n, 'type') ?? ''))
    return true
  if (['button', 'link', 'menuitem', 'option', 'tab', 'switch', 'checkbox'].includes(role))
    return true
  return !!attr(n, 'data-testid')
}

/** The nearest interactive element up the tree; failing that, the nearest with a data-* hook. */
function closestInteractive(id: number, index: NodeIndex): number {
  let hooked: number | null = null
  let cur: number | undefined = id
  // A text node is never the target itself: start from its element.
  if (cur != null && !index.nodes.get(cur)?.tagName) cur = index.parents.get(cur)
  const start = cur ?? id
  for (let depth = 0; cur != null && depth < 8; depth++) {
    const n = index.nodes.get(cur)
    if (!n?.tagName) break
    if (isInteractive(n)) return cur
    if (hooked == null && depth < 4 && dataHook(n)) hooked = cur
    cur = index.parents.get(cur)
  }
  return hooked ?? start
}

/** The first usable data-* hook: [data-testid] first, then any short data-* marker. */
function dataHook(n: SerializedNode): { name: string; value: string } | null {
  const testid = attr(n, 'data-testid')
  if (testid) return { name: 'data-testid', value: testid }
  for (const [name, raw] of Object.entries(n.attributes ?? {})) {
    if (!name.startsWith('data-') || SKIP_ATTR.test(name) || typeof raw !== 'string') continue
    if (raw === '' || ATTR_VALUE.test(raw)) return { name, value: raw }
  }
  return null
}

const hookSelector = (h: { name: string; value: string }) =>
  h.value === '' ? `[${h.name}]` : `[${h.name}="${q(h.value)}"]`

/** ARIA role of an element, explicit or implied by its tag. */
function roleOf(n: SerializedNode): string | null {
  const explicit = attr(n, 'role')
  if (explicit) return explicit
  const tag = n.tagName ?? ''
  const type = attr(n, 'type') ?? ''
  if (tag === 'button') return 'button'
  if (tag === 'input' && ['button', 'submit', 'reset'].includes(type)) return 'button'
  if (tag === 'a' && attr(n, 'href')) return 'link'
  if (tag === 'input' && type === 'checkbox') return 'checkbox'
  if (tag === 'input' && type === 'radio') return 'radio'
  if (tag === 'summary') return 'button'
  return null
}

/** Accessible name, as far as the snapshot shows it; masked (asterisk) text is no name. */
function accessibleName(n: SerializedNode, index: NodeIndex): string | null {
  const candidates = [
    attr(n, 'aria-label'),
    visibleText(n, index.nodes),
    attr(n, 'title'),
    n.tagName === 'input' ? attr(n, 'value') : null
  ]
  for (const c of candidates) {
    const s = (c ?? '').replace(/\s+/g, ' ').trim()
    if (s && s.length <= 50 && !/^\*+$/.test(s)) return s
  }
  return null
}

const usableId = (id: string | null) =>
  !!id && /^[A-Za-z][\w-]*$/.test(id) && !/^(radix|react|:r)/.test(id)

/** A short structural path, anchored at the nearest ancestor with an id or a data hook. */
function cssPath(id: number, index: NodeIndex): string {
  const parts: string[] = []
  let cur: number | undefined = id
  for (let depth = 0; cur != null && depth < 6; depth++) {
    const n = index.nodes.get(cur)
    if (!n?.tagName || n.tagName === 'body' || n.tagName === 'html') break
    const nid = attr(n, 'id')
    if (depth > 0 && usableId(nid)) {
      parts.unshift(`#${nid}`)
      break
    }
    const hook = depth > 0 ? dataHook(n) : null
    if (hook) {
      parts.unshift(hookSelector(hook))
      break
    }
    const parentId = index.parents.get(cur)
    const parent = parentId != null ? index.nodes.get(parentId) : undefined
    const same = (parent?.childNodes ?? []).filter((c) => c.tagName === n.tagName)
    const pos = same.findIndex((c) => c.id === cur)
    parts.unshift(same.length > 1 && pos >= 0 ? `${n.tagName}:nth-of-type(${pos + 1})` : n.tagName)
    cur = parentId
  }
  return parts.join(' > ')
}

export interface Target {
  selector: string
  role?: { role: string; name: string }
  /** How the field is named in a fill placeholder: `data-field="po_number"`. */
  describe: string
  label: string
}

/** The best selector for a node, in the order the file header gives. */
export function targetFor(id: number, index: NodeIndex, forFill = false): Target | null {
  const n = index.nodes.get(id)
  if (!n?.tagName) return null
  const tag = n.tagName
  const hook = dataHook(n)
  const label = (
    accessibleName(n, index) ??
    attr(n, 'placeholder') ??
    attr(n, 'name') ??
    (hook?.value || null) ??
    tag
  ).slice(0, 40)

  if (hook) {
    const describe = hook.value === '' ? hook.name : `${hook.name}="${hook.value}"`
    return { selector: hookSelector(hook), describe, label }
  }
  // Role + name: what a person sees, and what survives a re-render. Fills
  // render as a locator, so a role only serves clicks.
  const role = roleOf(n)
  const name = role ? accessibleName(n, index) : null
  if (!forFill && role && name) {
    const selector =
      role === 'link'
        ? `a:has-text("${q(name)}")`
        : role === 'button'
          ? `${tag === 'input' ? 'input' : 'button'}:has-text("${q(name)}")`
          : `[role="${q(role)}"]:has-text("${q(name)}")`
    return { selector, role: { role, name }, describe: `${role} "${name}"`, label }
  }
  const nid = attr(n, 'id')
  if (usableId(nid)) return { selector: `#${nid}`, describe: `#${nid}`, label }
  const aria = attr(n, 'aria-label')
  if (aria && aria.length <= 60) {
    return { selector: `[aria-label="${q(aria)}"]`, describe: `"${aria}"`, label }
  }
  const nameAttr = attr(n, 'name')
  if (nameAttr && ['input', 'textarea', 'select'].includes(tag)) {
    return {
      selector: `${tag}[name="${q(nameAttr)}"]`,
      describe: `name="${nameAttr}"`,
      label
    }
  }
  const ph = attr(n, 'placeholder')
  if (ph && ph.length <= 50) {
    return { selector: `[placeholder="${q(ph)}"]`, describe: `"${ph}"`, label }
  }
  const path = cssPath(id, index)
  return path ? { selector: path, describe: path, label } : null
}

export const placeholderFor = (t: Target) => `<value for ${t.describe}>`

/** The path + query of a page URL; null for anything that is not an http(s) page (about:blank). */
function pathOf(href: string): string | null {
  if (href.startsWith('/')) return href
  try {
    const u = new URL(href)
    return /^https?:$/.test(u.protocol) ? u.pathname + u.search : null
  } catch {
    return null
  }
}

function originOf(href: string): string | null {
  try {
    const u = new URL(href)
    return /^https?:$/.test(u.protocol) ? u.origin : null
  } catch {
    return null
  }
}

/**
 * The steps between `fromMs` and `toMs` (offsets from the recording's first
 * event; omitted = the whole recording). Every event before `fromMs` still
 * walks, so the node index is right when the window opens, and the window
 * opens with a goto to the page the person was on.
 */
export function buildSpecPlan(
  input: RrwebEvent[],
  fromMs?: number | null,
  toMs?: number | null
): SpecPlan {
  const events = [...input].sort((a, b) => a.timestamp - b.timestamp)
  const t0 = events[0]?.timestamp ?? 0
  const fromTs = t0 + Math.max(0, fromMs ?? 0)
  const toTs = toMs == null ? Number.POSITIVE_INFINITY : t0 + toMs
  let index: NodeIndex = { nodes: new Map(), parents: new Map() }
  const steps: SpecStep[] = []
  let viewport: SpecPlan['viewport'] = null
  let origin: string | null = null
  let currentPath: string | null = null
  let opened = false
  let unresolved = 0
  // Typing collapses into one fill per field until something else happens.
  const typing: { id: number | null } = { id: null }

  const openWindow = (at: number) => {
    if (opened) return
    opened = true
    if (currentPath) steps.push({ kind: 'goto', path: currentPath, at })
  }
  const goto = (path: string, at: number) => {
    if (path === currentPath) return
    currentPath = path
    if (!opened) return
    typing.id = null
    const last = steps[steps.length - 1]
    // Back-to-back navigations (a redirect chain) keep only the last.
    if (last?.kind === 'goto') steps[steps.length - 1] = { kind: 'goto', path, at }
    else steps.push({ kind: 'goto', path, at })
  }

  for (const e of events) {
    if (e.timestamp > toTs) break
    const inWindow = e.timestamp >= fromTs
    if (inWindow) openWindow(e.timestamp)

    if (e.type === 4) {
      const href = String(e.data?.href ?? '')
      if (!viewport) {
        const w = Number(e.data?.width)
        const h = Number(e.data?.height)
        if (w > 0 && h > 0) viewport = { width: w, height: h }
      }
      const path = pathOf(href)
      if (path) {
        origin = origin ?? originOf(href)
        goto(path, e.timestamp)
      }
      continue
    }
    if (e.type === 2) {
      const root = (e.data as { node?: SerializedNode } | undefined)?.node
      if (root) index = indexTree(root)
      continue
    }
    // The admin recorder's SPA route changes (pushState) ride as custom events.
    if (e.type === 5) {
      const d = e.data as { tag?: string; payload?: { path?: unknown } } | undefined
      const path = d?.tag === 'route' ? pathOf(String(d.payload?.path ?? '')) : null
      if (path) goto(path, e.timestamp)
      continue
    }
    if (e.type !== 3) continue
    const source = Number(e.data?.source)
    if (source === SOURCE_MUTATION) {
      applyMutation(index, e.data ?? {})
      continue
    }
    if (!inWindow) continue

    if (source === SOURCE_MOUSE && Number(e.data?.type) === MOUSE_CLICK) {
      const raw = Number(e.data?.id)
      const node = index.nodes.get(raw)
      if (!node) {
        unresolved++
        continue
      }
      const id = closestInteractive(raw, index)
      const target = index.nodes.get(id)
      const tag = target?.tagName ?? ''
      // A click into a text field only focuses it: the fill that follows says it all.
      if (
        tag === 'textarea' ||
        (tag === 'input' && TEXT_INPUT_TYPES.has(attr(target as SerializedNode, 'type') ?? '')) ||
        tag === 'select' ||
        tag === 'option'
      )
        continue
      const t = targetFor(id, index)
      if (!t) {
        unresolved++
        continue
      }
      typing.id = null
      steps.push({
        kind: 'click',
        selector: t.selector,
        ...(t.role ? { role: t.role } : {}),
        label: t.label,
        at: e.timestamp
      })
      continue
    }

    if (source === SOURCE_INPUT) {
      const id = Number(e.data?.id)
      const node = index.nodes.get(id)
      if (!node?.tagName) {
        unresolved++
        continue
      }
      const type = attr(node, 'type') ?? ''
      // Ticking a box is the click already recorded.
      if (node.tagName === 'input' && (type === 'checkbox' || type === 'radio')) continue
      if (typing.id === id) continue
      const t = targetFor(id, index, true)
      if (!t) {
        unresolved++
        continue
      }
      const step: SpecStep =
        node.tagName === 'select'
          ? {
              kind: 'select',
              selector: t.selector,
              value: placeholderFor(t),
              label: t.label,
              at: e.timestamp
            }
          : {
              kind: 'fill',
              selector: t.selector,
              value: placeholderFor(t),
              label: t.label,
              at: e.timestamp
            }
      steps.push(step)
      typing.id = id
    }
  }
  if (!opened) openWindow(fromTs)

  return {
    steps,
    viewport,
    origin,
    placeholders: steps.filter((s) => s.kind === 'fill' || s.kind === 'select').length,
    unresolved
  }
}
