import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { HUB_ROUTES } from '../../../services/hub/api/catalog.js'

// Two guards over the Hub's API surface:
//  1. every route mounted under /api/hub has a catalog entry (and no entry names a route that is
//     gone) — the catalog decides which API-key scope a Hub route needs and what OpenAPI lists;
//  2. the credential gate is installed once at the root of the API routes, BEFORE any plugin is
//     registered, so every /api/hub plugin (today's and any added later) is behind it.
// Hub route files are found by where routes/index.ts mounts them (prefix /hub or /hub/…), plus
// the files routes/hub.ts pulls in — never by file name (an app-side file such as a /hub-link
// plugin is not a Hub route). Paste the printed lines into services/hub/api/catalog.ts.

const ROUTES_DIR = join(import.meta.dirname, '../../../routes')
const read = (f: string) => readFileSync(join(ROUTES_DIR, f), 'utf8')

/** `import { a, b } from './x.js'` → name → file. */
function importsOf(src: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const m of src.matchAll(/import\s*\{([^}]+)\}\s*from\s*'\.\/([^']+)\.js'/g))
    for (const name of m[1].split(',').map((s) => s.replace(/^type\s+/, '').trim()))
      if (name) out.set(name, `${m[2]}.ts`)
  return out
}

/** Hub route files → the sub-prefix under /api/hub they are mounted at. */
function hubFiles(): Map<string, string> {
  const index = read('index.ts')
  const names = importsOf(index)
  const files = new Map<string, string>()
  for (const m of index.matchAll(
    /app\.register\(\s*([A-Za-z0-9_]+)\s*,\s*\{\s*prefix:\s*'(\/hub(?:\/[^']*)?)'\s*\}/g
  )) {
    const file = names.get(m[1])
    if (file) files.set(file, m[2].slice('/hub'.length))
  }
  // Route files hubRoutes registers in its own scope (prefix /hub).
  for (const [, file] of importsOf(read('hub.ts')))
    if (/^hub-.*\.ts$/.test(file) && existsSync(join(ROUTES_DIR, file)) && !files.has(file))
      files.set(file, files.get('hub.ts') ?? '')
  return files
}

function registered(): string[] {
  const out: string[] = []
  for (const [file, prefix] of hubFiles()) {
    const src = read(file)
    for (const m of src.matchAll(/\bapp\.(get|post|put|patch|delete)(?:<[^>]*>)?\(\s*'([^']+)'/g))
      out.push(`${m[1].toUpperCase()} ${prefix}${m[2]}`)
  }
  return [...new Set(out)].sort()
}

describe('Hub API catalog', () => {
  it('finds the Hub route files by mount prefix, never app-side ones', () => {
    const files = [...hubFiles().keys()]
    expect(files).toEqual(expect.arrayContaining(['hub.ts', 'hub-signin-admin.ts', 'hub-move.ts']))
    for (const f of ['hub-link.ts', 'hub-deployment-link.ts', 'hub-transfer.ts', 'hub-switcher.ts'])
      expect(files).not.toContain(f)
  })

  it('lists exactly the routes mounted under /api/hub', () => {
    const routes = registered()
    const listed = [...new Set(HUB_ROUTES.map((e) => `${e.method} ${e.path}`))].sort()
    const missing = routes.filter((r) => !listed.includes(r))
    const stale = listed.filter((r) => !routes.includes(r))
    const paste = `Hub routes without a catalog entry — add to services/hub/api/catalog.ts:\n${missing
      .map((r) => {
        const [method, path] = r.split(' ')
        return `  r('${method}', '${path}', '<group>', '<admin|owner>', '${method === 'GET' ? 'read' : 'write'}', '<summary>'),`
      })
      .join('\n')}`
    expect(missing, paste).toEqual([])
    expect(stale, 'catalog entries for routes that are gone').toEqual([])
    expect(routes.length).toBeGreaterThan(90)
  })

  it('has one entry per method + path, and plans are POSTs ending in /plan', () => {
    const keys = HUB_ROUTES.map((e) => `${e.method} ${e.path}`)
    expect(new Set(keys).size).toBe(keys.length)
    for (const e of HUB_ROUTES) {
      if (e.access === 'plan') expect(`${e.method} ${e.path}`).toMatch(/^POST .*\/plan$/)
      if (e.method === 'GET') expect(e.access).toBe('read')
      if (/\/plan$/.test(e.path) && e.method === 'POST') expect(e.access).toBe('plan')
    }
  })
})

describe('Hub credential gate placement', () => {
  it('is installed at the root of registerRoutes before any plugin is registered', () => {
    const index = read('index.ts')
    const body = index.slice(index.indexOf('export async function registerRoutes'))
    const gate = body.indexOf('installHubCredentialGate(app)')
    const firstRegister = body.indexOf('app.register(')
    expect(gate).toBeGreaterThan(0)
    expect(gate).toBeLessThan(firstRegister)
  })

  it('no Hub plugin is registered outside registerRoutes (server.ts mounts none)', () => {
    const server = readFileSync(join(ROUTES_DIR, '../server.ts'), 'utf8')
    expect(server).not.toMatch(/prefix:\s*'\/api\/hub/)
    // …and no Hub route file installs its own (a second, partial) gate.
    for (const [file] of hubFiles())
      expect(read(file), file).not.toContain('installHubCredentialGate(')
  })
})
