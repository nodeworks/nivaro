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

const RAW = /\.CLOUD_META_DB_URL\b|\[['"]CLOUD_META_DB_URL['"]\]/g
const RAW_ONE = /\.CLOUD_META_DB_URL\b|\[['"]CLOUD_META_DB_URL['"]\]/
const PROCESS_ENV_RAW = /process\.env(?:\.CLOUD_META_DB_URL\b|\[['"]CLOUD_META_DB_URL['"]\])/g
/** The helper names Decision 4 deletes: a definition left behind (even without a raw read) is a site. */
const HELPER_DEF = /\b(const|function)\s+(inCloud|isCloud|cloudMode|inCloudMode|isCloudMode)\b/
/** Modules whose exported helper is a site wherever it is imported. */
const EXPORTED_HELPERS: Record<string, string> = {
  'services/outside-write-watch.ts': 'isCloudMode',
  'services/infra-drift/store.ts': 'cloudMode'
}

/** Comments out, line numbers kept (stripComments in slim-parity-scan.ts drops the newlines of a
 *  block comment, which would move every later line). Same two patterns. */
export function stripCommentsKeepLines(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ''))
    .replace(/(^|\s)\/\/.*$/gm, '$1')
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
 *  module-level boolean consts that are exactly the read, and the Decision-4 names. */
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
  if (rel === MODE_MODULE) return []
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
  return sites
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
