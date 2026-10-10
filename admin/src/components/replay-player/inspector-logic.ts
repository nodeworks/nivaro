/**
 * Element inspector (#1372) — the pure half: what an element in the replay
 * DOM is called (selector, data-* hooks, nearest data-field / data-cbv-*
 * ancestor) and the geometry between the scaled replay iframe and the
 * overlay that takes the clicks.
 *
 * KEEP IN STEP with api/src/services/session-replay-index.ts: the server
 * indexes the selector of every element clicked or typed into, built by the
 * same rules from the recording's snapshot, and "Find in other recordings"
 * searches for the string built here. Both test files share the vectors.
 */

/** What the selector rules need from a node: a live element or a snapshot entry. */
export interface HookNode {
  tag: string
  attr(name: string): string | null
  attrNames(): string[]
  parent(): HookNode | null
}

/** Attribute values a selector may quote. */
const SAFE_VALUE = /^[\w.:/-]{1,64}$/
/** Values that name one record — a selector carrying them matches nothing elsewhere. */
const ID_LIKE =
  /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|\d+|[0-9a-f]{16,})$/i
const CBV_ATTR = /^data-cbv-[a-z0-9-]{1,48}$/
const STABLE_ID = /^[A-Za-z][\w-]{0,63}$/
/** Library-generated ids (radix-:r3:, headlessui-menu-12…) change per render. */
const GENERATED_ID = /^(?:radix-|headlessui-|react-|rc-|mui-|downshift-|tippy-|rr-)|\d{3,}/
const SAFE_TOKEN = /^[a-z][a-z0-9-]{0,23}$/
const MAX_ANCESTORS = 25

/** The element's own stable hook as a selector, or null. */
export function hookOf(n: HookNode): string | null {
  const testid = n.attr('data-testid')
  if (testid && SAFE_VALUE.test(testid)) return `[data-testid="${testid}"]`
  const field = n.attr('data-field')
  if (field && SAFE_VALUE.test(field)) return `[data-field="${field}"]`
  const cbv = n
    .attrNames()
    .filter((a) => CBV_ATTR.test(a))
    .sort()[0]
  if (cbv) {
    const v = n.attr(cbv) ?? ''
    return v && v.length <= 40 && SAFE_VALUE.test(v) && !ID_LIKE.test(v)
      ? `[${cbv}="${v}"]`
      : `[${cbv}]`
  }
  const id = n.attr('id')
  if (id && STABLE_ID.test(id) && !GENERATED_ID.test(id)) return `#${id}`
  return null
}

/** Tag plus the qualifiers that say what kind of control it is. */
function partOf(n: HookNode): string {
  let s = n.tag
  const name = n.attr('name')
  if (name && SAFE_VALUE.test(name) && /^(input|select|textarea|button)$/.test(n.tag)) {
    s += `[name="${name}"]`
  }
  const type = n.tag === 'input' ? n.attr('type')?.toLowerCase() : null
  if (type && SAFE_TOKEN.test(type)) s += `[type="${type}"]`
  const role = n.attr('role')?.toLowerCase()
  if (role && SAFE_TOKEN.test(role)) s += `[role="${role}"]`
  return s
}

/**
 * A selector for the element: its own hook, else the nearest hooked
 * ancestor + its tag and kind. `anchored` is false when no hook was found —
 * a bare `button` is shown but cannot be searched for.
 */
export function selectorFor(n: HookNode): { selector: string; anchored: boolean } {
  const own = hookOf(n)
  if (own) return { selector: own, anchored: true }
  const part = partOf(n)
  let p = n.parent()
  for (let d = 0; p && d < MAX_ANCESTORS; d++, p = p.parent()) {
    const h = hookOf(p)
    if (h) return { selector: `${h} ${part}`, anchored: true }
  }
  return { selector: part, anchored: false }
}

/** The nearest `data-field` name on the element or an ancestor. */
export function nearestDataField(n: HookNode): string | null {
  let p: HookNode | null = n
  for (let d = 0; p && d <= MAX_ANCESTORS; d++, p = p.parent()) {
    const f = p.attr('data-field')
    if (f && SAFE_VALUE.test(f)) return f
  }
  return null
}

// ── DOM side ─────────────────────────────────────────────────────────────────

export function domHookNode(el: Element): HookNode {
  return {
    tag: el.tagName.toLowerCase(),
    attr: (name) => el.getAttribute(name),
    attrNames: () => el.getAttributeNames(),
    parent: () => (el.parentElement ? domHookNode(el.parentElement) : null)
  }
}

export interface ElementInfo {
  tag: string
  selector: string
  /** False: no stable hook on it or above it — not searchable across recordings. */
  anchored: boolean
  /** The element's own data-* attributes (values cut to 80 characters). */
  dataAttrs: Array<[string, string]>
  /** Nearest data-field (self or ancestor): its name and its selector. */
  field: { name: string; selector: string } | null
  /** Nearest data-cbv-* hook (self or ancestor). */
  cbv: { attr: string; value: string; selector: string } | null
}

const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s)

/** Everything the inspector panel shows for one element — never its text or value. */
export function describeElement(el: Element): ElementInfo {
  const node = domHookNode(el)
  const { selector, anchored } = selectorFor(node)
  const dataAttrs = el
    .getAttributeNames()
    .filter((a) => a.startsWith('data-') && !a.startsWith('data-rr'))
    .sort()
    .map((a): [string, string] => [a, cut(el.getAttribute(a) ?? '', 80)])
  let field: ElementInfo['field'] = null
  let cbv: ElementInfo['cbv'] = null
  let cur: Element | null = el
  for (let d = 0; cur && d <= MAX_ANCESTORS && (!field || !cbv); d++, cur = cur.parentElement) {
    if (!field) {
      const f = cur.getAttribute('data-field')
      if (f && SAFE_VALUE.test(f)) field = { name: f, selector: `[data-field="${f}"]` }
    }
    if (!cbv) {
      const a = cur
        .getAttributeNames()
        .filter((x) => CBV_ATTR.test(x))
        .sort()[0]
      if (a) {
        cbv = {
          attr: a,
          value: cut(cur.getAttribute(a) ?? '', 80),
          selector: hookOf(domHookNode(cur)) ?? `[${a}]`
        }
      }
    }
  }
  return { tag: node.tag, selector, anchored, dataAttrs, field, cbv }
}

// ── Geometry ─────────────────────────────────────────────────────────────────

type RectLike = { left: number; top: number; width: number; height: number }

/** The replay iframe is drawn scaled (a CSS transform on rrweb's wrapper). */
export function frameScale(iframeRect: RectLike, layoutWidth: number): number {
  return layoutWidth > 0 && iframeRect.width > 0 ? iframeRect.width / layoutWidth : 1
}

/** A pointer position on the page → coordinates inside the replay iframe, or null outside it. */
export function pointInFrame(
  clientX: number,
  clientY: number,
  iframeRect: RectLike,
  scale: number
): { x: number; y: number } | null {
  const x = (clientX - iframeRect.left) / scale
  const y = (clientY - iframeRect.top) / scale
  if (x < 0 || y < 0 || x > iframeRect.width / scale || y > iframeRect.height / scale) return null
  return { x, y }
}

/** An element's box inside the iframe → a box in the overlay's coordinates. */
export function boxInOverlay(
  elRect: RectLike,
  iframeRect: RectLike,
  overlayRect: { left: number; top: number },
  scale: number
): RectLike {
  return {
    left: iframeRect.left - overlayRect.left + elRect.left * scale,
    top: iframeRect.top - overlayRect.top + elRect.top * scale,
    width: elRect.width * scale,
    height: elRect.height * scale
  }
}
