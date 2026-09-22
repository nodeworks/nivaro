/**
 * `pnpm --filter @nivaro/api run dead-columns:check` (#505)
 *
 * Greps the source trees for every registered dead column. A 'drop' entry
 * with a hit fails the run — the column is about to be (or was) dropped and
 * something still names it. A 'retire' entry's hits are listed as the work
 * that unblocks its drop. Exit 1 on a failure, 0 otherwise.
 */
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { DEAD_COLUMNS } from '../db/dead-columns.js'

const root = resolve(process.cwd(), '..')
const TREES = [
  'api/src',
  'api/extensions',
  'packages/shared/src',
  'packages/react/src',
  'packages/sdk/src',
  'admin/src'
]
const SKIP =
  /(\/migrations\/|\/db\/dead-columns\.ts|\/scripts\/dead-columns-check\.ts|\.d\.ts$|\.js$|\.map$|\/tests?\/|node_modules)/

function hits(column: string): string[] {
  const out: string[] = []
  for (const tree of TREES) {
    try {
      const res = execFileSync(
        'grep',
        ['-rnw', '--include=*.ts', '--include=*.tsx', column, resolve(root, tree)],
        {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore']
        }
      )
      for (const line of res.split('\n')) {
        if (!line.trim()) continue
        const file = line.split(':')[0]
        if (SKIP.test(file)) continue
        out.push(line.replace(`${root}/`, ''))
      }
    } catch {
      // grep exit 1 = no matches
    }
  }
  return out
}

let failed = false
for (const d of DEAD_COLUMNS) {
  const h = hits(d.column)
  const head = `${d.table}.${d.column} [${d.status}] — dead since ${d.since}; replaced by ${d.replaced_by}`
  if (d.status === 'drop') {
    if (h.length) {
      failed = true
      console.log(
        `FAIL  ${head}\n      still named by:\n${h.map((l) => `        ${l}`).join('\n')}`
      )
    } else console.log(`ok    ${head}${d.dropped_by ? ` (drop: ${d.dropped_by})` : ''}`)
  } else {
    console.log(
      `retire ${head}\n      blocked by: ${d.blocked_by ?? '?'}\n      code that still names it (${h.length}):\n${h
        .slice(0, 20)
        .map((l) => `        ${l}`)
        .join('\n')}`
    )
  }
}
process.exit(failed ? 1 : 0)
