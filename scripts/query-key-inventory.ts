/**
 * Query-key inventory: every TanStack Query key with a literal root in the shared package, the
 * react package and the admin app (+ any extra source dirs given as arguments, e.g. efp-new),
 * the shape each reader stores under it, and the keys read with more than one shape.
 *
 *   pnpm query-keys [--json] [--all] [extra-src-dir…]   (e.g. pnpm query-keys ../efp-new/src)
 *
 * --all lists every key, not only the collisions. The scanner and its limits:
 * packages/shared/src/lib/query-key-scan.ts. The guard tests (query-keys.guard.test.ts) fail
 * on a collision; this script is the readable report.
 */
import { resolve } from 'node:path'
import {
  commandEndpoints,
  findCollisions,
  functionIndex,
  isKnownShape,
  type QuerySite,
  registryMismatches,
  scanDir,
  sourceFiles
} from '../packages/shared/src/lib/query-key-scan.ts'
import {
  QUERY_KEY_BUILDERS,
  QUERY_KEY_DISJOINT,
  QUERY_KEY_SPECS,
  QUERY_RESPONSE_CLIENTS
} from '../packages/shared/src/lib/query-keys.ts'

const root = resolve(import.meta.dirname, '..')
const args = process.argv.slice(2)
const json = args.includes('--json')
const all = args.includes('--all')
const extra = args.filter((a) => !a.startsWith('--'))

const sdkEndpoints = commandEndpoints([
  ...sourceFiles(resolve(root, 'packages/sdk/src/commands')),
  resolve(root, 'packages/shared/src/lib/commands.ts'),
  resolve(root, 'packages/react/src/lib/commands.ts')
])

const dirs: Array<{ dir: string; base: string; scope: string }> = [
  { dir: resolve(root, 'packages/shared/src'), base: root, scope: 'shared' },
  { dir: resolve(root, 'packages/react/src'), base: root, scope: 'shared' },
  { dir: resolve(root, 'admin/src'), base: root, scope: 'admin' },
  // Each extra app is its own QueryClient: it meets the shared library, never admin.
  ...extra.map((d) => ({ dir: resolve(d), base: resolve(d, '..'), scope: resolve(d) }))
]
const common = {
  builders: QUERY_KEY_BUILDERS,
  responseClients: QUERY_RESPONSE_CLIENTS,
  sdkEndpoints
}
const functionShapes = functionIndex(
  dirs.flatMap((d) => sourceFiles(d.dir)),
  common
)
const sites: QuerySite[] = dirs.flatMap((d) =>
  scanDir(d.dir, { ...common, base: d.base, scope: d.scope, functionShapes })
)

const collisions = findCollisions(sites, QUERY_KEY_DISJOINT)
const mismatches = registryMismatches(sites, QUERY_KEY_SPECS)
const out = (line: string) => process.stdout.write(`${line}\n`)

if (json) {
  out(JSON.stringify({ sites, collisions, mismatches }, null, 2))
} else {
  const readers = sites.filter((s) => s.kind === 'read')
  const known = readers.filter((s) => isKnownShape(s.shape))
  out(
    `${sites.length} key sites, ${readers.length} readers (${known.length} with a known shape), ` +
      `${new Set(sites.map((s) => s.root)).size} roots`
  )
  if (all) {
    const byRoot = new Map<string, QuerySite[]>()
    for (const s of sites) byRoot.set(s.root, [...(byRoot.get(s.root) ?? []), s])
    for (const [r, list] of [...byRoot].sort((a, b) => a[0].localeCompare(b[0]))) {
      out(`\n${r}`)
      for (const s of list)
        out(
          `  ${s.kind.padEnd(6)} [${s.pattern?.join(', ') ?? '…'}] ${s.shape ?? s.typeArg ?? ''}  ${s.file}:${s.line}`
        )
    }
  }
  out(`\n${collisions.length} key(s) read with more than one shape`)
  for (const c of collisions) {
    out(`\n${c.root}`)
    for (const g of c.shapes) {
      out(`  ${g.shape}`)
      for (const s of g.sites) out(`    [${s.pattern?.join(', ')}] ${s.file}:${s.line}`)
    }
  }
  out(`\n${mismatches.length} reader(s) of a registry key with another shape (lib/query-keys.ts)`)
  for (const { site, declared } of mismatches)
    out(
      `  ${site.file}:${site.line} [${site.pattern?.join(', ')}] ${site.shape} — declared ${declared.join(' | ')}`
    )
}
process.exitCode = collisions.length || mismatches.length ? 1 : 0
