// api/src/services/traffic-actions/ext-lenses.ts
/**
 * Extension lenses on the Traffic Map (#2229): `ctx.traffic.registerLens({ id, label, read, … })`.
 * The map lists the lenses (GET /traffic-map/ext-lenses), and while an admin has one switched on
 * it asks for its data (GET /traffic-map/ext-lenses/:key) — this module calls the extension's
 * `read` with a time limit and hands back ONLY the shape the map draws: node badges and inspector
 * rows, every string capped, tones from a fixed set, links only to in-app paths. The admin bundle
 * never loads extension code; the map renders the data through its own badge and panel slots.
 *
 * Types are mirrored from @nivaro/extension-kit (extensions never import api/src).
 */
import type { TrafficLensData, TrafficLensDef } from '@nivaro/extension-kit'

export const LENS_ID_RE = /^[a-z0-9][a-z0-9_-]{0,59}$/
export const READ_TIMEOUT_MS = 5000
const MAX_BADGES = 300
const MAX_PANELS = 200
const MAX_ROWS = 20
const NODE_RE = /^[A-Za-z0-9_:./@-]{1,200}$/
const TONES = new Set(['info', 'warn', 'error'])

interface Registered {
  key: string
  extension: string
  def: TrafficLensDef
}
const lenses = new Map<string, Registered>()

/** `<extension>:<id>` — the key the map uses. Throws on a malformed id (the loader logs it). */
export function registerExtensionLens(extension: string, def: TrafficLensDef): string {
  if (!def || typeof def.id !== 'string' || !LENS_ID_RE.test(def.id))
    throw new Error(`registerLens: id must match ${LENS_ID_RE} (got "${def?.id}")`)
  if (typeof def.label !== 'string' || !def.label.trim())
    throw new Error('registerLens: a label is required')
  if (typeof def.read !== 'function') throw new Error('registerLens: read must be a function')
  const key = `${extension}:${def.id}`
  lenses.set(key, { key, extension, def })
  return key
}

export function unregisterExtensionLenses(extension: string): void {
  for (const [k, l] of lenses) if (l.extension === extension) lenses.delete(k)
}

export interface LensListing {
  key: string
  extension: string
  id: string
  label: string
  description: string | null
  node_badge: boolean
  panel_title: string | null
}

export function listExtensionLenses(): LensListing[] {
  return [...lenses.values()]
    .map(({ key, extension, def }) => {
      const panel = def.inspectorPanel
      return {
        key,
        extension,
        id: def.id,
        label: def.label.slice(0, 60),
        description: def.description ? String(def.description).slice(0, 300) : null,
        node_badge: def.nodeBadge !== false,
        panel_title:
          panel === false
            ? null
            : String((typeof panel === 'object' && panel?.title) || def.label).slice(0, 80)
      }
    })
    .sort((a, b) => a.label.localeCompare(b.label))
}

function str(v: unknown, max: number): string {
  // Control characters (new lines, escapes) become spaces: one line of plain text each.
  let out = ''
  for (const ch of String(v ?? '')) {
    const c = ch.charCodeAt(0)
    out += c < 32 || c === 127 ? ' ' : ch
    if (out.length > max + 64) break
  }
  return out.trim().slice(0, max)
}
function tone(v: unknown): 'info' | 'warn' | 'error' {
  return TONES.has(String(v)) ? (v as 'info' | 'warn' | 'error') : 'info'
}
/** In-app paths only: `/x…`, never `//host`, a scheme or a backslash trick. */
export function safeHref(v: unknown): string | null {
  const s = typeof v === 'string' ? v.trim() : ''
  if (!s.startsWith('/') || s.startsWith('//') || s.includes('\\') || s.length > 500) return null
  if (/[\s<>"']/.test(s)) return null
  return s
}

export interface SafeLensData {
  badges: Array<{ node: string; text: string; tone: 'info' | 'warn' | 'error' }>
  panels: Array<{
    node: string
    title: string | null
    rows: Array<{
      label: string
      value: string
      tone: 'info' | 'warn' | 'error' | null
      href: string | null
    }>
    note: string | null
  }>
  summary: string | null
}

/** What the map may draw from a lens's answer (pure; anything malformed is dropped). */
export function sanitizeLensData(
  raw: unknown,
  opts: { badges: boolean; panels: boolean } = { badges: true, panels: true }
): SafeLensData {
  const d = (raw && typeof raw === 'object' ? raw : {}) as TrafficLensData
  const badges: SafeLensData['badges'] = []
  if (opts.badges && Array.isArray(d.badges)) {
    for (const b of d.badges.slice(0, MAX_BADGES)) {
      const node = typeof b?.node === 'string' ? b.node.trim() : ''
      const text = str(b?.text, 24)
      if (!NODE_RE.test(node) || !text) continue
      badges.push({ node, text, tone: tone(b.tone) })
    }
  }
  const panels: SafeLensData['panels'] = []
  if (opts.panels && Array.isArray(d.panels)) {
    for (const p of d.panels.slice(0, MAX_PANELS)) {
      const node = typeof p?.node === 'string' ? p.node.trim() : ''
      if (!NODE_RE.test(node)) continue
      const rows = (Array.isArray(p.rows) ? p.rows : [])
        .slice(0, MAX_ROWS)
        .map((r) => ({
          label: str(r?.label, 80),
          value: str(typeof r?.value === 'number' ? String(r.value) : r?.value, 200),
          tone: r?.tone === undefined ? null : tone(r.tone),
          href: safeHref(r?.href)
        }))
        .filter((r) => r.label)
      if (!rows.length && !p.note) continue
      panels.push({
        node,
        title: p.title ? str(p.title, 80) : null,
        rows,
        note: p.note ? str(p.note, 300) : null
      })
    }
  }
  return { badges, panels, summary: d.summary ? str(d.summary, 200) : null }
}

export class LensError extends Error {
  constructor(
    message: string,
    public status: number,
    public code: string
  ) {
    super(message)
  }
}

/** Run one lens's `read` (bounded by READ_TIMEOUT_MS) and sanitize its answer. */
export async function readExtensionLens(
  key: string,
  windowS: number,
  timeoutMs = READ_TIMEOUT_MS
): Promise<SafeLensData> {
  const l = lenses.get(key)
  if (!l) throw new LensError('No such lens', 404, 'LENS_NOT_FOUND')
  let timer: NodeJS.Timeout | null = null
  try {
    const raw = await Promise.race([
      Promise.resolve().then(() => l.def.read({ window: windowS })),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new LensError('The lens took too long to answer', 504, 'LENS_TIMEOUT')),
          timeoutMs
        )
      })
    ])
    const panel = l.def.inspectorPanel
    return sanitizeLensData(raw, { badges: l.def.nodeBadge !== false, panels: panel !== false })
  } catch (err) {
    if (err instanceof LensError) throw err
    throw new LensError('The lens could not be read', 502, 'LENS_FAILED')
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** Test hook. */
export function resetExtensionLenses(): void {
  lenses.clear()
}
