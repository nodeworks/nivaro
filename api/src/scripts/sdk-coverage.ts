/**
 * `pnpm --filter @nivaro/api run sdk:coverage [-- --json] [-- --summary]` (#756)
 *
 * Registers the API's route tree in-process (no listener, no database
 * call) and reads every `cmd('METHOD', '/path')` the SDK sources declare,
 * then reports:
 *   - routes no SDK command reaches, grouped by their first path segment
 *   - SDK commands whose path matches no registered route (dead commands)
 * Report only: exit 0 always, so a release preflight can print it without
 * blocking. `--summary` prints one line, `--json` the whole report.
 *
 * Route families the SDK is not meant to cover are listed in NOT_FOR_SDK
 * with the reason, and are counted apart.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import Fastify from 'fastify'

const ROOT = resolve(process.cwd(), '..')
const SDK_SRC = resolve(ROOT, 'packages/sdk/src')

/** Route families that belong to a browser session, an operator console or a
 *  partner-facing surface — never an SDK client. Prefix = first segment. */
const NOT_FOR_SDK: Record<string, string> = {
  auth: 'browser sign-in, callbacks and session flows',
  admin: 'tenant provisioning (nivaro-cloud calls it)',
  scim: 'identity-provider provisioning protocol',
  zapier: "Zapier's own trigger and action contract",
  graphql: 'the GraphQL endpoint',
  'graphql-ws': 'GraphQL subscriptions transport',
  docs: 'the documentation pages',
  health: 'load-balancer probes',
  version: 'deploy banner probe',
  preflight: 'deploy verification',
  status: 'public status page',
  widget: 'the embeddable widget script',
  form: 'public submission form pages',
  share: 'public share links',
  dashboard: 'public dashboard viewer',
  'dashboard-links': 'public dashboard viewer feed',
  inbound: 'partner-posted payloads (POST /inbound/:key)',
  release: 'local release card (development only)',
  'dev-tools': 'development-only tooling',
  'e2e-specs': 'development-only recorder output',
  rum: 'browser performance beacons',
  presence: 'socket-driven presence beats',
  realtime: 'socket console',
  ops: 'operator consoles',
  'ops-logs': 'operator consoles',
  'ops-db': 'operator consoles',
  'ops-runtime': 'operator consoles',
  'ops-monitors': 'operator consoles',
  'ops-calendar': 'operator consoles',
  'session-recordings': 'session replay upload/playback',
  cron: 'operator cron controls',
  'job-runs': 'operator job history',
  journeys: 'admin route breadcrumbs',
  traces: 'slow-request ring buffer'
}

type Route = { method: string; path: string; segs: string[] }
type Cmd = { method: string; path: string; segs: string[]; file: string; line: number }

function segsOf(path: string): string[] {
  return path
    .replace(/^\/api(?=\/)/, '')
    .replace(/\/+$/, '')
    .split('/')
    .filter(Boolean)
}

/** A route segment `:id` matches any command segment; `*` swallows the rest. */
function routeMatches(route: Route, cmd: Cmd): boolean {
  const r = route.segs
  const c = cmd.segs
  for (let i = 0; i < r.length; i++) {
    if (r[i] === '*') return true
    if (i >= c.length) return false
    if (r[i].startsWith(':')) continue
    if (c[i] === ':param') return false // a variable where the route is literal
    if (r[i] !== c[i]) return false
  }
  return r.length === c.length
}

async function collectRoutes(): Promise<Route[]> {
  const app = Fastify({ logger: false })
  const seen = new Map<string, Route>()
  app.addHook('onRoute', (route) => {
    const methods = Array.isArray(route.method) ? route.method : [route.method]
    for (const m of methods) {
      if (m === 'HEAD' || m === 'OPTIONS') continue
      const path = route.path.replace(/\/+$/, '') || '/'
      seen.set(`${m} ${path}`, { method: m, path, segs: segsOf(path) })
    }
  })
  const { registerRoutes } = await import('../routes/index.js')
  await app.register(registerRoutes, { prefix: '/api' })
  await app.ready()
  await app.close()
  return [...seen.values()].filter((r) => r.path.startsWith('/api/'))
}

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) yield* walk(p)
    else if (/\.ts$/.test(name) && !/\.d\.ts$|\.test\.ts$/.test(name)) yield p
  }
}

const CMD_RE = /cmd(?:<[^>]*>)?\(\s*'(GET|POST|PATCH|PUT|DELETE)'\s*,\s*(?:'([^']*)'|`([^`]*)`)/g

function collectCommands(): Cmd[] {
  const out: Cmd[] = []
  for (const file of walk(SDK_SRC)) {
    const src = readFileSync(file, 'utf8')
    for (const m of src.matchAll(CMD_RE)) {
      const raw = (m[2] ?? m[3] ?? '').replace(/\$\{[^}]*\}/g, ':param')
      // A path built from a variable head (`${base}/x`) cannot be judged.
      if (!raw.startsWith('/')) continue
      const line = src.slice(0, m.index).split('\n').length
      out.push({
        method: m[1],
        path: raw,
        segs: segsOf(raw),
        file: file.slice(ROOT.length + 1),
        line
      })
    }
  }
  return out
}

async function main() {
  const args = new Set(process.argv.slice(2))
  const [routes, cmds] = [await collectRoutes(), collectCommands()]
  const reached = new Set<string>()
  const dead: Cmd[] = []
  for (const c of cmds) {
    const hit = routes.filter((r) => r.method === c.method && routeMatches(r, c))
    if (hit.length === 0) dead.push(c)
    for (const r of hit) reached.add(`${r.method} ${r.path}`)
  }
  const unreached = routes.filter((r) => !reached.has(`${r.method} ${r.path}`))
  const byFamily = new Map<string, Route[]>()
  for (const r of unreached) {
    const fam = r.segs[0] ?? '/'
    byFamily.set(fam, [...(byFamily.get(fam) ?? []), r])
  }
  const covered: Array<[string, Route[]]> = []
  const excluded: Array<[string, Route[], string]> = []
  for (const [fam, list] of [...byFamily].sort((a, b) => b[1].length - a[1].length)) {
    if (fam in NOT_FOR_SDK) excluded.push([fam, list, NOT_FOR_SDK[fam]])
    else covered.push([fam, list])
  }
  const gaps = covered.reduce((n, [, l]) => n + l.length, 0)
  const summary = `sdk coverage: ${routes.length} routes, ${cmds.length} commands reach ${reached.size}; ${gaps} routes in ${covered.length} families have no command (${excluded.reduce((n, [, l]) => n + l.length, 0)} more are not for the SDK); ${dead.length} commands reach no route`

  if (args.has('--json')) {
    console.log(
      JSON.stringify(
        {
          routes: routes.length,
          commands: cmds.length,
          reached: reached.size,
          gaps: covered.map(([family, list]) => ({
            family,
            routes: list.map((r) => `${r.method} ${r.path}`)
          })),
          not_for_sdk: excluded.map(([family, list, why]) => ({ family, why, count: list.length })),
          dead: dead.map((c) => ({ command: `${c.method} ${c.path}`, at: `${c.file}:${c.line}` }))
        },
        null,
        2
      )
    )
    return
  }
  console.log(summary)
  if (args.has('--summary')) return
  console.log('\nRoutes no SDK command reaches:')
  for (const [fam, list] of covered) {
    console.log(`\n  ${fam}  (${list.length})`)
    for (const r of list.sort(
      (a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method)
    ))
      console.log(`    ${r.method.padEnd(6)} ${r.path}`)
  }
  if (dead.length > 0) {
    console.log('\nSDK commands that reach no route:')
    for (const c of dead) console.log(`  ${c.method.padEnd(6)} ${c.path}   ${c.file}:${c.line}`)
  }
  console.log('\nNot for the SDK (counted apart):')
  for (const [fam, list, why] of excluded)
    console.log(`  ${fam.padEnd(20)} ${String(list.length).padStart(3)}  ${why}`)
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err)
    process.exit(0)
  })
