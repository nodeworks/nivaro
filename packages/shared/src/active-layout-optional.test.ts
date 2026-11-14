import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// GET /collection-layouts/active answers 404 for a collection without a form unless the
// caller says the form is optional. Our own screens only ever ask "is there one?", and each
// plain ask was a 404 in the request log (322 in the first four days live). Every read of
// that route in the admin, the shared components and the react package must carry
// `optional`: shared and react through getActiveLayout (lib/commands), the admin's axios
// calls by naming the flag.

const ROUTE = '/collection-layouts/active'
const here = dirname(fileURLToPath(import.meta.url))
const repo = join(here, '..', '..', '..')
const ROOTS = ['packages/shared/src', 'packages/react/src', 'admin/src']
// Not requests our screens make: reference docs, the playground's sample call a person runs, and
// the query-key registry (it names the route as a shape signature, never calls it).
const SKIP = [
  /\/docs\//,
  /packages\/shared\/src\/lib\/query-keys\.ts$/,
  /admin\/src\/pages\/Playground\.tsx$/,
  /admin\/src\/pages\/SdkPlayground\.tsx$/
]

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name.startsWith('.')) continue
    const full = join(dir, name)
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full))
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name) && !name.endsWith('.d.ts'))
      out.push(full)
  }
  return out
}

/** Lines that name the route in code (not in a comment) without `optional` in the same call. */
function plainActiveLayoutReads(src: string): number[] {
  const lines = src.split('\n')
  const hits: number[] = []
  lines.forEach((text, i) => {
    const code = text.replace(/^\s*(\/\/|\*|\/\*).*$/, '').replace(/\s\/\/.*$/, '')
    if (!code.includes(ROUTE)) return
    // The call's own arguments: this line and the few after it.
    const call = lines.slice(i, i + 8).join('\n')
    if (!/\boptional\b/.test(call)) hits.push(i + 1)
  })
  return hits
}

describe('reads of the active form are optional', () => {
  it('the scanner tells a plain read from an optional one', () => {
    expect(plainActiveLayoutReads("get('/collection-layouts/active', { collection })")).toEqual([1])
    expect(
      plainActiveLayoutReads("get('/collection-layouts/active', { collection, optional: 1 })")
    ).toEqual([])
    expect(
      plainActiveLayoutReads(
        "api.get('/collection-layouts/active', {\n  params: {\n    collection,\n    optional: 1\n  }\n})"
      )
    ).toEqual([])
    expect(plainActiveLayoutReads('// see GET /collection-layouts/active for the shape')).toEqual(
      []
    )
    expect(plainActiveLayoutReads(' * (GET /collection-layouts/active): the parent')).toEqual([])
  })

  it('no screen asks without it', () => {
    const offenders: string[] = []
    for (const root of ROOTS) {
      for (const file of sourceFiles(join(repo, root))) {
        const rel = relative(repo, file)
        if (SKIP.some((re) => re.test(rel))) continue
        for (const line of plainActiveLayoutReads(readFileSync(file, 'utf8')))
          offenders.push(`${rel}:${line}`)
      }
    }
    expect(offenders).toEqual([])
  })
})
