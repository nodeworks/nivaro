/**
 * Node map for the heatmap fold (#1364): rrweb events → "which element was
 * that node id?" without a DOM.
 *
 * An rrweb recording names every node by a numeric mirror id. The full
 * snapshot (event type 2) is the serialised tree; mutations (type 3, source 0)
 * add, remove and re-attribute nodes after it. This keeps a flat id → node
 * map current through both, so a click (which carries only the id) can be
 * turned into a selector that means the same element in every session:
 * `button:has-text("Save")`, `[data-testid="queue-filter"]`, `a[aria-label="Home"]`.
 *
 * The selector is built for AGGREGATION, not for replaying: it prefers what
 * is stable across people and records (test hooks, labels, short button
 * text) and avoids what identifies a record (text with digits, link text,
 * generated ids). A click inside a button's icon counts for the button.
 *
 * Pure: no db, no I/O. (A separate node map for the replay index lives in its
 * own module; this one only needs what the heat fold needs.)
 */

/** rrweb serialised node types. */
const NODE_DOCUMENT = 0
const NODE_ELEMENT = 2
const NODE_TEXT = 3

export interface SerializedNodeLike {
  id: number
  type: number
  tagName?: string
  attributes?: Record<string, unknown>
  childNodes?: SerializedNodeLike[]
  textContent?: string
}

export interface MapNode {
  id: number
  type: number
  tag: string | null
  attrs: Record<string, string>
  parent: number | null
  children: number[]
  text: string | null
}

export interface RrwebEventLike {
  type: number
  timestamp: number
  data?: Record<string, unknown>
}

/** Elements a click means to hit (by tag or role); a click on a child of one counts for it. */
const TARGET_TAGS = new Set([
  'button',
  'a',
  'input',
  'select',
  'textarea',
  'label',
  'summary',
  'option'
])
const TARGET_ROLES = new Set([
  'button',
  'link',
  'tab',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'checkbox',
  'radio',
  'switch',
  'option',
  'combobox',
  'treeitem'
])
/** Whose visible text is a fair name for them (link text often names a record). */
const TEXT_NAMED_TAGS = new Set(['button', 'summary'])
const TEXT_NAMED_ROLES = new Set(['button', 'tab', 'menuitem', 'switch'])
/** How far up a click may climb to find the element it meant. */
const CLIMB = 6

const q = (v: string) => v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')

/** An id or label that is generated (React's :r1:, radix-123, uuids) is not identity. */
function stableToken(v: string | undefined | null, max = 60): string | null {
  if (!v) return null
  const s = v.trim()
  if (!s || s.length > max) return null
  if (/\d/.test(s) || s.includes(':') || s.includes('@')) return null
  return s
}

/** Text that names a control rather than a record: short, no digits, no addresses. */
function stableText(v: string): string | null {
  const s = v.replace(/\s+/g, ' ').trim()
  if (!s || s.length > 30) return null
  if (/\d/.test(s) || s.includes('@')) return null
  return s
}

export class ReplayNodeMap {
  readonly nodes = new Map<number, MapNode>()

  /** Replace the map with a full snapshot's tree. */
  reset(root: SerializedNodeLike): void {
    this.nodes.clear()
    this.addTree(root, null)
  }

  private addTree(node: SerializedNodeLike, parent: number | null): void {
    if (node == null || typeof node.id !== 'number') return
    const existing = this.nodes.get(node.id)
    if (existing && existing.parent != null && existing.parent !== parent) {
      this.detach(node.id)
    }
    const attrs: Record<string, string> = {}
    for (const [k, v] of Object.entries(node.attributes ?? {})) {
      if (typeof v === 'string') attrs[k] = v
      else if (typeof v === 'number' || typeof v === 'boolean') attrs[k] = String(v)
    }
    const children: number[] = []
    this.nodes.set(node.id, {
      id: node.id,
      type: node.type,
      tag: node.tagName ? node.tagName.toLowerCase() : null,
      attrs,
      parent,
      children,
      text:
        node.type === NODE_TEXT && typeof node.textContent === 'string' ? node.textContent : null
    })
    for (const child of node.childNodes ?? []) {
      children.push(child.id)
      this.addTree(child, node.id)
    }
  }

  private detach(id: number): void {
    const n = this.nodes.get(id)
    if (!n || n.parent == null) return
    const p = this.nodes.get(n.parent)
    if (p) p.children = p.children.filter((c) => c !== id)
  }

  private removeTree(id: number): void {
    const n = this.nodes.get(id)
    if (!n) return
    for (const c of n.children) this.removeTree(c)
    this.nodes.delete(id)
  }

  /** Apply one incremental mutation (event type 3, source 0). */
  applyMutation(data: Record<string, unknown>): void {
    const removes = (data.removes ?? []) as Array<{ parentId?: number; id?: number }>
    for (const r of removes) {
      if (typeof r?.id !== 'number') continue
      this.detach(r.id)
      this.removeTree(r.id)
    }
    const adds = (data.adds ?? []) as Array<{
      parentId?: number
      nextId?: number | null
      node?: SerializedNodeLike
    }>
    for (const a of adds) {
      if (!a?.node || typeof a.node.id !== 'number') continue
      const parentId = typeof a.parentId === 'number' ? a.parentId : null
      this.addTree(a.node, parentId)
      const parent = parentId != null ? this.nodes.get(parentId) : undefined
      if (parent && !parent.children.includes(a.node.id)) {
        const at = a.nextId != null ? parent.children.indexOf(a.nextId) : -1
        if (at >= 0) parent.children.splice(at, 0, a.node.id)
        else parent.children.push(a.node.id)
      }
    }
    const attributes = (data.attributes ?? []) as Array<{
      id?: number
      attributes?: Record<string, unknown>
    }>
    for (const a of attributes) {
      const n = typeof a?.id === 'number' ? this.nodes.get(a.id) : undefined
      if (!n) continue
      for (const [k, v] of Object.entries(a.attributes ?? {})) {
        if (v == null) delete n.attrs[k]
        else if (typeof v === 'string' || typeof v === 'number') n.attrs[k] = String(v)
      }
    }
    const texts = (data.texts ?? []) as Array<{ id?: number; value?: unknown }>
    for (const t of texts) {
      const n = typeof t?.id === 'number' ? this.nodes.get(t.id) : undefined
      if (n) n.text = typeof t.value === 'string' ? t.value : null
    }
  }

  /** Feed any rrweb event: full snapshots reset, mutations apply, the rest is ignored. */
  ingest(event: RrwebEventLike): void {
    if (event.type === 2) {
      const root = (event.data as { node?: SerializedNodeLike } | undefined)?.node
      if (root) this.reset(root)
    } else if (event.type === 3 && Number(event.data?.source) === 0 && event.data) {
      this.applyMutation(event.data)
    }
  }

  /** The document node's id (window scrolls report it), or null. */
  documentId(): number | null {
    for (const n of this.nodes.values()) if (n.type === NODE_DOCUMENT) return n.id
    return null
  }

  /** Visible text under a node, shallowly (enough to name a button). */
  textOf(id: number, depth = 0): string {
    const n = this.nodes.get(id)
    if (!n || depth > 4) return ''
    if (n.type === NODE_TEXT) return n.text ?? ''
    if (n.tag === 'script' || n.tag === 'style' || n.tag === 'svg') return ''
    let out = ''
    for (const c of n.children) {
      out += this.textOf(c, depth + 1)
      if (out.length > 80) break
    }
    return out
  }

  private isTarget(n: MapNode): boolean {
    if (n.type !== NODE_ELEMENT || !n.tag) return false
    if (TARGET_TAGS.has(n.tag)) return true
    // A data-testid alone does not make a target: containers carry them
    // too, and one would swallow every click inside it.
    return !!n.attrs.role && TARGET_ROLES.has(n.attrs.role)
  }

  /** The element a click on `id` meant: the nearest target ancestor, else the element itself. */
  clickTarget(id: number): MapNode | null {
    let n = this.nodes.get(id)
    if (n && n.type === NODE_TEXT && n.parent != null) n = this.nodes.get(n.parent)
    const self = n && n.type === NODE_ELEMENT ? n : null
    let cur = self
    for (let i = 0; cur && i <= CLIMB; i++) {
      if (this.isTarget(cur)) return cur
      cur = cur.parent != null ? (this.nodes.get(cur.parent) ?? null) : null
      if (cur && (cur.tag === 'body' || cur.tag === 'html')) break
    }
    return self
  }

  /** Identity of one element on its own, or null when it has none worth keeping. */
  private ownIdentity(n: MapNode): string | null {
    const tag = n.tag ?? '*'
    const testid = stableToken(n.attrs['data-testid'], 80)
    if (testid) return `[data-testid="${q(testid)}"]`
    const id = stableToken(n.attrs.id)
    if (id) return `#${id}`
    const aria = stableToken(n.attrs['aria-label'])
    if (aria) return `${tag}[aria-label="${q(aria)}"]`
    const name = stableToken(n.attrs.name)
    if (name) return `${tag}[name="${q(name)}"]`
    const role = n.attrs.role ?? ''
    if (TEXT_NAMED_TAGS.has(tag) || TEXT_NAMED_ROLES.has(role)) {
      const text = stableText(this.textOf(n.id))
      if (text)
        return `${role && !TEXT_NAMED_TAGS.has(tag) ? `${tag}[role="${role}"]` : tag}:has-text("${q(text)}")`
    }
    return null
  }

  /**
   * A selector for the element a click on `id` meant, built to aggregate:
   * its own identity when it has one, else `<anchor> <tag>` under the
   * nearest ancestor that has identity, else the bare tag (with its role).
   */
  selectorFor(id: number): string | null {
    const target = this.clickTarget(id)
    if (!target?.tag) return null
    const own = this.ownIdentity(target)
    if (own) return own.slice(0, 300)
    const bare = target.attrs.role ? `${target.tag}[role="${q(target.attrs.role)}"]` : target.tag
    if (target.tag === 'input' && target.attrs.type) {
      const type = stableToken(target.attrs.type)
      if (type) return `input[type="${q(type)}"]`
    }
    let cur = target.parent != null ? this.nodes.get(target.parent) : undefined
    for (let i = 0; cur && i < 8; i++) {
      if (cur.tag === 'body' || cur.tag === 'html') break
      if (cur.type === NODE_ELEMENT) {
        const anchor = this.ownIdentity(cur)
        if (anchor) return `${anchor} ${bare}`.slice(0, 300)
      }
      cur = cur.parent != null ? this.nodes.get(cur.parent) : undefined
    }
    return bare.slice(0, 300)
  }
}
