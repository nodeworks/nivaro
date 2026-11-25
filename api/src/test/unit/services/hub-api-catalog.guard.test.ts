import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { HUB_ROUTES } from '../../../services/hub/api/catalog.js'

// Every route the Hub route files register under /api/hub has a catalog entry (and no entry names
// a route that is gone). The catalog decides which API-key scope a Hub route needs and what the
// OpenAPI reference lists, so a route added without an entry fails here. Paste the printed lines
// into services/hub/api/catalog.ts and fill in group / auth / access / summary.

const ROUTES_DIR = join(import.meta.dirname, '../../../routes')

/** Route files that are NOT under /api/hub (an app's side, the deployment link, transfers). */
const NOT_HUB = new Set([
  'hub-link.ts',
  'hub-deployment-link.ts',
  'hub-transfer.ts',
  'hub-switcher.ts'
])
/** Files registered under a sub-prefix of /api/hub (routes/index.ts). */
const PREFIX: Record<string, string> = {
  'hub-signin-admin.ts': '/signin',
  'hub-oidc.ts': '/oidc',
  'hub-app-link.ts': '/app-link'
}

function registered(): string[] {
  const out: string[] = []
  for (const f of readdirSync(ROUTES_DIR)) {
    if (!/^hub(-.*)?\.ts$/.test(f) || f.includes('.test.') || NOT_HUB.has(f)) continue
    if (f.startsWith('hub-link-')) continue
    const src = readFileSync(join(ROUTES_DIR, f), 'utf8')
    for (const m of src.matchAll(/\bapp\.(get|post|put|patch|delete)(?:<[^>]*>)?\(\s*'([^']+)'/g))
      out.push(`${m[1].toUpperCase()} ${PREFIX[f] ?? ''}${m[2]}`)
  }
  return [...new Set(out)].sort()
}

describe('Hub API catalog', () => {
  it('lists exactly the routes the Hub route files register', () => {
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
    expect(stale).toEqual([])
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
