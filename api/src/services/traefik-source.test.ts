import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  buildProxyView,
  detectShadowing,
  effectivePriority,
  loadProxyView,
  parseRule,
  setTraefikFetchForTests,
  TraefikUnavailableError,
  traefikUrl
} from './traefik-source.js'

const saved = { ...process.env }
beforeEach(() => {
  delete process.env.TRAEFIK_API_URL
  delete process.env.TRAEFIK_API_TOKEN
  delete process.env.TRAEFIK_API_USER
  delete process.env.TRAEFIK_API_PASSWORD
  delete process.env.CLOUD_META_DB_URL
  delete process.env.TELEMETRY_STORE_URL
})
afterEach(() => {
  process.env = { ...saved }
  setTraefikFetchForTests(null)
})

// Traefik v2 shape: no ruleSyntax, priority unset (0), serverStatus on the service.
const v2 = {
  overview: { http: { routers: { total: 3, warnings: 0, errors: 1 } }, providers: ['Docker'] },
  routers: [
    {
      name: 'web@docker',
      provider: 'docker',
      rule: 'Host(`app.example.com`)',
      entryPoints: ['websecure'],
      service: 'web',
      middlewares: ['gz@docker'],
      status: 'enabled',
      tls: { certResolver: 'le' }
    },
    {
      name: 'dead@docker',
      provider: 'docker',
      rule: 'Host(`old.example.com`)',
      entryPoints: ['websecure'],
      service: 'old',
      status: 'enabled'
    },
    {
      name: 'broken@docker',
      provider: 'docker',
      rule: 'Host(`x.example.com`)',
      entryPoints: ['web'],
      service: 'web',
      status: 'disabled',
      error: ['middleware "nope@docker" does not exist']
    }
  ],
  services: [
    {
      name: 'web@docker',
      provider: 'docker',
      type: 'loadbalancer',
      loadBalancer: { servers: [{ url: 'http://10.0.0.2:80' }, { url: 'http://10.0.0.3:80' }] },
      serverStatus: { 'http://10.0.0.2:80': 'UP', 'http://10.0.0.3:80': 'DOWN' },
      usedBy: ['web@docker']
    },
    {
      name: 'old@docker',
      provider: 'docker',
      type: 'loadbalancer',
      loadBalancer: { servers: [{ url: 'http://10.0.0.9:80' }] },
      serverStatus: { 'http://10.0.0.9:80': 'DOWN' },
      usedBy: ['dead@docker']
    }
  ],
  middlewares: [{ name: 'gz@docker', type: 'compress', provider: 'docker', status: 'enabled' }],
  entrypoints: [{ name: 'websecure', address: ':443' }]
}

// Traefik v3 shape: ruleSyntax + computed priority, same service layout.
const v3 = {
  overview: { http: { routers: { total: 2, warnings: 0, errors: 0 } }, providers: ['Swarm'] },
  routers: [
    {
      name: 'api@swarm',
      provider: 'swarm',
      rule: 'PathPrefix(`/api`)',
      ruleSyntax: 'v3',
      priority: 1000,
      entryPoints: ['websecure'],
      service: 'api@swarm',
      status: 'enabled',
      using: ['websecure']
    },
    {
      name: 'api-x@swarm',
      provider: 'swarm',
      rule: 'PathPrefix(`/api/x`)',
      ruleSyntax: 'v3',
      priority: 12,
      entryPoints: ['websecure'],
      service: 'apix@swarm',
      status: 'enabled'
    }
  ],
  services: [
    {
      name: 'api@swarm',
      provider: 'swarm',
      type: 'loadbalancer',
      loadBalancer: { servers: [{ url: 'http://a:3055' }] },
      serverStatus: { 'http://a:3055': 'UP' }
    },
    {
      name: 'apix@swarm',
      provider: 'swarm',
      type: 'loadbalancer',
      loadBalancer: { servers: [{ url: 'http://b:3055' }] }
    }
  ],
  middlewares: [],
  entrypoints: []
}

type Input = Parameters<typeof buildProxyView>[0]

describe('traefikUrl', () => {
  it('needs an http(s) URL and is off in cloud mode', () => {
    expect(traefikUrl()).toBeNull()
    process.env.TRAEFIK_API_URL = 'http://traefik:8080/'
    expect(traefikUrl()).toBe('http://traefik:8080')
    process.env.CLOUD_META_DB_URL = 'x'
    expect(traefikUrl()).toBeNull()
  })
})

describe('parseRule / effectivePriority', () => {
  it('splits path and other matchers; gives up on || and regexps', () => {
    const p = parseRule('Host(`a.com`) && PathPrefix(`/api`)')
    expect(p.simple).toBe(true)
    expect(p.prefixes).toEqual(['/api'])
    expect(p.other).toEqual(['Host(a.com)'])
    expect(parseRule('Host(`a`) || Host(`b`)').simple).toBe(false)
    expect(parseRule('PathRegexp(`^/a`)').simple).toBe(false)
  })

  it('defaults priority to the rule length', () => {
    expect(effectivePriority({ rule: 'Host(`a.com`)', priority: 0 })).toBe(13)
    expect(effectivePriority({ rule: 'x', priority: 7 })).toBe(7)
  })
})

describe('detectShadowing', () => {
  it('flags a higher-priority broad PathPrefix taking a narrower one', () => {
    const found = detectShadowing([
      { name: 'A', rule: 'PathPrefix(`/api`)', priority: 100, entrypoints: ['web'] },
      { name: 'B', rule: 'PathPrefix(`/api/x`)', priority: 20, entrypoints: ['web'] }
    ])
    expect(found).toHaveLength(1)
    expect(found[0].winner).toBe('A')
    expect(found[0].loser).toBe('B')
    expect(found[0].sentence).toContain('Requests for /api/x go to A, not B')
  })

  it('ignores the normal case (longer rule wins by default priority)', () => {
    expect(
      detectShadowing([
        {
          name: 'A',
          rule: 'PathPrefix(`/api`)',
          priority: effectivePriority({ rule: 'PathPrefix(`/api`)' }),
          entrypoints: ['web']
        },
        {
          name: 'B',
          rule: 'PathPrefix(`/api/x`)',
          priority: effectivePriority({ rule: 'PathPrefix(`/api/x`)' }),
          entrypoints: ['web']
        }
      ])
    ).toEqual([])
  })

  it('needs a shared entrypoint and no extra host constraint on the winner', () => {
    expect(
      detectShadowing([
        { name: 'A', rule: 'PathPrefix(`/api`)', priority: 100, entrypoints: ['web'] },
        { name: 'B', rule: 'PathPrefix(`/api/x`)', priority: 20, entrypoints: ['other'] }
      ])
    ).toEqual([])
    expect(
      detectShadowing([
        {
          name: 'A',
          rule: 'Host(`a.com`) && PathPrefix(`/api`)',
          priority: 100,
          entrypoints: ['web']
        },
        { name: 'B', rule: 'PathPrefix(`/api/x`)', priority: 20, entrypoints: ['web'] }
      ])
    ).toEqual([])
  })
})

describe('buildProxyView', () => {
  it('v2: resolves services, flags routers with no healthy backend', () => {
    const view = buildProxyView(v2 as unknown as Input)
    expect(view.version).toBe('v2')
    const web = view.routers.find((r) => r.name === 'web@docker')!
    expect(web.healthy).toBe(1)
    expect(web.no_healthy_backend).toBe(false)
    expect(web.tls).toBe(true)
    expect(web.tls_resolver).toBe('le')
    expect(web.priority_default).toBe(true)
    const dead = view.routers.find((r) => r.name === 'dead@docker')!
    expect(dead.no_healthy_backend).toBe(true)
    expect(view.provider_errors.map((e) => e.router)).toEqual(['broken@docker'])
    expect(view.entrypoints).toEqual([{ name: 'websecure', address: ':443' }])
  })

  it('v3: reads ruleSyntax, detects shadowing, keeps unchecked servers as unknown', () => {
    const view = buildProxyView(v3 as unknown as Input)
    expect(view.version).toBe('v3')
    expect(view.shadowing).toHaveLength(1)
    const loser = view.routers.find((r) => r.name === 'api-x@swarm')!
    expect(loser.shadowed_by?.winner).toBe('api@swarm')
    // No health check configured on apix: the server is "unknown", not down.
    expect(loser.servers[0].status).toBe('unknown')
    expect(loser.no_healthy_backend).toBe(false)
  })
})

describe('loadProxyView', () => {
  it('GETs the five paths with the bearer, hides rate columns without a store', async () => {
    process.env.TRAEFIK_API_URL = 'http://traefik:8080'
    process.env.TRAEFIK_API_TOKEN = 'secret-token'
    const seen: Array<{ url: string; method?: string; auth?: string }> = []
    setTraefikFetchForTests(async (url, init) => {
      seen.push({
        url,
        method: init.method,
        auth: (init.headers as Record<string, string>).authorization
      })
      const path = url.replace('http://traefik:8080', '')
      const body: Record<string, unknown> = {
        '/api/overview': v3.overview,
        '/api/http/routers': v3.routers,
        '/api/http/services': v3.services,
        '/api/http/middlewares': v3.middlewares,
        '/api/entrypoints': v3.entrypoints
      }
      return new Response(JSON.stringify(body[path]), { status: 200 })
    })
    const view = await loadProxyView()
    expect(seen).toHaveLength(5)
    expect(seen.every((s) => s.method === 'GET' && s.auth === 'Bearer secret-token')).toBe(true)
    expect(view.metrics).toEqual({ available: false, reason: 'telemetry store not configured' })
    expect(JSON.stringify(view)).not.toContain('secret-token')
  })

  it('names a refused credential without echoing it', async () => {
    process.env.TRAEFIK_API_URL = 'http://traefik:8080'
    process.env.TRAEFIK_API_USER = 'u'
    process.env.TRAEFIK_API_PASSWORD = 'hunter2'
    setTraefikFetchForTests(async () => new Response('no', { status: 401 }))
    const err = await loadProxyView().catch((e) => e)
    expect(err).toBeInstanceOf(TraefikUnavailableError)
    expect(String(err.message)).not.toContain('hunter2')
  })
})
