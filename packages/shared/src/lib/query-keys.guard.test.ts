import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  commandEndpoints,
  findCollisions,
  functionIndex,
  type QuerySite,
  registryMismatches,
  type ScanOptions,
  scanDir,
  scanSource,
  shapesCompatible,
  sourceFiles
} from './query-key-scan'
import {
  QUERY_KEY_BUILDERS,
  QUERY_KEY_DISJOINT,
  QUERY_KEY_SPECS,
  QUERY_RESPONSE_CLIENTS,
  queryKeys
} from './query-keys'

// Prod 2026-11-13 "nn.find is not a function": two readers stored different shapes under
// ['collection-meta', c]. One QueryClient serves every screen of an app (and the shared
// components inside it), so a key must hold ONE shape for every reader. This guard scans the
// shared library, the react package and the admin app statically. Limits: query-key-scan.ts.

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '../../../..')

function scanAll(): QuerySite[] {
  const dirs = [
    { dir: resolve(repo, 'packages/shared/src'), scope: 'shared' },
    { dir: resolve(repo, 'packages/react/src'), scope: 'shared' },
    { dir: resolve(repo, 'admin/src'), scope: 'admin' }
  ].filter((d) => existsSync(d.dir))
  const common: ScanOptions = {
    base: repo,
    builders: QUERY_KEY_BUILDERS,
    responseClients: QUERY_RESPONSE_CLIENTS,
    sdkEndpoints: commandEndpoints([
      ...sourceFiles(resolve(repo, 'packages/sdk/src/commands')),
      resolve(repo, 'packages/shared/src/lib/commands.ts')
    ])
  }
  const functionShapes = functionIndex(
    dirs.flatMap((d) => sourceFiles(d.dir)),
    common
  )
  return dirs.flatMap((d) => scanDir(d.dir, { ...common, scope: d.scope, functionShapes }))
}

const fmt = (s: QuerySite) => `${s.file}:${s.line} [${s.pattern?.join(', ')}] ${s.shape}`

describe('the query-key scanner', () => {
  const scan = (src: string, opts: ScanOptions = {}) =>
    scanSource('x.tsx', src, { responseClients: ['api'], ...opts })

  it('reads the shared client and axios to the same shape', () => {
    const [a] = scan(
      `useQuery({ queryKey: ['m', c], queryFn: () => client.request(get(\`/collections/\${c}\`)).then((r) => r.data) })`
    )
    const [b] = scan(
      `useQuery({ queryKey: ['m', c], queryFn: () => api.get(\`/collections/\${c}\`).then((r) => r.data.data) })`
    )
    const [d] = scan(
      `useQuery({ queryKey: ['m', c], queryFn: async () => (await api.get(\`/collections/\${c}\`)).data.data })`
    )
    expect(a.shape).toBe('GET /collections/:p .data')
    expect(b.shape).toBe(a.shape)
    expect(d.shape).toBe(a.shape)
  })

  it('finds the 2026-11-13 crash: relations array vs meta object under one key', () => {
    const sites = scan(`
      useQuery({ queryKey: ['collection-meta', c], queryFn: () => client.request(get(\`/collections/\${c}\`)).then((r) => r.data) })
      useQuery({ queryKey: ['collection-meta', related], queryFn: () =>
        client.request(get(\`/collections/\${related}\`)).then((r) => { const d = r.data as X; return d?.relations ?? [] }) })
    `)
    expect(sites.map((s) => s.shape)).toEqual([
      'GET /collections/:p .data',
      'GET /collections/:p .data.relations'
    ])
    expect(findCollisions(sites).map((c) => c.root)).toEqual(['collection-meta'])
  })

  it('treats defaults, empty fallbacks, catch and select as the same shape; map/filter as new', () => {
    const shapes = scan(`
      useQuery({ queryKey: ['k'], queryFn: () => api.get('/x').then((r) => r.data.data ?? []) })
      useQuery({ queryKey: ['k'], queryFn: () => api.get('/x').then((r) => (Array.isArray(r.data.data) ? r.data.data : [])).catch(() => []), select: (d) => d.length })
      useQuery({ queryKey: ['k'], queryFn: () => api.get('/x').then((r) => r.data.data.filter((f) => !f.hidden)) })
    `).map((s) => s.shape)
    expect(shapes).toEqual(['GET /x .data', 'GET /x .data', 'GET /x .data →filter'])
  })

  it('reads registry builders as their root', () => {
    const [s] = scan(
      'useQuery({ queryKey: queryKeys.collectionRelations(c), queryFn: () => fetchCollectionRelations(client, c) })',
      { builders: QUERY_KEY_BUILDERS }
    )
    expect(s.root).toBe('collection-relations')
    expect(s.builder).toBe('collectionRelations')
  })

  it('never compares keys that cannot meet: other lengths, other literals, other apps', () => {
    const sites = [
      ...scan(`
        useQuery({ queryKey: ['k', 'a'], queryFn: () => api.get('/a').then((r) => r.data) })
        useQuery({ queryKey: ['k', 'b'], queryFn: () => api.get('/b').then((r) => r.data) })
        useQuery({ queryKey: ['k', 'a', id], queryFn: () => api.get('/c').then((r) => r.data) })
      `),
      ...scanSource('y.tsx', "useQuery({ queryKey: ['k', 'a'], queryFn: () => apiFetch('/d') })", {
        scope: 'portal'
      }).map((s) => s),
      ...scanSource('z.tsx', "useQuery({ queryKey: ['k', 'a'], queryFn: () => apiFetch('/e') })", {
        scope: 'admin'
      })
    ]
    // portal vs admin never share a client; everything else differs by key
    const collisions = findCollisions(sites)
    expect(collisions.map((c) => c.shapes.flatMap((g) => g.sites.map((s) => s.file)))).toEqual([
      ['x.tsx', 'y.tsx', 'z.tsx']
    ])
  })

  it('reads a helper by what it returns, here or (through the index) in another file', () => {
    const helper = `export function fetchRels(client, c) {
      return client.request(get(\`/collections/\${c}\`)).then((r) => r.data.relations)
    }`
    const [local] = scan(
      `${helper}\nuseQuery({ queryKey: ['r', c], queryFn: () => fetchRels(client, c) })`
    )
    expect(local.shape).toBe('GET /collections/:p .data.relations')
    const [remote] = scan("useQuery({ queryKey: ['r', c], queryFn: () => fetchRels(client, c) })", {
      functionShapes: new Map([['fetchRels', 'GET /collections/:p .data.relations']])
    })
    expect(remote.shape).toBe(local.shape)
  })

  it('compares URLs up to parameters', () => {
    expect(
      shapesCompatible(
        'GET /pipelines/instance/:p/:p .data',
        'GET /pipelines/instance/nivaro_addendums/:p .data'
      )
    ).toBe(true)
    expect(shapesCompatible('GET /x/:p .data', 'GET /x/:p .data.relations')).toBe(false)
  })
})

describe('shared query keys', () => {
  const sites = scanAll()

  it('scans a real amount of code', () => {
    expect(sites.filter((s) => s.kind === 'read').length).toBeGreaterThan(1000)
  })

  it('no key is read with two shapes', () => {
    const collisions = findCollisions(sites, QUERY_KEY_DISJOINT)
    const report = collisions.flatMap((c) => [
      c.root,
      ...c.shapes.flatMap((g) => [`  ${g.shape}`, ...g.sites.map((s) => `    ${fmt(s)}`)])
    ])
    expect(
      report,
      'Give the odd reader its own key, or keep the shape and narrow with `select`'
    ).toEqual([])
  })

  it('every reader of a registry key stores the shape the registry declares', () => {
    const wrong = registryMismatches(sites, QUERY_KEY_SPECS).map(
      ({ site, declared }) => `${fmt(site)}  (declared: ${declared.join(' | ')})`
    )
    expect(
      wrong,
      'Registry keys hold one shape (lib/query-keys.ts): use the shared fetcher, a plain `.then(r => r.data)`, or `select` to narrow'
    ).toEqual([])
  })

  it('the builders and the scanner map agree', () => {
    expect(Object.keys(QUERY_KEY_BUILDERS).sort()).toEqual(Object.keys(queryKeys).sort())
    for (const [name, root] of Object.entries(QUERY_KEY_BUILDERS)) {
      const build = (queryKeys as unknown as Record<string, (c?: string) => readonly unknown[]>)[
        name
      ]
      expect(build('c')[0]).toBe(root)
    }
  })

  it('every builder root is declared in the registry', () => {
    for (const root of Object.values(QUERY_KEY_BUILDERS))
      expect(
        QUERY_KEY_SPECS.some((k) => k.root === root),
        root
      ).toBe(true)
  })
})
