import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { breakGlassRefusal } from '../../../services/break-glass-guard.js'
import { ACCESS_ROUTES } from '../../../services/record-events.js'

// Guard (security review of hub-enh/security): while a Nivaro Hub break-glass grant holds the
// caller, every write route that the ACCESS_ROUTES registry names, and every credential / account
// route, is refused (services/break-glass-guard.ts). The scan reads every route file
// routes/index.ts mounts (by its prefix) and every write route in it; a new access or credential
// route the guard does not refuse fails here. Endings (revoke a key, end a View-as, sign out) and
// the caller's own preferences stay open on purpose.

const ROUTES = join(import.meta.dirname, '../../../routes')
const read = (f: string) => readFileSync(join(ROUTES, f), 'utf8')

function importsOf(src: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const m of src.matchAll(/import\s*\{([^}]+)\}\s*from\s*'\.\/([^']+)\.js'/g))
    for (const name of m[1].split(',').map((s) => s.replace(/^type\s+/, '').trim()))
      if (name) out.set(name, `${m[2]}.ts`)
  return out
}

interface Route {
  method: string
  template: string
}

/** Every write route under /api: routes/index.ts mounts → file → `app.<verb>('path'`. */
function writeRoutes(): Route[] {
  const index = read('index.ts')
  const names = importsOf(index)
  const out: Route[] = []
  const seen = new Set<string>()
  const mounts: Array<[string, string]> = []
  for (const m of index.matchAll(
    /app\.register\(\s*([A-Za-z0-9_]+)\s*(?:,\s*\{\s*prefix:\s*'([^']*)'\s*\})?\s*\)/g
  )) {
    const file = names.get(m[1])
    if (file && existsSync(join(ROUTES, file))) mounts.push([file, m[2] ?? ''])
  }
  for (const [file, prefix] of mounts) {
    const src = read(file)
    for (const m of src.matchAll(
      /\bapp\.(post|put|patch|delete)\s*(?:<[^()]*?>)?\(\s*'([^']+)'/g
    )) {
      const template = `/api${prefix}${m[2] === '/' ? '' : m[2]}`.replace(/\/$/, '') || '/api'
      const key = `${m[1].toUpperCase()} ${template}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push({ method: m[1].toUpperCase(), template })
    }
  }
  return out
}

/** A concrete path for a template (`:id` → an id-shaped segment). */
const sample = (t: string) => t.replace(/:[A-Za-z_]+/g, '1a2b')

const CREDENTIAL_OR_ACCOUNT =
  /^\/api\/(users|auth\/(me|masquerade|setup|totp|devices)|api-keys|mcp-connections|oauth|user-groups|workspaces|settings)(\/|$)/

const ALLOWED_ENDINGS = new Set([
  'DELETE /api/api-keys/:id',
  'DELETE /api/oauth/connections/:id',
  'DELETE /api/auth/devices/:id',
  'DELETE /api/mcp-connections/:conn',
  'POST /api/api-keys/:id/revoke',
  'DELETE /api/auth/masquerade',
  'DELETE /api/users/me/token',
  'PATCH /api/auth/me/last-page'
])

describe('break-glass guard covers every access and credential write', () => {
  const routes = writeRoutes()

  it('the scan finds the routes it must (the scan works)', () => {
    const keys = new Set(routes.map((r) => `${r.method} ${r.template}`))
    for (const k of [
      'POST /api/users/:id/token',
      'PATCH /api/users/:id',
      'POST /api/api-keys',
      'POST /api/api-keys/:id/simulate-token',
      'POST /api/auth/masquerade',
      'POST /api/roles',
      'POST /api/access-requests/:id/resolve'
    ])
      expect(keys.has(k), k).toBe(true)
    expect(routes.length).toBeGreaterThan(300)
  })

  it('refuses each one under a grant (except the listed endings)', () => {
    const open: string[] = []
    for (const r of routes) {
      const key = `${r.method} ${r.template}`
      const url = sample(r.template)
      const governed =
        ACCESS_ROUTES.test(url) ||
        ACCESS_ROUTES.test(r.template) ||
        CREDENTIAL_OR_ACCOUNT.test(r.template)
      if (!governed || ALLOWED_ENDINGS.has(key)) continue
      if (!breakGlassRefusal({ method: r.method, template: r.template, url, body: { role: 'x' } }))
        open.push(key)
    }
    expect(open).toEqual([])
  })

  it('the endings stay open; own preferences only with listed keys', () => {
    for (const k of ALLOWED_ENDINGS) {
      const [method, template] = k.split(' ')
      expect(breakGlassRefusal({ method, template, url: sample(template) }), k).toBeNull()
    }
    const prefs = {
      method: 'PATCH',
      template: '/api/users/me/preferences',
      url: '/api/users/me/preferences'
    }
    expect(breakGlassRefusal({ ...prefs, body: { theme: 'dark' } })).toBeNull()
    expect(breakGlassRefusal({ ...prefs, body: { theme: 'dark', role: 'r' } })).not.toBeNull()
    expect(breakGlassRefusal({ ...prefs, body: {} })).not.toBeNull()
  })

  it('system tables through /items, GraphQL mutations and parser tricks are refused', () => {
    const items = (c: string) => ({
      method: 'POST',
      template: '/api/items/:collection',
      url: `/api/items/${c}`
    })
    expect(breakGlassRefusal(items('nivaro_users'))).not.toBeNull()
    expect(breakGlassRefusal(items('nivaro_api_keys'))).not.toBeNull()
    expect(breakGlassRefusal(items('workflows'))).toBeNull()
    expect(
      breakGlassRefusal({
        method: 'POST',
        template: '/api/graphql',
        url: '/api/graphql',
        body: { query: 'mutation { update_nivaro_users_item(id: 1, data: {}) { id } }' }
      })
    ).not.toBeNull()
    expect(
      breakGlassRefusal({
        method: 'POST',
        template: '/api/graphql',
        url: '/api/graphql',
        body: { query: '{ workflows { id } }' }
      })
    ).toBeNull()
    // A doubled slash or a query string never slips past the template match.
    expect(
      breakGlassRefusal({
        method: 'POST',
        template: '/api/users/:id/token',
        url: '//api//users/x/token?a=1'
      })
    ).not.toBeNull()
  })
})
