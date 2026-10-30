import Fastify, { type FastifyInstance } from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Command Center shell (slice 4): wallboard (kiosk) links read AS THEIR CREATOR for Command
// Center GETs only; writes, other prefixes, expired / revoked links and creators who could not
// use the board themselves are refused. Prefs are the caller's own.

type Row = Record<string, unknown>
const m = vi.hoisted(() => ({
  tables: {} as Record<string, Row[]>,
  session: null as Row | null,
  sessionAdmin: false,
  principals: [] as string[],
  activity: [] as Row[]
}))

const ci = (a: unknown, b: unknown) =>
  String(a ?? '')
    .replace(/ +$/, '')
    .toLowerCase() ===
  String(b ?? '')
    .replace(/ +$/, '')
    .toLowerCase()

vi.mock('../../../db/index.js', () => {
  const chain = (table: string) => {
    const name = table.split(' as ')[0]
    const preds: Array<(r: Row) => boolean> = []
    const rows = () => (m.tables[name] ?? []).filter((r) => preds.every((p) => p(r)))
    const col = (c: string) => c.replace(/^\w+\./, '')
    const api: Record<string, unknown> = {
      where: (a: unknown, b?: unknown) => {
        if (typeof a === 'string') preds.push((r) => ci(r[col(a)], b))
        else for (const [k, v] of Object.entries(a as Row)) preds.push((r) => ci(r[col(k)], v))
        return api
      },
      whereIn: (c: string, vals: unknown[]) => {
        preds.push((r) => vals.some((v) => ci(r[col(c)], v)))
        return api
      },
      leftJoin: () => api,
      orderBy: () => api,
      select: () => Promise.resolve(rows()),
      first: () => Promise.resolve(rows()[0]),
      insert: (row: Row) => {
        m.tables[name] = [...(m.tables[name] ?? []), row]
        return Promise.resolve([1])
      },
      update: (patch: Row) => {
        const hit = rows()
        for (const r of hit) Object.assign(r, patch)
        return Object.assign(Promise.resolve(hit.length), { catch: () => undefined })
      },
      delete: () => {
        const hit = new Set(rows())
        m.tables[name] = (m.tables[name] ?? []).filter((r) => !hit.has(r))
        return Promise.resolve(hit.size)
      }
    }
    return api
  }
  return { db: Object.assign((t: string) => chain(t), { raw: vi.fn(() => 'raw') }) }
})
vi.mock('../../../lib/column-probe.js', () => ({ hasColumn: vi.fn(async () => true) }))
vi.mock('../../../middleware/authenticate.js', () => ({
  requireAuth: vi.fn(async (req: { user?: unknown; isAdmin?: boolean }) => {
    if (!m.session) throw Object.assign(new Error('Unauthorized'), { statusCode: 401 })
    req.user = m.session
    req.isAdmin = m.sessionAdmin
  }),
  adminRefusal: (req: { isAdmin?: boolean }) =>
    req.isAdmin ? null : { error: 'Forbidden', code: 'ADMIN_ONLY' }
}))
vi.mock('../../../services/permission-cache.js', () => ({
  notePrincipalKind: (_u: unknown, kind: string) => m.principals.push(kind)
}))
vi.mock('../../../services/activity.js', () => ({
  logActivity: vi.fn(async (o: Row) => {
    m.activity.push(o)
    return 1
  })
}))

const { commandCenterShellRoutes } = await import('../../../routes/command-center-shell.js')
const { ccReadAuth } = await import('../../../services/command-center/auth.js')
const { hashKioskToken } = await import('../../../services/command-center/kiosk.js')

const ADMIN_ROLE = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
const PLAIN_ROLE = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
const CREATOR = 'cccccccc-cccc-cccc-cccc-cccccccccccc'
const LINK_ID = 'dddddddd-dddd-dddd-dddd-dddddddddddd'
const TOKEN = 'ab'.repeat(24)

function seed(opts?: { expires?: Date | null; active?: boolean; status?: string; role?: string }) {
  m.tables = {
    nivaro_roles: [
      { id: ADMIN_ROLE, admin_access: true, app_access: true },
      { id: PLAIN_ROLE, admin_access: false, app_access: true }
    ],
    nivaro_users: [
      {
        id: CREATOR,
        status: opts?.status ?? 'active',
        role: opts?.role ?? ADMIN_ROLE,
        first_name: 'Ada',
        preferences: null
      }
    ],
    nivaro_share_links: [
      {
        id: LINK_ID,
        collection: 'nivaro_command_center',
        item: '__cc_kiosk__',
        token: hashKioskToken(TOKEN),
        is_active: opts?.active === false ? 0 : 1,
        expires_at: opts?.expires === undefined ? new Date(Date.now() + 86_400_000) : opts.expires,
        created_by: CREATOR,
        view_count: 0
      }
    ],
    nivaro_extension_settings: [
      {
        extension_id: 'nivaro-core',
        key: `cc_kiosk:${LINK_ID}`,
        value: JSON.stringify({ label: 'Ops floor', region: '7', map_collection: 'locations' })
      }
    ],
    nivaro_settings: [{ command_center: null }]
  }
}

async function build(): Promise<FastifyInstance> {
  const app = Fastify()
  await app.register(
    async (api) => {
      await api.register(commandCenterShellRoutes, { prefix: '/command-center' })
      // Stand-ins for a slice's GET and write under /command-center, and a route elsewhere.
      await api.register(
        async (f) => {
          f.addHook('preHandler', ccReadAuth)
          f.get('/snapshot', async (req) => ({ user: req.user?.id, admin: req.isAdmin }))
          f.post('/nudge', async () => ({ ok: true }))
        },
        { prefix: '/command-center' }
      )
      await api.register(
        async (f) => {
          f.addHook('preHandler', ccReadAuth)
          f.get('/elsewhere', async () => ({ ok: true }))
        },
        { prefix: '/other' }
      )
    },
    { prefix: '/api' }
  )
  await app.ready()
  return app
}

beforeEach(() => {
  seed()
  m.session = null
  m.sessionAdmin = false
  m.principals = []
  m.activity = []
})

describe('wallboard links read as their creator, for Command Center GETs only', () => {
  it('opens a Command Center GET as the creator, with no session', async () => {
    const app = await build()
    const r = await app.inject({
      method: 'GET',
      url: `/api/command-center/snapshot?kiosk=${TOKEN}`
    })
    expect(r.statusCode).toBe(200)
    expect(r.json()).toEqual({ user: CREATOR, admin: true })
    expect(m.principals).toEqual([`kiosk:${LINK_ID}`])
  })

  it('tells the board what the link opens on', async () => {
    const app = await build()
    const r = await app.inject({ method: 'GET', url: `/api/command-center/kiosk?kiosk=${TOKEN}` })
    expect(r.statusCode).toBe(200)
    expect(r.json().data).toMatchObject({
      label: 'Ops floor',
      region: '7',
      map_collection: 'locations'
    })
  })

  it('refuses every write, even with a valid link and a session', async () => {
    m.session = { id: 'someone' }
    m.sessionAdmin = true
    const app = await build()
    for (const [method, url] of [
      ['POST', '/api/command-center/nudge'],
      ['PUT', '/api/command-center/prefs'],
      ['POST', '/api/command-center/kiosk-links'],
      ['DELETE', `/api/command-center/kiosk-links/${LINK_ID}`],
      ['PUT', '/api/command-center/role-defaults']
    ] as const) {
      const r = await app.inject({ method, url: `${url}?kiosk=${TOKEN}`, payload: {} })
      expect(r.statusCode, `${method} ${url}`).toBe(403)
    }
    expect(m.tables.nivaro_share_links).toHaveLength(1)
  })

  it('refuses routes outside /command-center', async () => {
    const app = await build()
    const r = await app.inject({ method: 'GET', url: `/api/other/elsewhere?kiosk=${TOKEN}` })
    expect(r.statusCode).toBe(403)
  })

  it('refuses the Command Center routes that opt out (own prefs, link admin)', async () => {
    const app = await build()
    for (const url of ['/prefs', '/kiosk-links', '/role-defaults']) {
      const r = await app.inject({ method: 'GET', url: `/api/command-center${url}?kiosk=${TOKEN}` })
      expect(r.statusCode, url).toBe(403)
    }
  })

  it('refuses expired, revoked, unknown and malformed links without falling back to a session', async () => {
    m.session = { id: 'someone' }
    const cases: Array<[string, () => void]> = [
      ['expired', () => seed({ expires: new Date(Date.now() - 1000) })],
      ['no expiry', () => seed({ expires: null })],
      ['revoked', () => seed({ active: false })],
      [
        'deleted',
        () => {
          seed()
          m.tables.nivaro_share_links = []
        }
      ]
    ]
    for (const [why, arrange] of cases) {
      arrange()
      const app = await build()
      const r = await app.inject({
        method: 'GET',
        url: `/api/command-center/snapshot?kiosk=${TOKEN}`
      })
      expect(r.statusCode, why).toBe(401)
    }
    seed()
    const app = await build()
    for (const bad of ['', 'xyz', `${TOKEN}0`, TOKEN.toUpperCase()]) {
      const r = await app.inject({
        method: 'GET',
        url: `/api/command-center/snapshot?kiosk=${bad}`
      })
      expect(r.statusCode, bad).toBe(401)
    }
    const twice = await app.inject({
      method: 'GET',
      url: `/api/command-center/snapshot?kiosk=${TOKEN}&kiosk=${TOKEN}`
    })
    expect(twice.statusCode).toBe(401)
  })

  it('stops when the creator is suspended, redacted, demoted or barred from signing in', async () => {
    const cases: Array<[string, () => void]> = [
      ['suspended', () => seed({ status: 'suspended' })],
      ['demoted', () => seed({ role: PLAIN_ROLE })],
      [
        'redacted',
        () => {
          seed()
          ;(m.tables.nivaro_users[0] as Row).is_redacted = true
        }
      ],
      [
        'sign-in off',
        () => {
          seed()
          ;(m.tables.nivaro_roles[0] as Row).app_access = false
        }
      ],
      [
        'removed',
        () => {
          seed()
          m.tables.nivaro_users = []
        }
      ]
    ]
    for (const [why, arrange] of cases) {
      arrange()
      const app = await build()
      const r = await app.inject({
        method: 'GET',
        url: `/api/command-center/snapshot?kiosk=${TOKEN}`
      })
      expect(r.statusCode, why).toBe(401)
    }
  })

  it('a token is stored hashed: the raw token never matches the column', async () => {
    m.tables.nivaro_share_links[0].token = TOKEN.slice(0, 48)
    const app = await build()
    const r = await app.inject({
      method: 'GET',
      url: `/api/command-center/snapshot?kiosk=${TOKEN}`
    })
    expect(r.statusCode).toBe(401)
  })
})

describe('managing wallboard links', () => {
  it('is for administrators only', async () => {
    m.session = { id: 'paul', role: PLAIN_ROLE }
    const app = await build()
    const list = await app.inject({ method: 'GET', url: '/api/command-center/kiosk-links' })
    expect(list.statusCode).toBe(403)
    const made = await app.inject({
      method: 'POST',
      url: '/api/command-center/kiosk-links',
      payload: { label: 'Wall', expires_in_days: 7 }
    })
    expect(made.statusCode).toBe(403)
  })

  it('requires an expiry of 1–90 days and shows the URL once', async () => {
    m.session = { id: CREATOR, role: ADMIN_ROLE }
    m.sessionAdmin = true
    const app = await build()
    for (const days of [undefined, 0, 91, 2.5, 'x']) {
      const r = await app.inject({
        method: 'POST',
        url: '/api/command-center/kiosk-links',
        payload: { label: 'Wall', expires_in_days: days }
      })
      expect(r.statusCode, String(days)).toBe(400)
    }
    const r = await app.inject({
      method: 'POST',
      url: '/api/command-center/kiosk-links',
      payload: { label: 'Dispatch wall', expires_in_days: 30, region: '7' }
    })
    expect(r.statusCode).toBe(201)
    const url = r.json().data.url as string
    const token = url.split('/').pop() as string
    expect(url).toMatch(/^\/command\/kiosk\/[0-9a-f]{48}$/)
    const stored = m.tables.nivaro_share_links.at(-1) as Row
    expect(stored.token).toBe(hashKioskToken(token))
    expect(stored.item).toBe('__cc_kiosk__')
    expect(stored.expires_at).toBeInstanceOf(Date)
    // The list never repeats the token.
    const list = await app.inject({ method: 'GET', url: '/api/command-center/kiosk-links' })
    expect(list.body).not.toContain(token)
    // And the new link works until it is revoked.
    m.session = null
    const ok = await app.inject({
      method: 'GET',
      url: `/api/command-center/snapshot?kiosk=${token}`
    })
    expect(ok.statusCode).toBe(200)
    m.session = { id: CREATOR, role: ADMIN_ROLE }
    const del = await app.inject({
      method: 'DELETE',
      url: `/api/command-center/kiosk-links/${stored.id}`
    })
    expect(del.statusCode).toBe(204)
    m.session = null
    const gone = await app.inject({
      method: 'GET',
      url: `/api/command-center/snapshot?kiosk=${token}`
    })
    expect(gone.statusCode).toBe(401)
  })
})

describe('own prefs', () => {
  it('reads and writes the caller’s own board prefs, keeping unknown panel keys', async () => {
    m.session = { id: CREATOR, role: ADMIN_ROLE }
    const app = await build()
    const put = await app.inject({
      method: 'PUT',
      url: '/api/command-center/prefs',
      payload: {
        layout: { order: ['attention', 'map', 'sla_heatmap'], hidden: ['feed', 'bad key!'] },
        theme: 'dark'
      }
    })
    expect(put.statusCode).toBe(200)
    expect(put.json().data.layout).toEqual({
      order: ['attention', 'map', 'sla_heatmap'],
      hidden: ['feed']
    })
    const get = await app.inject({ method: 'GET', url: '/api/command-center/prefs' })
    expect(get.json().data).toMatchObject({ theme: 'dark', saved_views: [], role_default: null })
    const bad = await app.inject({
      method: 'PUT',
      url: '/api/command-center/prefs',
      payload: { theme: 'neon' }
    })
    expect(bad.statusCode).toBe(400)
  })

  it('role starting layouts are admin-only and come back as role_default', async () => {
    m.session = { id: CREATOR, role: ADMIN_ROLE }
    const app = await build()
    const refused = await app.inject({
      method: 'PUT',
      url: '/api/command-center/role-defaults',
      payload: { role_id: ADMIN_ROLE, layout: { order: ['map'], hidden: [] } }
    })
    expect(refused.statusCode).toBe(403)
    m.sessionAdmin = true
    const saved = await app.inject({
      method: 'PUT',
      url: '/api/command-center/role-defaults',
      payload: { role_id: ADMIN_ROLE.toUpperCase(), layout: { order: ['map'], hidden: [] } }
    })
    expect(saved.statusCode).toBe(200)
    const get = await app.inject({ method: 'GET', url: '/api/command-center/prefs' })
    expect(get.json().data.role_default).toEqual({ order: ['map'], hidden: [] })
  })
})
