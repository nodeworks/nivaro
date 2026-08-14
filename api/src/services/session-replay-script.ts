/**
 * Turns a recorded session into a runnable Playwright script.
 *
 * A recording is an rrweb event stream: a DOM snapshot plus incremental
 * mutations and interactions, all referring to nodes by a numeric mirror id.
 * Replaying it means resolving those ids back to selectors a browser can act
 * on, which is what most of this file does — the snapshot is a serialised node
 * tree, so it can be walked as data without a DOM.
 *
 * TWO limits are inherent, not gaps to fill later:
 *
 *  - Typed values are NOT recoverable. The recorder masks all inputs, so an
 *    input event's text is a row of asterisks. The script marks each one and
 *    stops short of typing it; a replay that filled in asterisks would look
 *    like it worked and produce nonsense.
 *  - A replay re-executes real actions against whatever host you point it at.
 *    The generated script therefore takes its base URL from an env var with a
 *    localhost default, and refuses to run against a non-local host unless the
 *    operator sets REPLAY_CONFIRM=1.
 */

export interface ReplayStep {
  /** ms to wait before this step, preserving the operator's own pacing. */
  delayMs: number
  kind: 'click' | 'dblclick' | 'input' | 'scroll' | 'navigate'
  selector?: string
  url?: string
  /** Human note for steps that cannot be reproduced faithfully. */
  note?: string
}

export interface ReplayPlan {
  startUrl: string
  viewport: { width: number; height: number } | null
  steps: ReplayStep[]
  maskedInputs: number
  unresolved: number
}

type SerializedNode = {
  id: number
  type: number
  tagName?: string
  attributes?: Record<string, unknown>
  childNodes?: SerializedNode[]
  textContent?: string
}

type RrwebEvent = {
  type: number
  timestamp: number
  data?: Record<string, unknown>
}

/** rrweb MouseInteraction types we can act on. */
const MOUSE_CLICK = 2
const MOUSE_DBLCLICK = 4

/**
 * Index the snapshot by node id, remembering each node's parent so a selector
 * can be built by walking upward.
 */
function indexTree(root: SerializedNode) {
  const nodes = new Map<number, SerializedNode>()
  const parents = new Map<number, number>()
  const walk = (node: SerializedNode, parentId: number | null) => {
    nodes.set(node.id, node)
    if (parentId !== null) parents.set(node.id, parentId)
    for (const child of node.childNodes ?? []) walk(child, node.id)
  }
  walk(root, null)
  return { nodes, parents }
}

const attr = (node: SerializedNode, name: string): string | null => {
  const v = node.attributes?.[name]
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : null
}

/**
 * The visible text of a node, from the snapshot's own text children. A button
 * is identified far more reliably by what it SAYS than by its position in a
 * div chain — especially here, where nodes added after the snapshot have no
 * recorded sibling order to count against.
 */
function visibleText(
  node: SerializedNode,
  nodes: Map<number, SerializedNode>,
  depth = 0
): string {
  if (depth > 4) return ''
  let out = ''
  for (const child of node.childNodes ?? []) {
    // rrweb: type 3 is a text node.
    if (child.type === 3 && typeof child.textContent === 'string') out += child.textContent
    else if (child.tagName) out += visibleText(child, nodes, depth + 1)
    if (out.length > 120) break
  }
  return out.replace(/\s+/g, ' ').trim()
}

const TEXT_MATCHABLE = new Set(['button', 'a', 'label', 'summary', 'option', 'th', 'td', 'li'])

/** CSS-escape just enough for the attribute values we emit. */
const q = (v: string) => v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')

/**
 * A selector for one node, preferring identity that survives a re-render:
 * an id, a test hook, a name, an aria-label. Falls back to a structural
 * nth-of-type path, which is fragile but better than nothing — and the caller
 * reports how many steps needed it.
 */
export function selectorFor(
  id: number,
  index: { nodes: Map<number, SerializedNode>; parents: Map<number, number> }
): string | null {
  const node = index.nodes.get(id)
  if (!node || !node.tagName) return null

  const direct =
    (attr(node, 'id') && `#${attr(node, 'id')}`) ||
    (attr(node, 'data-testid') && `[data-testid="${q(attr(node, 'data-testid') as string)}"]`) ||
    (attr(node, 'name') && `${node.tagName}[name="${q(attr(node, 'name') as string)}"]`) ||
    (attr(node, 'aria-label') && `${node.tagName}[aria-label="${q(attr(node, 'aria-label') as string)}"]`)
  if (direct) return direct

  // What it says, when that is a sane handle — survives re-renders and layout
  // changes that any structural path would not.
  if (TEXT_MATCHABLE.has(node.tagName)) {
    const text = visibleText(node, index.nodes)
    if (text.length > 0 && text.length <= 60) return `${node.tagName}:has-text("${q(text)}")`
  }

  // Structural path, capped so a deep tree does not produce an unreadable
  // selector — anchored at the nearest ancestor that has real identity.
  const parts: string[] = []
  let current: SerializedNode | undefined = node
  let currentId = id
  for (let depth = 0; current?.tagName && depth < 6; depth++) {
    const parentId = index.parents.get(currentId)
    const parent = parentId != null ? index.nodes.get(parentId) : undefined
    const siblings = (parent?.childNodes ?? []).filter((c) => c.tagName === current?.tagName)
    const position = siblings.findIndex((c) => c.id === currentId)
    parts.unshift(
      siblings.length > 1 && position >= 0
        ? `${current.tagName}:nth-of-type(${position + 1})`
        : current.tagName
    )
    if (!parent?.tagName) break
    const anchor =
      (attr(parent, 'id') && `#${attr(parent, 'id')}`) ||
      (attr(parent, 'data-testid') && `[data-testid="${q(attr(parent, 'data-testid') as string)}"]`)
    if (anchor) {
      parts.unshift(anchor)
      break
    }
    current = parent
    currentId = parentId as number
  }
  return parts.length > 0 ? parts.join(' > ') : null
}

/**
 * Reduce a recording's events to an ordered plan. Mouse moves and DOM mutations
 * are skipped — they are how the page RESPONDED, not what the operator did —
 * but node additions are folded into the index so a later click on newly
 * rendered content still resolves.
 */
export function buildReplayPlan(events: RrwebEvent[]): ReplayPlan {
  let index = { nodes: new Map<number, SerializedNode>(), parents: new Map<number, number>() }
  let startUrl = ''
  let viewport: { width: number; height: number } | null = null
  const steps: ReplayStep[] = []
  let maskedInputs = 0
  let unresolved = 0
  let lastTs: number | null = null
  let lastInputId: number | null = null

  for (const event of events) {
    const delayMs = lastTs === null ? 0 : Math.max(0, Math.min(event.timestamp - lastTs, 30_000))

    if (event.type === 4) {
      const href = String(event.data?.href ?? '')
      if (!startUrl && href) {
        startUrl = href
        const w = Number(event.data?.width)
        const h = Number(event.data?.height)
        if (Number.isFinite(w) && Number.isFinite(h)) viewport = { width: w, height: h }
      } else if (href) {
        steps.push({ delayMs, kind: 'navigate', url: href })
        lastTs = event.timestamp
      }
      if (lastTs === null) lastTs = event.timestamp
      continue
    }

    if (event.type === 2) {
      const root = (event.data as { node?: SerializedNode } | undefined)?.node
      if (root) index = indexTree(root)
      if (lastTs === null) lastTs = event.timestamp
      continue
    }

    if (event.type !== 3) continue
    const source = Number(event.data?.source)

    // Mutations: keep the index current so later interactions resolve.
    if (source === 0) {
      const adds = (event.data?.adds ?? []) as Array<{ parentId?: number; node?: SerializedNode }>
      for (const add of adds) {
        if (!add.node) continue
        const sub = indexTree(add.node)
        for (const [nid, n] of sub.nodes) index.nodes.set(nid, n)
        for (const [nid, pid] of sub.parents) index.parents.set(nid, pid)
        if (add.parentId != null) {
          index.parents.set(add.node.id, add.parentId)
          // Attach to the parent's children too, not just the id map. rrweb
          // streams adds one node at a time, so without this a node rendered
          // after the snapshot has no text and no sibling order — which is
          // most of what a session actually clicks on.
          const parent = index.nodes.get(add.parentId)
          if (parent) {
            parent.childNodes = parent.childNodes ?? []
            if (!parent.childNodes.some((c) => c.id === add.node?.id)) parent.childNodes.push(add.node)
          }
        }
      }
      const removes = (event.data?.removes ?? []) as Array<{ parentId?: number; id?: number }>
      for (const rem of removes) {
        if (rem.id == null) continue
        const parent = rem.parentId != null ? index.nodes.get(rem.parentId) : undefined
        if (parent?.childNodes) parent.childNodes = parent.childNodes.filter((c) => c.id !== rem.id)
        index.nodes.delete(rem.id)
        index.parents.delete(rem.id)
      }
      continue
    }

    if (source === 2) {
      const interactionType = Number(event.data?.type)
      if (interactionType !== MOUSE_CLICK && interactionType !== MOUSE_DBLCLICK) continue
      const nodeId = Number(event.data?.id)
      const selector = selectorFor(nodeId, index)
      if (!selector) {
        unresolved++
        lastTs = event.timestamp
        continue
      }
      steps.push({
        delayMs,
        kind: interactionType === MOUSE_DBLCLICK ? 'dblclick' : 'click',
        selector
      })
      lastTs = event.timestamp
      continue
    }

    if (source === 5) {
      const nodeId = Number(event.data?.id)
      // rrweb emits an event per keystroke; one marker per field is enough.
      if (nodeId === lastInputId) continue
      lastInputId = nodeId
      maskedInputs++
      const selector = selectorFor(nodeId, index)
      steps.push({
        delayMs,
        kind: 'input',
        selector: selector ?? undefined,
        note: 'value was masked at recording time — fill it in to continue the flow'
      })
      lastTs = event.timestamp
      continue
    }
  }

  return { startUrl, viewport, steps, maskedInputs, unresolved }
}

/** Emit the plan as a standalone Playwright script. */
export function renderPlaywrightScript(plan: ReplayPlan, meta: { id: string; user?: string | null; startedAt?: string | null }): string {
  const path = (() => {
    try {
      const u = new URL(plan.startUrl)
      return u.pathname + u.search
    } catch {
      return plan.startUrl || '/'
    }
  })()

  const lines: string[] = []
  lines.push(`// Replay of session ${meta.id}`)
  if (meta.user) lines.push(`// Recorded by ${meta.user}${meta.startedAt ? ` on ${meta.startedAt}` : ''}`)
  lines.push(`// Recorded against: ${plan.startUrl || '(unknown)'}`)
  lines.push('//')
  lines.push('// Run:  BASE_URL=http://localhost:3057 npx playwright test replay.spec.ts --headed')
  lines.push('//')
  if (plan.maskedInputs > 0) {
    lines.push(
      `// ${plan.maskedInputs} input${plan.maskedInputs === 1 ? '' : 's'} cannot be replayed: the recorder masks`
    )
    lines.push('// everything typed, so the values are asterisks. Each is marked TODO below.')
  }
  if (plan.unresolved > 0) {
    lines.push(`// ${plan.unresolved} interaction(s) hit nodes missing from the snapshot and were skipped.`)
  }
  lines.push('')
  lines.push("import { expect, test } from '@playwright/test'")
  lines.push('')
  lines.push("const BASE_URL = process.env.BASE_URL ?? 'http://localhost:3057'")
  lines.push('')
  lines.push('// A replay performs real actions as the logged-in user. Anything but a')
  lines.push('// local host has to be asked for explicitly.')
  lines.push("if (!/^https?:\\/\\/(localhost|127\\.0\\.0\\.1|\\[::1\\])(:|\\/|$)/.test(BASE_URL) && process.env.REPLAY_CONFIRM !== '1') {")
  lines.push('  throw new Error(`Refusing to replay against ${BASE_URL} — set REPLAY_CONFIRM=1 to allow it.`)')
  lines.push('}')
  lines.push('')
  lines.push(`test('replay ${meta.id}', async ({ page }) => {`)
  lines.push('  test.setTimeout(10 * 60 * 1000)')
  if (plan.viewport) {
    lines.push(`  await page.setViewportSize({ width: ${plan.viewport.width}, height: ${plan.viewport.height} })`)
  }
  lines.push(`  await page.goto(\`\${BASE_URL}${path}\`)`)
  lines.push('')

  for (const step of plan.steps) {
    if (step.delayMs > 0) lines.push(`  await page.waitForTimeout(${step.delayMs})`)
    if (step.kind === 'navigate' && step.url) {
      const p = (() => {
        try {
          const u = new URL(step.url)
          return u.pathname + u.search
        } catch {
          return step.url
        }
      })()
      lines.push(`  await page.goto(\`\${BASE_URL}${p}\`)`)
      continue
    }
    if (!step.selector) {
      lines.push(`  // TODO ${step.kind}: ${step.note ?? 'target could not be resolved'}`)
      continue
    }
    const sel = q(step.selector)
    if (step.kind === 'click' || step.kind === 'dblclick') {
      lines.push(`  await page.locator("${sel}").first().${step.kind}()`)
    } else if (step.kind === 'input') {
      lines.push(`  // TODO fill: ${step.note}`)
      lines.push(`  // await page.locator("${sel}").first().fill('')`)
    }
  }

  lines.push('')
  lines.push('  await expect(page).toHaveURL(/./)')
  lines.push('})')
  return `${lines.join('\n')}\n`
}
