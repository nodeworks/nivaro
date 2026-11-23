import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

// The scanner behind cloud-flag-guard.test.ts (Hub phase 5): every place in api/src (tests and
// migrations excluded) that tests the cloud flag. Each site is classified in
// test/fixtures/cloud-flag-inventory.json as isMultiTenant() or isNivaroCloud(); the batches
// then replace the raw reads with the predicate. services/deployment-mode.ts is the one module
// allowed to read the variable and is never scanned.

export type SiteForm = 'raw' | 'env-param' | 'helper-def' | 'helper-call' | 'module-const'

export interface ScannedSite {
  file: string
  line: number
  text: string
  form: SiteForm
  /** Predicate calls this site turns into once converted: 1 for a read or a helper call, 0 for a
   *  helper definition (deleted) and for a read of a module-const flag (the const itself counts). */
  weight: 0 | 1
}

export type Batch = 'R' | 'A' | 'B' | 'C' | 'D' | 'E'

/** The one allowed reader. */
export const MODE_MODULE = 'services/deployment-mode.ts'

const RAW = /\.CLOUD_META_DB_URL\b|\[['"`]CLOUD_META_DB_URL['"`]\]/g
const RAW_ONE = /\.CLOUD_META_DB_URL\b|\[['"`]CLOUD_META_DB_URL['"`]\]/
const PROCESS_ENV_RAW = /process\.env(?:\.CLOUD_META_DB_URL\b|\[['"`]CLOUD_META_DB_URL['"`]\])/g
/** The helper names Decision 4 deletes: a definition left behind (even without a raw read) is a site. */
const HELPER_DEF = /\b(const|function)\s+(inCloud|isCloud|cloudMode|inCloudMode|isCloudMode)\b/
/** Modules whose exported helper is a site wherever it is imported. */
const EXPORTED_HELPERS: Record<string, string> = {
  'services/outside-write-watch.ts': 'isCloudMode',
  'services/infra-drift/store.ts': 'cloudMode'
}

export type SpanKind = 'code' | 'comment' | 'string' | 'template' | 'regex'
export interface Span {
  kind: SpanKind
  start: number
  end: number
}

/** Words after which a `/` starts a regex literal, not a division. */
const REGEX_AFTER_WORD = new Set([
  'return',
  'typeof',
  'instanceof',
  'in',
  'of',
  'new',
  'delete',
  'void',
  'throw',
  'case',
  'do',
  'else',
  'yield',
  'await'
])
/** Punctuation after which a `/` starts a regex literal (start of input too). */
const REGEX_AFTER_PUNCT = '(,=:[!&|?{};+-*%<>~^'

/** Splits TypeScript source into code, comments, strings ('…' and "…"), template text (the
 *  backtick parts; `${…}` inside is code again, nested to any depth) and regex literals. A `/*` or
 *  `//` inside a string, a template or a regex is not a comment. Regex vs division is the usual
 *  heuristic: a `/` starts a regex after an operator, an opening bracket, a comma, a keyword such
 *  as `return`, or at the start; after a name, a number, `)` or `]` it divides. */
export function lexSource(src: string): Span[] {
  const spans: Span[] = []
  const n = src.length
  const push = (kind: SpanKind, start: number, end: number) => {
    if (end <= start) return
    const last = spans[spans.length - 1]
    if (last && last.kind === kind && last.end === start) last.end = end
    else spans.push({ kind, start, end })
  }
  // one counter per open `${`: the `{` depth inside that expression
  const braces: number[] = []
  let inTemplate = false
  let lastSig = ''
  let lastWord = ''
  let i = 0
  while (i < n) {
    if (inTemplate) {
      const start = i
      while (i < n) {
        const c = src[i]
        if (c === '\\') i += 2
        else if (c === '`') {
          i++
          inTemplate = false
          lastSig = '`'
          break
        } else if (c === '$' && src[i + 1] === '{') {
          i += 2
          braces.push(0)
          inTemplate = false
          lastSig = '{'
          break
        } else i++
      }
      push('template', start, Math.min(i, n))
      continue
    }
    const c = src[i]
    const d = src[i + 1]
    if (c === '/' && d === '/') {
      const nl = src.indexOf('\n', i)
      const end = nl < 0 ? n : nl
      push('comment', i, end)
      i = end
      continue
    }
    if (c === '/' && d === '*') {
      const close = src.indexOf('*/', i + 2)
      const end = close < 0 ? n : close + 2
      push('comment', i, end)
      i = end
      continue
    }
    if (c === "'" || c === '"') {
      let j = i + 1
      while (j < n && src[j] !== c && src[j] !== '\n') j += src[j] === '\\' ? 2 : 1
      j = Math.min(j + 1, n)
      push('string', i, j)
      i = j
      lastSig = '"'
      continue
    }
    if (c === '`') {
      push('template', i, i + 1)
      i++
      inTemplate = true
      continue
    }
    if (
      c === '/' &&
      (lastSig === '' ||
        REGEX_AFTER_PUNCT.includes(lastSig) ||
        (lastSig === 'w' && REGEX_AFTER_WORD.has(lastWord)))
    ) {
      let j = i + 1
      let inClass = false
      let closed = false
      while (j < n && src[j] !== '\n') {
        const ch = src[j]
        if (ch === '\\') {
          j += 2
          continue
        }
        if (inClass) {
          if (ch === ']') inClass = false
        } else if (ch === '[') inClass = true
        else if (ch === '/') {
          closed = true
          j++
          break
        }
        j++
      }
      if (closed) {
        while (j < n && /[a-z]/i.test(src[j])) j++
        push('regex', i, j)
        i = j
        lastSig = 'w'
        lastWord = ''
        continue
      }
      // no closing slash on the line: a division after all
    }
    if (c === '}' && braces.length) {
      const top = braces.length - 1
      if (braces[top] === 0) {
        braces.pop()
        push('template', i, i + 1)
        i++
        inTemplate = true
        continue
      }
      braces[top]--
    } else if (c === '{' && braces.length) braces[braces.length - 1]++
    if (/[\w$]/.test(c)) {
      let j = i + 1
      while (j < n && /[\w$]/.test(src[j])) j++
      lastWord = src.slice(i, j)
      lastSig = 'w'
      push('code', i, j)
      i = j
      continue
    }
    if (!/\s/.test(c)) {
      lastSig = c
      lastWord = ''
    }
    push('code', i, i + 1)
    i++
  }
  return spans
}

/** Comments out, line numbers kept: a comment is replaced by its newlines only. Strings, template
 *  text and regex literals are kept as they are (a `/*` or `//` inside them is not a comment). */
export function stripCommentsKeepLines(src: string): string {
  let out = ''
  for (const s of lexSource(src)) {
    const part = src.slice(s.start, s.end)
    out += s.kind === 'comment' ? part.replace(/[^\n]/g, '') : part
  }
  return out
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

interface Helper {
  name: string
  /** true = a function (calls turn into predicate calls); false = a boolean const (reads). */
  fn: boolean
  defLine: number
  /** A Decision-4 name found by HELPER_DEF alone (no read on its line): always a helper-def site. */
  leftover?: boolean
}

/** Helpers defined in this file: one-line arrows, function declarations whose body is the read,
 *  module-level boolean consts that are exactly the read, and the Decision-4 names.
 *
 *  NOT discovered (the read inside is still a site, but the helper's callers are not, so they go
 *  unclassified and a batch can miss them): an arrow whose body starts on the next line or is a
 *  `{ … }` block; a function whose signature spans lines, whose body is longer than 3 lines or does
 *  not start with `return`; a const helper with any value other than exactly
 *  `!!process.env.CLOUD_META_DB_URL` (`Boolean(…)`, `!== undefined`, `env.X` on a parameter); class
 *  methods and getters; object members (`{ cloud: () => … }`); and any exported helper except the
 *  two in EXPORTED_HELPERS. The token backstop (strayTokens) catches a flag read none of the forms
 *  sees and an exported flag const, not the callers of an undiscovered helper. */
function findHelpers(rel: string, lines: string[]): { helpers: Helper[]; bodyLines: Set<number> } {
  const helpers: Helper[] = []
  // an exported function is a named API of its module (huddleCloudMode): its read is a plain
  // site and its callers elsewhere are not; only the two Decision-4 exports count as helpers
  const exportOk = (l: string, name: string) =>
    !/^\s*export\b/.test(l) || EXPORTED_HELPERS[rel] === name
  const bodyLines = new Set<number>()
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]
    const arrow = l.match(
      /\b(?:export\s+)?const\s+(\w+)\s*=\s*\([^)]*\)\s*(?::\s*\w+\s*)?=>\s*(.*)$/
    )
    if (arrow && RAW_ONE.test(arrow[2]) && exportOk(l, arrow[1])) {
      helpers.push({ name: arrow[1], fn: true, defLine: i })
      continue
    }
    const fn = l.match(/^\s*(?:export\s+)?function\s+(\w+)\s*\([^)]*\)\s*(?::\s*\w+\s*)?\{\s*$/)
    if (fn && exportOk(l, fn[1])) {
      // body = the lines up to the closing brace at the same indent; a helper only when the
      // body is short (≤ 3 lines) and reads the flag
      const indent = l.match(/^\s*/)?.[0] ?? ''
      let end = -1
      for (let j = i + 1; j < Math.min(lines.length, i + 5); j++) {
        if (lines[j] === `${indent}}` || lines[j].trimEnd() === `${indent}}`) {
          end = j
          break
        }
      }
      if (end > i) {
        const body = lines.slice(i + 1, end)
        if (
          body.some((b) => /CLOUD_META_DB_URL/.test(b)) &&
          body.join('').trim().startsWith('return')
        ) {
          helpers.push({ name: fn[1], fn: true, defLine: i })
          for (let j = i + 1; j < end; j++) bodyLines.add(j)
          continue
        }
      }
    }
    const value = l.match(
      /^(?:export\s+)?const\s+(\w+)\s*(?::\s*boolean\s*)?=\s*!!process\.env\.CLOUD_META_DB_URL\s*$/
    )
    if (value) {
      helpers.push({ name: value[1], fn: false, defLine: i })
      continue
    }
    const named = l.match(HELPER_DEF)
    if (named && !helpers.some((h) => h.defLine === i)) {
      // a Decision-4 name defined some other way (or left behind with no read)
      helpers.push({
        name: named[2],
        fn: !/^\s*(?:export\s+)?const\s+\w+\s*=\s*[^(]/.test(l) || /=>/.test(l),
        defLine: i,
        leftover: true
      })
    }
  }
  return { helpers, bodyLines }
}

/** Every cloud-flag site in one file (`rel` = path under api/src, `/` separators). */
export function scanFile(rel: string, source: string): ScannedSite[] {
  return scanDetail(rel, source).sites
}

function scanDetail(
  rel: string,
  source: string
): { sites: ScannedSite[]; bodyLines: Set<number>; lines: string[] } {
  if (rel === MODE_MODULE) return { sites: [], bodyLines: new Set(), lines: [] }
  const lines = stripCommentsKeepLines(source).split('\n')
  const { helpers, bodyLines } = findHelpers(rel, lines)
  const sites: ScannedSite[] = []
  const push = (i: number, form: SiteForm, weight: 0 | 1) =>
    sites.push({ file: rel, line: i + 1, text: lines[i].trim(), form, weight })

  // helpers imported from the two exporting modules
  const imported: Helper[] = []
  for (const [mod, name] of Object.entries(EXPORTED_HELPERS)) {
    if (rel === mod) continue
    const base = mod.replace(/\.ts$/, '').split('/').pop() as string
    const imp = new RegExp(
      `import\\s*\\{[^}]*\\b${name}\\b[^}]*\\}\\s*from\\s*['"][^'"]*${escapeRe(base)}(\\.js)?['"]`
    )
    const src = lines.join('\n')
    const m = src.match(imp)
    if (m) {
      const defLine = src.slice(0, m.index).split('\n').length - 1
      imported.push({ name, fn: true, defLine })
    }
  }

  const defLines = new Set(helpers.map((h) => h.defLine))
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]
    if (defLines.has(i)) {
      const h = helpers.find((x) => x.defLine === i) as Helper
      if (h.fn || h.leftover) push(i, 'helper-def', 0)
      else push(i, 'module-const', 1)
      continue
    }
    if (bodyLines.has(i)) continue
    const raws = l.match(RAW)?.length ?? 0
    if (raws) {
      const onProcess = l.match(PROCESS_ENV_RAW)?.length ?? 0
      const topConst = /^(?:export\s+)?(?:const|let)\s+\w+/.test(l)
      for (let k = 0; k < onProcess; k++) push(i, topConst ? 'module-const' : 'raw', 1)
      for (let k = 0; k < raws - onProcess; k++) push(i, 'env-param', 1)
    }
    for (const h of [...helpers, ...imported]) {
      if (h.defLine === i) continue
      const re = h.fn
        ? new RegExp(`(?<!function\\s)(?<![.\\w])${escapeRe(h.name)}\\(`, 'g')
        : new RegExp(`(?<![.\\w'"])${escapeRe(h.name)}\\b(?!\\s*:)`, 'g')
      const n = l.match(re)?.length ?? 0
      for (let k = 0; k < n; k++) push(i, 'helper-call', h.fn ? 1 : 0)
    }
  }
  return { sites, bodyLines, lines }
}

/** The variables the backstop watches: the cloud flag and the two Hub shared-deployment ones. */
const TOKEN = /\b(?:CLOUD_META_DB_URL|HUB_SHARED_DEPLOYMENT|HUB_DEPLOYMENT_TOKEN)\b/g

/** Exported names on a site line that are not flags (their importers use them for something else). */
export const EXPORT_OK: Record<string, string[]> = {
  // a Knex instance chosen by the flag at load time, not a flag
  'db/index.ts': ['_staticDb']
}

/**
 * Files that list environment variable NAMES as data (a string per name), never reading one
 * (ruling P5-17, merge prep): a bare string token there is not a flag read, so the backstop
 * skips string literals in these files only. A real read in them (process.env.X, env['X'] used
 * as a read, destructuring) is still a scanned site or a stray token. Paths are relative to
 * api/src, the tree the guard scans.
 *   - services/hub/docker/known-env.ts: phase 4's generated KNOWN_ENV_KEYS list (the Hub's copy
 *     of the app's config keys; it names CLOUD_META_DB_URL among them). Its twin
 *     packages/hub-agent/src/known-env.ts sits outside api/src and is never scanned.
 *   - services/hub/docker/stack-env.ts: the Hub's copy of the agent's env deny-list
 *     (AGENT_ENV_RULES); ruling X-2 names HUB_SHARED_DEPLOYMENT there as a key a stack may
 *     never set. It reads no environment variable.
 *   - services/hub/shared/stack-render.ts: SHARED_ENV_KEY / SHARED_SECRET_KEY, the env and secret
 *     NAMES the Hub writes into a shared stack's spec (twins of the agent's spec.ts keys, parked
 *     wave P6-28). The Hub never reads either variable; it renders them for the deployment.
 */
export const ENV_NAME_LISTS: ReadonlySet<string> = new Set([
  'services/hub/docker/known-env.ts',
  'services/hub/docker/stack-env.ts',
  'services/hub/shared/stack-render.ts'
])

export interface StrayToken {
  file: string
  line: number
  text: string
  reason: string
}

/** The token backstop behind check (a). The scanner only knows the read forms listed above; a
 *  destructuring (`const { CLOUD_META_DB_URL } = process.env`), an `in` test, a name kept in a const
 *  (`const K = 'CLOUD_META_DB_URL'; env[K]`) or a flag exported to other modules slips past it.
 *  So: every CLOUD_META_DB_URL / HUB_SHARED_DEPLOYMENT / HUB_DEPLOYMENT_TOKEN token in the file must
 *  sit on a scanned site line or in a helper body. Read on the UNSTRIPPED source, so a stripper
 *  fault cannot hide one; skipped are lines that are themselves comments (start with `//`, `/*` or
 *  `*`) and message strings (a string or template text with whitespace in it: a sentence that names
 *  the variable). Also refused: a flag const or helper exported from a site line (its importers'
 *  reads are not scanned), unless it is one of EXPORTED_HELPERS or EXPORT_OK. */
export function strayTokens(rel: string, source: string): StrayToken[] {
  if (rel === MODE_MODULE) return []
  const { sites, bodyLines, lines: stripped } = scanDetail(rel, source)
  const covered = new Set<number>(sites.map((s) => s.line))
  for (const i of bodyLines) covered.add(i + 1)
  const raw = source.split('\n')
  const lineStart: number[] = [0]
  for (let i = 0; i < source.length; i++) if (source[i] === '\n') lineStart.push(i + 1)
  const lineOf = (pos: number) => {
    let lo = 0
    let hi = lineStart.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (lineStart[mid] <= pos) lo = mid
      else hi = mid - 1
    }
    return lo
  }
  const spans = lexSource(source)
  const spanAt = (pos: number) => spans.find((s) => s.start <= pos && pos < s.end)
  const out: StrayToken[] = []
  const flagged = new Set<number>()
  for (const m of source.matchAll(TOKEN)) {
    const pos = m.index as number
    const i = lineOf(pos)
    if (/^\s*(?:\/\/|\/\*|\*)/.test(raw[i])) continue
    const span = spanAt(pos)
    // an env-name list: a name as a plain string literal is data, not a read
    if (span && span.kind === 'string' && ENV_NAME_LISTS.has(rel)) continue
    if (span && (span.kind === 'string' || span.kind === 'template')) {
      if (/\s/.test(source.slice(span.start, span.end))) continue
    }
    if (covered.has(i + 1) || flagged.has(i)) continue
    flagged.add(i)
    out.push({
      file: rel,
      line: i + 1,
      text: raw[i].trim(),
      reason: `${m[0]} outside a scanned site (classify it, or read it the way the scanner sees)`
    })
  }
  // exported flags: a const or helper on a site line, exported where it is defined, in an
  // `export { … }` list or as the default; or an `export const X =` whose read is on the next line
  const code = stripped.join('\n')
  const allowed = new Set([EXPORTED_HELPERS[rel], ...(EXPORT_OK[rel] ?? [])].filter(Boolean))
  for (const s of sites) {
    const l = stripped[s.line - 1]
    let name = l.match(/^\s*(?:export\s+)?(?:const|let|var|function)\s+(\w+)/)?.[1]
    let exported = /^\s*export\b/.test(l)
    if (!name && s.form === 'raw') {
      let p = s.line - 2
      while (p >= 0 && !stripped[p].trim()) p--
      const prev =
        p >= 0 ? stripped[p].match(/^\s*export\s+(?:const|let|var)\s+(\w+).*=\s*$/) : null
      if (prev) {
        name = prev[1]
        exported = true
      }
    }
    if (!name || allowed.has(name)) continue
    if (s.form !== 'module-const' && s.form !== 'helper-def' && !exported) continue
    const re = new RegExp(
      `export\\s*\\{[^}]*\\b${escapeRe(name)}\\b[^}]*\\}|export\\s+default\\s+${escapeRe(name)}\\b`
    )
    if (exported || re.test(code))
      out.push({
        file: rel,
        line: s.line,
        text: s.text,
        reason: `exports the flag as ${name}: its importers are not scanned (inline the predicate where it is used, or add it to EXPORTED_HELPERS)`
      })
  }
  return out
}

function walk(dir: string, root: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    const rel = relative(root, p).split(sep).join('/')
    if (statSync(p).isDirectory()) {
      if (name === 'node_modules' || rel === 'test' || rel === 'db/migrations') continue
      walk(p, root, out)
    } else if (/\.ts$/.test(name) && !/\.(test|spec)\.ts$/.test(name) && !/\.d\.ts$/.test(name)) {
      out.push(p)
    }
  }
}

/** The scanned source files under `root` (api/src) as paths relative to it, sorted. */
export function listSourceFiles(root: string): string[] {
  const files: string[] = []
  walk(root, root, files)
  return files.map((f) => relative(root, f).split(sep).join('/')).sort()
}

/** Every site under `root` (api/src). */
export function scanTree(root: string): ScannedSite[] {
  const out: ScannedSite[] = []
  for (const rel of listSourceFiles(root))
    out.push(...scanFile(rel, readFileSync(join(root, rel), 'utf8')))
  return out
}

/** Glob → RegExp over a path under api/src: `**` any depth, `*` one segment, `{a,b}` choices. */
function globRe(glob: string): RegExp {
  let re = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === '*' && glob[i + 1] === '*') {
      re += '.*'
      i++
    } else if (c === '*') re += '[^/]*'
    else if (c === '{') {
      const end = glob.indexOf('}', i)
      re += `(?:${glob
        .slice(i + 1, end)
        .split(',')
        .map(escapeRe)
        .join('|')})`
      i = end
    } else re += escapeRe(c)
  }
  return new RegExp(`^${re}$`)
}

/** The plan's Batches table, in order; first match wins. */
export const BATCH_GLOBS: [Exclude<Batch, 'E'>, string[]][] = [
  ['R', ['middleware/tenant.ts', 'db/tenant-context.ts', 'routes/admin/traffic-tenants.ts']],
  [
    'A',
    [
      'config.ts',
      'index.ts',
      'server.ts',
      'realtime-server.ts',
      'db/**',
      'middleware/**',
      'extensions/loader.ts',
      'routes/index.ts',
      'lib/**',
      'graphql/**',
      'plugins/rate-limit.ts',
      'plugins/graphql.ts',
      'routes/{health,preflight,auth,mcp,extensions,cache-config}.ts',
      'services/{app-info,request-origin,permission-cache,cache-config,cache-warm,cache-warm-on-change,db-outage,process-role,deploy-readiness,maintenance-live,environment-notice,row-schedules}.ts'
    ]
  ],
  [
    'B',
    [
      'plugins/socketio.ts',
      'services/socket-*.ts',
      'services/realtime-*.ts',
      'services/{record-events,grid-presence,cloud-user-rooms,outside-write-watch,phone-push,push-relay}.ts',
      'services/huddle-*.ts',
      'routes/{realtime,realtime-verify,presence,stream,push}.ts'
    ]
  ],
  [
    'C',
    [
      'services/traffic-*.ts',
      'services/traffic-*/**',
      'routes/traffic-map*.ts',
      'routes/traffic-map-extras/**',
      'plugins/traffic-actions.ts',
      'services/{telemetry-*,trace-export,ops-*,pool-*,stall-causes,wait-reasons,crash-tracking,log-retention,issue-raise}.ts',
      'routes/{ops-*,pool-holders,session-replay-notes}.ts'
    ]
  ],
  [
    'D',
    [
      'services/{docker-source,traefik-source,gitlab-health,media-handoff,mail-retry-state,import-handoff,staged-import-worker}.ts',
      'services/export-*.ts',
      'services/{infra-drift,storage,chaos,recovery,config-drift,teams-bot,trackers}/**',
      'routes/{infrastructure,infrastructure-drift,internal-render,internal-file-source,teams-bot,export-limits,imports,integration-obligations}.ts',
      'routes/admin/**'
    ]
  ]
]

/** `services/{telemetry-*,…}.ts`: a choice may hold a `*` itself. */
function expand(glob: string): string[] {
  const m = glob.match(/\{([^}]*)\}/)
  if (!m?.[1].includes('*')) return [glob]
  return m[1].split(',').map((c) => glob.replace(m[0], c))
}

const COMPILED: [Exclude<Batch, 'E'>, RegExp[]][] = BATCH_GLOBS.map(([b, globs]) => [
  b,
  globs.flatMap(expand).map(globRe)
])

export function batchFor(file: string): Batch {
  for (const [b, res] of COMPILED) if (res.some((r) => r.test(file))) return b
  return 'E'
}
