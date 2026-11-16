import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// `useQuery({queryKey, queryFn: skipToken})` beside the component that really fetches that key
// writes skipToken onto the shared Query: the next invalidate/refetch of the key fails with
// "Missing queryFn" and sends nothing (report Reset cache, 2026-11-16). Read an entry another
// component fetches with useQueryEntryState (lib/use-query-entry.ts). Covers shared + admin.

const here = dirname(fileURLToPath(import.meta.url))
const repo = join(here, '../../../..')
const roots = [join(here, '..'), join(repo, 'admin/src')].filter((p) => existsSync(p))

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist') continue
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...sourceFiles(p))
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p)
  }
  return out
}

describe('no skipToken observers', () => {
  it('no source file passes queryFn: skipToken', () => {
    expect(roots.length).toBe(2)
    const hits: string[] = []
    for (const root of roots)
      for (const f of sourceFiles(root))
        if (/queryFn\s*:\s*skipToken\b/.test(readFileSync(f, 'utf8'))) hits.push(relative(repo, f))
    expect(hits).toEqual([])
  })
})
