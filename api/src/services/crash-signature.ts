/**
 * Front-end crash grouping (Issue Log → Crashes). PURE: no database, no I/O — crash-tracking.ts
 * stores and alerts, this file decides what a crash IS.
 *
 * A crash report (POST /issues/client) is grouped by:
 *
 *   signature = error name | message with values stripped | top 3 stack frames (function + bundle
 *               file without its build hash)
 *   screen    = the route PATTERN the tab was on (`/collections/:id/:id`, never ids)
 *   release   = the front end's build (x-nivaro-client `build=`)
 *
 * Same signature + screen + release = one nivaro_issues row (its `fingerprint`). Minified function
 * names (`nn`) change from build to build, so a signature only means something inside one
 * release. Whether a crash is NEW in a release is judged on the `family` instead: error name +
 * message with short (minified) identifiers blanked + top bundle file + screen — stable across
 * builds, so "nn.find is not a function" in 0.3.157 and "rn.find is not a function" in 0.3.158
 * on the same screen read as the same crash seen before.
 *
 * Everything that reaches the issue log is scrubbed here first (`scrubCrashText`): tokens,
 * passwords, emails, long opaque strings and URL query strings are replaced, and a quoted value
 * that is not an identifier ('find' stays, 'Jane Smith' goes) is blanked — a crash message must
 * never carry what someone typed into a form. The browser reporter scrubs too
 * (packages/shared lib/crash-report.ts); the server's pass is the one that counts.
 */
import { createHash } from 'node:crypto'
import { compareBuilds } from './sticky-refresh.js'

// ─── Scrubbing ───────────────────────────────────────────────────────────────

const REPLACERS: Array<[RegExp, string | ((m: string, ...g: string[]) => string)]> = [
  // First: a URL keeps its path (the bundle file a frame names) and loses its query and
  // fragment, before any key=value rule reads a query parameter as a secret.
  [/(\bhttps?:\/\/[^\s?#'"<>)]*)[?#][^\s:'"<>)]*/gi, '$1'],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{6,}/gi, 'Bearer <redacted>'],
  [/\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{2,}/g, '<jwt>'],
  // Nivaro's own credentials: nvo_ (OAuth), nvd_/nvdr_ (devices), nvk_ (API keys) …
  [/\bnv[a-z]{1,3}_[A-Za-z0-9_-]{6,}/g, '<token>'],
  [
    /\b(password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|authorization|cookie|session(?:id)?)(["']?\s*[:=]\s*)(["']?)[^\s"'&,;)}\]]+/gi,
    (_m, k: string, sep: string, q: string) => `${k}${sep}${q}<redacted>`
  ],
  [/\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/g, '<email>'],
  // Long opaque strings (keys, hashes, base64) — only when they mix letters and digits, so a
  // long component name (`CollectionBrowserInlineEditCell`) survives.
  [
    /[A-Za-z0-9+/_-]{32,}={0,2}/g,
    (m: string) => (/\d/.test(m) && /[A-Za-z]/.test(m) ? '<redacted>' : m)
  ],
  // A quoted value: an identifier ('find', "map", `rows.length`) stays; anything else — a
  // sentence, a name, a number someone typed — is blanked.
  [
    /(["'`])((?:(?!\1)[^\\\n]|\\.){0,300})\1/g,
    (m: string, q: string, inner: string) =>
      /^[A-Za-z_$][\w$.-]{0,59}$/.test(inner) || inner === '' ? m : `${q}…${q}`
  ]
]

/** Text with secrets and typed values replaced; capped at `max` characters. */
export function scrubCrashText(text: string | null | undefined, max = 6000): string {
  let s = String(text ?? '')
  for (const [re, rep] of REPLACERS) s = s.replace(re, rep as never)
  return s.slice(0, max)
}

// ─── Frames ──────────────────────────────────────────────────────────────────

const V8_FRAME = /^\s*at\s+(?:(.+?)\s+\()?(.+?):(\d+)(?::(\d+))?\)?\s*$/
const FF_FRAME = /^\s*([^@\s]*)@(.+?):(\d+)(?::(\d+))?\s*$/

export interface CrashFrame {
  /** Function name as the bundle has it ('' for an anonymous frame). */
  fn: string
  /** Bundle file without origin, query or build hash: `assets/LinesGrid.js`. */
  file: string
  /** The raw file (with its hash) — what a source map is looked up by. */
  rawFile: string
  line: number
  column: number | null
}

/** A bundle file without origin, query or Vite/webpack build hash. */
export function bundleFile(file: string): string {
  let f = String(file ?? '').replace(/^webpack:\/\/\/?|^file:\/\//, '')
  f = f.replace(/^https?:\/\/[^/]+\//, '').replace(/^\/+/, '')
  f = f.split(/[?#]/)[0]
  // index-B3kF9a_x.js, LinesGrid-Ab-cd123.js, chunk.4f3a2b1c.js — the hash has a digit or an
  // upper-case letter, so a plain name like page-error-boundary.js keeps its last word.
  f = f.replace(/[-.]([A-Za-z0-9_-]{8,12})(?=\.(?:m?js|cjs)$)/, (m, h: string) =>
    /\d|[A-Z]/.test(h) && /[a-z0-9]/.test(h) ? '' : m
  )
  return f.slice(0, 160)
}

/**
 * The error's own frames, top first. A React component stack appended after the error's stack
 * (`\n---\n` from the admin boundary, `Component stack:` from efp-new) is not part of it.
 */
export function crashFrames(stack: string | null | undefined, max = 12): CrashFrame[] {
  const own = String(stack ?? '').split(/\n-{3,}\n|\n+Component stack:/)[0]
  const out: CrashFrame[] = []
  for (const line of own.split('\n')) {
    const m = V8_FRAME.exec(line) ?? FF_FRAME.exec(line)
    if (!m) continue
    const rawFile = m[2]
    if (/^(?:node:|native$|<anonymous>)/.test(rawFile)) continue
    // A browser extension's own script is not the app's crash.
    if (/(chrome|moz|safari(-web)?)-extension:\/\//.test(rawFile)) continue
    out.push({
      fn: (m[1] ?? '')
        .replace(/^(?:async|new)\s+/, '')
        .trim()
        .slice(0, 80),
      file: bundleFile(rawFile),
      rawFile: rawFile.split(/[?#]/)[0],
      line: Number(m[3]),
      column: m[4] != null ? Number(m[4]) : null
    })
    if (out.length >= max) break
  }
  return out
}

/** True when every frame of the stack comes from a browser extension (not ours to file). */
export function fromBrowserExtension(stack: string | null | undefined): boolean {
  const s = String(stack ?? '')
  return /(chrome|moz|safari(-web)?)-extension:\/\//.test(s) && crashFrames(s).length === 0
}

export function frameLabel(f: Pick<CrashFrame, 'fn' | 'file'> | null | undefined): string | null {
  if (!f) return null
  return f.fn ? `${f.fn} (${f.file})` : f.file
}

// ─── Messages ────────────────────────────────────────────────────────────────

const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi
const HEX = /\b(?:0x)?[0-9a-f]{12,}\b/gi
const NUMBER = /(?<![A-Za-z_$])[-+]?\d+(?:[.,]\d+)*(?![A-Za-z_$])/g

/** The message as a grouping key: ids, numbers and blanked values replaced, spaces collapsed. */
export function crashMessageKey(message: string | null | undefined): string {
  return (
    scrubCrashText(String(message ?? '').split('\n')[0], 400)
      .replace(/\bhttps?:\/\/\S+/gi, '<url>')
      .replace(UUID, '<id>')
      .replace(HEX, '<id>')
      .replace(NUMBER, '<n>')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 300) || 'Unknown error'
  )
}

/**
 * The message as a release-independent key: crashMessageKey with every short identifier (what a
 * minifier names a variable: `nn`, `e`, `Qt`) blanked, so the same crash in the next build is
 * the same family.
 */
export function crashFamilyMessage(message: string | null | undefined): string {
  return crashMessageKey(message).replace(/(^|[^\w$<'"`])[A-Za-z_$][\w$]{0,2}(?=[^\w$]|$)/g, '$1~')
}

// ─── Keys ────────────────────────────────────────────────────────────────────

const sha1 = (s: string) => createHash('sha1').update(s).digest('hex').slice(0, 20)

export interface CrashKeyInput {
  app: string
  name: string
  message: string
  stack: string | null | undefined
  screen: string
}

/** Inside one release: name + message key + the top three frames. */
export function crashSignature(x: Omit<CrashKeyInput, 'screen' | 'app'>): string {
  const frames = crashFrames(x.stack, 3)
    .map((f) => `${f.fn}@${f.file}`)
    .join('<')
  return sha1(`${x.name}|${crashMessageKey(x.message)}|${frames}`)
}

/** Across releases: app + name + family message + top bundle file + screen. */
export function crashFamily(x: CrashKeyInput): string {
  const top = crashFrames(x.stack, 1)[0]?.file ?? ''
  return sha1(`${x.app}|${x.name}|${crashFamilyMessage(x.message)}|${top}|${x.screen}`)
}

/** The nivaro_issues fingerprint (64 hex): one row per signature + screen + release. */
export function crashFingerprint(x: {
  app: string
  signature: string
  screen: string
  release: string
}): string {
  return createHash('sha256')
    .update(`crash|${x.app}|${x.signature}|${x.screen}|${x.release}`)
    .digest('hex')
}

/** The error name: the reported one when it looks like one, else the stack's first line. */
export function crashErrorName(name: unknown, stack: string | null | undefined): string {
  const n = typeof name === 'string' ? name.trim() : ''
  if (/^[A-Z][A-Za-z]{0,40}$/.test(n)) return n
  const m = /^([A-Z][A-Za-z]{0,40}(?:Error|Exception))\b/.exec(String(stack ?? '').trimStart())
  return m ? m[1] : 'Error'
}

// ─── The header kept in nivaro_issues.details ────────────────────────────────

export type CrashKind = 'render' | 'error' | 'rejection'

export interface CrashMeta {
  app: string
  release: string
  kind: CrashKind
  signature: string
  family: string
  /** The release this crash is new in (= `release` when first seen there), else null. */
  new_in: string | null
  /** When not new: the earliest other release the family was seen in. */
  seen_in: string | null
  frame: string | null
  alerted_at: string | null
}

const KINDS: CrashKind[] = ['render', 'error', 'rejection']

export function crashKind(v: unknown): CrashKind {
  return KINDS.includes(v as CrashKind) ? (v as CrashKind) : 'error'
}

const META_SAFE = /[^\w.+@:-]/g

/** The `Crash:` + `Frame:` lines written above the stack. */
export function crashHeaderLines(meta: Omit<CrashMeta, 'alerted_at'>): string[] {
  const parts = [
    `app=${meta.app}`,
    `release=${meta.release}`,
    `kind=${meta.kind}`,
    `sig=${meta.signature}`,
    `family=${meta.family}`,
    meta.new_in ? `new_in=${meta.new_in}` : null,
    meta.seen_in ? `seen_in=${meta.seen_in}` : null
  ].filter(Boolean) as string[]
  return [
    `Crash: ${parts.map((p) => p.replace(/=(.*)$/, (_m, v: string) => `=${v.replace(META_SAFE, '')}`)).join('; ')}`,
    ...(meta.frame ? [`Frame: ${meta.frame.replace(/\n/g, ' ').slice(0, 240)}`] : [])
  ]
}

/**
 * The crash header of an issue's details, or null for an issue filed before crash grouping.
 *
 * Anchored, because everything below it is the reporter's own text: the header is ONLY ever
 * `[Alerted: <iso>\n]Route: <screen>\nCrash: …[\nFrame: …]` at the very top, exactly as
 * error-tracking.ts writes it (the screen is a normalised pattern, never multi-line). A
 * `Crash:` / `Frame:` / `Alerted:` line anywhere else — a message or stack that says
 * "family=…" — is never read as the header.
 */
export function parseCrashMeta(details: string | null | undefined): CrashMeta | null {
  const lines = String(details ?? '').split('\n')
  let i = 0
  let alerted: string | null = null
  // Prepended by the alert claim, so only ever the FIRST line.
  const a = /^Alerted: (\S+)$/.exec(lines[0] ?? '')
  if (a) {
    alerted = a[1]
    i = 1
  }
  if (!/^Route: /.test(lines[i] ?? '')) return null
  const line = /^Crash: (.*)$/.exec(lines[i + 1] ?? '')
  if (!line) return null
  const f: Record<string, string> = {}
  for (const part of line[1].split(';')) {
    const at = part.indexOf('=')
    if (at > 0) f[part.slice(0, at).trim()] = part.slice(at + 1).trim()
  }
  return {
    app: f.app || 'app',
    release: f.release || 'unknown',
    kind: crashKind(f.kind),
    signature: f.sig || '',
    family: f.family || '',
    new_in: f.new_in || null,
    seen_in: f.seen_in || null,
    frame: /^Frame: (.*)$/.exec(lines[i + 2] ?? '')?.[1] ?? null,
    alerted_at: alerted
  }
}

/** The stack below the header (and above any source-mapped block). */
export function crashStackOf(details: string | null | undefined): string | null {
  const body = String(details ?? '')
    .split('\n')
    .filter((l) => !/^(Route|Crash|Frame|Alerted|Request context):/.test(l))
    .join('\n')
  const [stack] = body.split(/\n*Source-mapped stack:\n/)
  return stack.trim() || null
}

/** The source-mapped stack an issue's details carry, or null. */
export function crashResolvedStackOf(details: string | null | undefined): string | null {
  const m = /\n*Source-mapped stack:\n([\s\S]*)$/.exec(String(details ?? ''))
  return m ? m[1].trim() || null : null
}

// ─── New in a release ────────────────────────────────────────────────────────

/** A release that can be compared (dev builds, placeholders and unknowns never alert). */
export function judgeableRelease(v: string | null | undefined): v is string {
  return !!v && v !== 'dev' && v !== 'unknown' && !v.startsWith('0.0.0')
}

/**
 * Is a crash of this family new in `release`? `seenIn` = every release the family was seen in
 * before this report (from the issue log). New = it was never seen in another release.
 */
export function newInRelease(
  release: string,
  seenIn: Iterable<string>
): { new_in: string | null; seen_in: string | null } {
  const others = [...new Set(seenIn)].filter((r) => r && r !== release)
  if (others.length === 0) return { new_in: release, seen_in: null }
  const earliest = others.sort((a, b) => compareBuilds(a, b) ?? a.localeCompare(b))[0]
  return { new_in: null, seen_in: earliest }
}

/**
 * Is `release` the app's CURRENT release — the only one whose new crashes alert? A report names
 * its own release (untrusted), so the answer never comes from crash reports:
 *
 * - the admin, which the API serves itself: only the API's own version (a dev or unknown API
 *   version never alerts);
 * - any other app: the build the client-build roster says that app is on now (live sockets,
 *   makeBuildJudge). When the roster knows nothing about the app, the alert's own rule (at least
 *   two different people hit it, shouldAlertCrash) is the proof the release is real.
 */
export function isCurrentRelease(
  app: string,
  release: string,
  ctx: { apiVersion: string | null; rosterBuild: string | null; apiServedApp?: string }
): boolean {
  if (!judgeableRelease(release)) return false
  if (app === (ctx.apiServedApp ?? 'admin'))
    return judgeableRelease(ctx.apiVersion) && release === ctx.apiVersion
  if (ctx.rosterBuild) return release === ctx.rosterBuild
  return true
}

/** Never fewer than two different people: one account can never alert every admin alone. */
export const CRASH_ALERT_PEOPLE_FLOOR = 2

export interface CrashAlertFacts {
  meta: Pick<CrashMeta, 'release' | 'new_in' | 'alerted_at'>
  current: boolean
  /** Hits of this issue in the alert window, and the distinct people among them. */
  hits: number
  people: number
  minHits: number
  minPeople: number
}

/** Should admins hear about this crash now? The hits AND at least two different people. */
export function shouldAlertCrash(x: CrashAlertFacts): boolean {
  if (x.meta.alerted_at) return false
  if (!judgeableRelease(x.meta.release)) return false
  if (x.meta.new_in !== x.meta.release) return false
  if (!x.current) return false
  return x.hits >= x.minHits && x.people >= Math.max(CRASH_ALERT_PEOPLE_FLOOR, x.minPeople)
}

/** One line of reporter text made safe to show an admin: scrubbed again, one line, ≤ max. */
export function alertQuote(text: string, max = 120): string {
  const one = scrubCrashText(text, 1000)
    // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029"]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!one) return 'Unknown error'
  return one.length > max ? `${one.slice(0, max - 1)}…` : one
}

/** A server-normalised token (screen pattern, version, app) with anything else dropped. */
function token(v: string, max: number): string {
  return (
    String(v ?? '')
      .replace(/[^\w./:@+-]/g, '')
      .slice(0, max) || 'unknown'
  )
}

/**
 * The alert's wording. The subject is fixed — screen pattern and version only — so a reporter's
 * free text never reaches an admin's notification title, push or email subject. The error
 * appears once in the message, scrubbed again, cut to 120 characters and quoted as
 * `Error: "…"`.
 */
export function crashAlertText(x: {
  app: string
  release: string
  screen: string
  message: string
  hits: number
  people: number
  windowMin: number
  replay: boolean
}): { subject: string; message: string } {
  const screen = token(x.screen, 140)
  const release = token(x.release, 60)
  const who = x.people === 1 ? '1 person' : `${x.people} people`
  const times = x.hits === 1 ? 'once' : `${x.hits} times`
  return {
    subject: `App crash on ${screen} in ${release}`.slice(0, 255),
    message:
      `Error: "${alertQuote(x.message)}" — ${times}, ${who} in the last ${x.windowMin} minutes (${token(x.app, 30)} ${release}, first seen in this release).${x.replay ? ' A replay of the moment is linked on the issue.' : ''}`.slice(
        0,
        500
      )
  }
}
