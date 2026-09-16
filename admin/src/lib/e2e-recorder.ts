/**
 * Golden-path e2e recorder (#73): a module-level singleton that listens to the
 * admin's own DOM while recording, turns clicks / typing / navigations into
 * steps, and renders them as a Playwright spec. Lives outside React so a
 * recording survives every route change; steps persist in sessionStorage so
 * a full reload (which the admin does on workspace switch) keeps them too.
 *
 * Selector strategy, most stable first: a `data-testid` / any short `data-*`
 * marker → `#id` → `[aria-label]` → role + accessible name for buttons/links
 * (rendered as getByRole) → a CSS path with nth-of-type. Clicks inside the
 * recorder's own UI (`[data-e2e-recorder]`) are never recorded.
 */

export type RecordedStep =
  | { kind: 'goto'; path: string; at: number }
  | {
      kind: 'click'
      selector: string
      role?: { role: string; name: string }
      label: string
      at: number
    }
  | { kind: 'fill'; selector: string; value: string; label: string; at: number }
  | { kind: 'press'; selector: string; key: string; label: string; at: number }
  | { kind: 'select'; selector: string; value: string; label: string; at: number }
  | { kind: 'expect'; selector: string; text: string; label: string; at: number }

interface RecorderState {
  recording: boolean
  startedAt: number | null
  steps: RecordedStep[]
}

const KEY = 'nvr_e2e_recorder'
const listeners = new Set<() => void>()
let state: RecorderState = load()
let armed = false
let lastFill: { el: HTMLElement; selector: string } | null = null

function load(): RecorderState {
  try {
    const raw = sessionStorage.getItem(KEY)
    if (raw) {
      const p = JSON.parse(raw) as RecorderState
      if (p && Array.isArray(p.steps)) return p
    }
  } catch {
    /* fresh */
  }
  return { recording: false, startedAt: null, steps: [] }
}
function persist() {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(state))
  } catch {
    /* storage unavailable — in-memory only */
  }
  for (const l of listeners) l()
}

export function subscribeRecorder(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}
export function getRecorderState(): RecorderState {
  return state
}

// ─── Selectors ──────────────────────────────────────────────────────────────

const SKIP_ATTR = /^data-(state|orientation|highlighted|radix|nvr-|react|v-|headlessui)/
const ATTR_VALUE = /^[\w.:/-]{1,60}$/

function cssEscape(v: string): string {
  return typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(v) : v.replace(/[^\w-]/g, '\\$&')
}

function bestSelector(el: HTMLElement): {
  selector: string
  role?: { role: string; name: string }
} {
  const testid = el.getAttribute('data-testid')
  if (testid) return { selector: `[data-testid="${testid}"]` }
  for (const attr of Array.from(el.attributes)) {
    if (!attr.name.startsWith('data-') || SKIP_ATTR.test(attr.name)) continue
    if (attr.value === '') return { selector: `[${attr.name}]` }
    if (ATTR_VALUE.test(attr.value)) return { selector: `[${attr.name}="${attr.value}"]` }
  }
  if (el.id && /^[A-Za-z][\w-]*$/.test(el.id) && !/^(radix|react|:r)/.test(el.id)) {
    return { selector: `#${cssEscape(el.id)}` }
  }
  const aria = el.getAttribute('aria-label')
  if (aria && aria.length <= 60) return { selector: `[aria-label="${aria.replace(/"/g, '\\"')}"]` }
  const tag = el.tagName.toLowerCase()
  const roleTag =
    tag === 'button' ||
    tag === 'a' ||
    el.getAttribute('role') === 'button' ||
    el.getAttribute('role') === 'link'
  if (roleTag) {
    const name = (el.textContent ?? '').replace(/\s+/g, ' ').trim()
    if (name && name.length <= 50) {
      return {
        selector: `${tag === 'a' || el.getAttribute('role') === 'link' ? 'a' : 'button'}:has-text("${name.replace(/"/g, '\\"')}")`,
        role: { role: tag === 'a' || el.getAttribute('role') === 'link' ? 'link' : 'button', name }
      }
    }
  }
  const name = el.getAttribute('name')
  if (name && (tag === 'input' || tag === 'textarea' || tag === 'select')) {
    return { selector: `${tag}[name="${name}"]` }
  }
  const placeholder = el.getAttribute('placeholder')
  if (placeholder && placeholder.length <= 50) {
    return { selector: `[placeholder="${placeholder.replace(/"/g, '\\"')}"]` }
  }
  return { selector: cssPath(el) }
}

function cssPath(el: HTMLElement): string {
  const parts: string[] = []
  let node: HTMLElement | null = el
  while (node && node !== document.body && parts.length < 6) {
    const tag = node.tagName.toLowerCase()
    let part = tag
    if (node.id && /^[A-Za-z][\w-]*$/.test(node.id) && !/^(radix|react|:r)/.test(node.id)) {
      parts.unshift(`#${cssEscape(node.id)}`)
      break
    }
    const parent: HTMLElement | null = node.parentElement
    if (parent) {
      const same = Array.from(parent.children).filter((c) => c.tagName === node!.tagName)
      if (same.length > 1) part += `:nth-of-type(${same.indexOf(node) + 1})`
    }
    parts.unshift(part)
    node = parent
  }
  return parts.join(' > ')
}

function labelFor(el: HTMLElement): string {
  const text = (el.getAttribute('aria-label') || el.textContent || '').replace(/\s+/g, ' ').trim()
  if (text) return text.slice(0, 40)
  return el.tagName.toLowerCase()
}

function interactive(target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof Element)) return null
  const el = target.closest<HTMLElement>(
    'button, a, [role="button"], [role="link"], [role="menuitem"], [role="option"], [role="tab"], [role="switch"], [role="checkbox"], input[type="checkbox"], input[type="radio"], summary, [data-testid]'
  )
  return el ?? (target instanceof HTMLElement ? target : null)
}

function insideRecorder(target: EventTarget | null): boolean {
  return target instanceof Element && !!target.closest('[data-e2e-recorder]')
}

// ─── Listeners ──────────────────────────────────────────────────────────────

function onClick(e: MouseEvent) {
  if (!state.recording || insideRecorder(e.target)) return
  const el = interactive(e.target)
  if (!el) return
  // Typing into a field then clicking elsewhere: commit the fill first.
  flushFill()
  const tag = el.tagName.toLowerCase()
  if (
    tag === 'input' &&
    ['text', 'search', 'email', 'number', 'password', 'url', 'tel'].includes(
      (el as HTMLInputElement).type
    )
  )
    return
  if (tag === 'textarea') return
  const { selector, role } = bestSelector(el)
  state.steps.push({ kind: 'click', selector, role, label: labelFor(el), at: Date.now() })
  persist()
}

function onInput(e: Event) {
  if (!state.recording || insideRecorder(e.target)) return
  const el = e.target
  if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) return
  if (
    el instanceof HTMLInputElement &&
    ['checkbox', 'radio', 'file', 'submit', 'button'].includes(el.type)
  )
    return
  const { selector } = bestSelector(el)
  lastFill = { el, selector }
}

function flushFill() {
  if (!lastFill) return
  const el = lastFill.el as HTMLInputElement
  const value = String(el.value ?? '')
  const isPassword = el instanceof HTMLInputElement && el.type === 'password'
  const last = state.steps[state.steps.length - 1]
  const step: RecordedStep = {
    kind: 'fill',
    selector: lastFill.selector,
    value: isPassword ? '<redacted>' : value,
    label: labelFor(el) || el.getAttribute('placeholder') || 'field',
    at: Date.now()
  }
  // Consecutive typing into the same field collapses into one fill.
  if (last && last.kind === 'fill' && last.selector === step.selector)
    state.steps[state.steps.length - 1] = step
  else state.steps.push(step)
  lastFill = null
  persist()
}

function onChange(e: Event) {
  if (!state.recording || insideRecorder(e.target)) return
  const el = e.target
  if (el instanceof HTMLSelectElement) {
    const { selector } = bestSelector(el)
    state.steps.push({
      kind: 'select',
      selector,
      value: el.value,
      label: labelFor(el),
      at: Date.now()
    })
    persist()
    return
  }
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    if (lastFill && lastFill.el === el) flushFill()
  }
}

function onKeydown(e: KeyboardEvent) {
  if (!state.recording || insideRecorder(e.target)) return
  if (!['Enter', 'Escape', 'Tab'].includes(e.key)) return
  const el = e.target instanceof HTMLElement ? e.target : null
  if (!el) return
  flushFill()
  const { selector } = bestSelector(el)
  state.steps.push({ kind: 'press', selector, key: e.key, label: labelFor(el), at: Date.now() })
  persist()
}

let lastPath = ''
function onNavigate() {
  if (!state.recording) return
  const path = window.location.pathname + window.location.search
  if (path === lastPath) return
  lastPath = path
  flushFill()
  state.steps.push({ kind: 'goto', path, at: Date.now() })
  persist()
}

function arm() {
  if (armed) return
  armed = true
  document.addEventListener('click', onClick, true)
  document.addEventListener('input', onInput, true)
  document.addEventListener('change', onChange, true)
  document.addEventListener('keydown', onKeydown, true)
  window.addEventListener('popstate', onNavigate)
  // React Router pushes state without an event — poll the location cheaply.
  const tick = () => {
    if (!armed) return
    onNavigate()
    window.setTimeout(tick, 400)
  }
  tick()
}

function disarm() {
  if (!armed) return
  armed = false
  document.removeEventListener('click', onClick, true)
  document.removeEventListener('input', onInput, true)
  document.removeEventListener('change', onChange, true)
  document.removeEventListener('keydown', onKeydown, true)
  window.removeEventListener('popstate', onNavigate)
}

// ─── Public API ─────────────────────────────────────────────────────────────

export function startRecording(): void {
  state = { recording: true, startedAt: Date.now(), steps: [] }
  lastPath = ''
  arm()
  onNavigate()
}
export function stopRecording(): void {
  flushFill()
  state = { ...state, recording: false }
  disarm()
  persist()
}
export function clearRecording(): void {
  disarm()
  state = { recording: false, startedAt: null, steps: [] }
  persist()
}
export function removeStep(index: number): void {
  state = { ...state, steps: state.steps.filter((_, i) => i !== index) }
  persist()
}
/** Add an assertion step by hand: "this text is visible after that click". */
export function addExpectStep(selector: string, text: string): void {
  state = {
    ...state,
    steps: [
      ...state.steps,
      { kind: 'expect', selector, text, label: text.slice(0, 40), at: Date.now() }
    ]
  }
  persist()
}

// Re-arm after a reload mid-recording (sessionStorage says we were recording).
if (typeof window !== 'undefined' && state.recording) arm()

// ─── Spec rendering ─────────────────────────────────────────────────────────

const q = (s: string) => JSON.stringify(s)

/**
 * Render the steps as a Playwright spec in the house style of the extension
 * specs: token login through /api/auth/login/token, env-driven origin, one
 * test. Consecutive gotos collapse; the first goto is the entry point.
 */
export function renderSpec(opts: {
  name: string
  title?: string
  origin: string
  steps: RecordedStep[]
  viewport?: { width: number; height: number }
}): string {
  const vp = opts.viewport ?? { width: 1600, height: 1000 }
  const lines: string[] = []
  let skippedGoto = false
  for (const s of opts.steps) {
    switch (s.kind) {
      case 'goto':
        // Back-to-back navigations (a redirect chain) keep only the last.
        if (lines.length > 0 && lines[lines.length - 1].includes('page.goto(')) {
          lines.pop()
          skippedGoto = true
        }
        lines.push(`    await page.goto(\`\${ORIGIN}${s.path}\`)`)
        break
      case 'click':
        lines.push(`    // ${s.label}`)
        lines.push(
          s.role
            ? `    await page.getByRole(${q(s.role.role)}, { name: ${q(s.role.name)}, exact: true }).first().click()`
            : `    await page.locator(${q(s.selector)}).first().click()`
        )
        break
      case 'fill':
        lines.push(`    // ${s.label}`)
        lines.push(`    await page.locator(${q(s.selector)}).first().fill(${q(s.value)})`)
        break
      case 'press':
        lines.push(`    await page.locator(${q(s.selector)}).first().press(${q(s.key)})`)
        break
      case 'select':
        lines.push(`    await page.locator(${q(s.selector)}).first().selectOption(${q(s.value)})`)
        break
      case 'expect':
        lines.push(
          `    await expect(page.locator(${q(s.selector)}).first()).toContainText(${q(s.text)})`
        )
        break
    }
  }
  void skippedGoto
  const title = opts.title?.trim() || opts.name
  return `import { expect, test } from '@playwright/test'

/**
 * ${title}
 *
 * Recorded with the admin's golden-path recorder (${new Date().toISOString().slice(0, 10)}).
 * Runs against a live instance with a static token:
 *   NIVARO_E2E_TOKEN=<token> NIVARO_E2E_ORIGIN=${opts.origin} \\
 *   npx playwright test ${opts.name}.spec.ts
 *
 * Selectors were captured from live markup — prefer data-* markers and roles;
 * a positional CSS path here is a hint that the element needs a stable hook.
 */
const TOKEN = process.env.NIVARO_E2E_TOKEN
const ORIGIN = process.env.NIVARO_E2E_ORIGIN ?? ${q(opts.origin)}

test.describe(${q(title)}, () => {
  test.skip(!TOKEN, 'NIVARO_E2E_TOKEN not set')

  test('golden path', async ({ browser }) => {
    const page = await browser.newPage({ viewport: { width: ${vp.width}, height: ${vp.height} } })
    page.on('dialog', (d) => d.accept())
    await page.goto(\`\${ORIGIN}/login\`)
    await page.evaluate(async (t) => {
      await fetch('/api/auth/login/token', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: t }),
        credentials: 'include'
      })
    }, TOKEN)
${lines.join('\n')}
    await expect(page).not.toHaveURL(/\\/login/)
    await page.close()
  })
})
`
}
