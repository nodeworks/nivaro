import type { FastifyRequest } from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runWithTenantDb } from '../db/tenant-context.js'
import { accessPendingRefusals } from './access-pending.js'
import {
  type AccessDeniedEvent,
  apiKeyWidening,
  buildSecurityNotice,
  coalesceGroup,
  countAccessDenied,
  deniedCaller,
  describeKeyScopes,
  eventEnabled,
  flushSecurityGroup,
  type KeyShape,
  memoryCoalesceStore,
  memoryCounterStore,
  mergeSecurityAlertPatch,
  normalizeSecurityAlertSettings,
  noteAccessDenied,
  raiseSecurityEvent,
  redisCoalesceStore,
  redisCounterStore,
  roleEditSentences,
  SECURITY_ALERT_DEFAULTS,
  type SecurityAlertDeps,
  type SecurityAlertSettings,
  SecurityAlertSettingsError,
  type SecurityEvent,
  type SecurityNotice,
  setSecurityAlertDeps,
  type UserRoleEvent
} from './security-alerts.js'

const ACTOR = '11111111-1111-1111-1111-111111111111'
const ANN = '22222222-2222-2222-2222-222222222222'
const BOB = '33333333-3333-3333-3333-333333333333'
const CAL = '44444444-4444-4444-4444-444444444444'
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i

const names = new Map([
  [ACTOR, 'Alex Kim · alex@x.test'],
  [ANN, 'Ann Lee · ann@x.test'],
  [BOB, 'Bob Ray · bob@x.test'],
  [CAL, 'Cal Ode · cal@x.test']
])

function roleEv(userId: string, over: Partial<UserRoleEvent> = {}): UserRoleEvent {
  return {
    kind: 'user_role',
    actor: ACTOR,
    source: 'person',
    userId,
    fromRole: 'r-editor',
    toRole: 'r-viewer',
    fromName: 'Editor',
    toName: 'Viewer',
    fromAdmin: false,
    toAdmin: false,
    ...over
  }
}

/** Plain-words rule: no ids, status codes or SQL in what a person reads. */
function expectPlainWords(n: SecurityNotice) {
  for (const text of [n.subject, n.message]) {
    expect(text).not.toMatch(UUID_RE)
    expect(text).not.toMatch(/\b403\b|\bSELECT\b|\bnivaro_/i)
  }
}

describe('buildSecurityNotice — who did what to whom', () => {
  it('names the administrator rights an account gained', () => {
    const n = buildSecurityNotice(
      [roleEv(ANN, { toRole: 'r-admin', toName: 'Administrator', toAdmin: true })],
      { names }
    )!
    expect(n.subject).toBe('Security: Ann Lee · ann@x.test was given administrator rights')
    expect(n.message).toBe(
      "Alex Kim · alex@x.test changed Ann Lee · ann@x.test's role from Editor to Administrator."
    )
    expect(n.path).toBe(`/users/${ANN}`)
    expect(n.exclude).toEqual([ACTOR.toUpperCase()])
    expectPlainWords(n)
  })

  it('says rights were lost, and a plain role change plainly', () => {
    const lost = buildSecurityNotice(
      [roleEv(ANN, { fromName: 'Administrator', fromAdmin: true })],
      { names }
    )!
    expect(lost.subject).toContain('no longer has administrator rights')
    const plain = buildSecurityNotice([roleEv(ANN)], { names })!
    expect(plain.subject).toBe("Security: Ann Lee · ann@x.test's role was changed")
  })

  it('folds a bulk change into one notice that counts admin moves', () => {
    const n = buildSecurityNotice(
      [roleEv(ANN), roleEv(BOB, { toName: 'Administrator', toAdmin: true }), roleEv(CAL)],
      { names }
    )!
    expect(n.subject).toBe(
      'Security: Alex Kim · alex@x.test changed the roles of 3 people — 1 gained administrator rights'
    )
    expect(n.message).toContain(
      'Bob Ray · bob@x.test: Editor → Administrator (now an administrator).'
    )
    expect(n.path).toBe('/users')
    expectPlainWords(n)
  })

  it('names the directory when no person made the change', () => {
    const n = buildSecurityNotice([roleEv(ANN, { actor: null, source: 'directory' })], { names })!
    expect(n.message).toBe(
      "Directory group mapping changed Ann Lee · ann@x.test's role from Editor to Viewer at sign-in."
    )
    expect(n.exclude).toEqual([])
  })

  it('describes role permission changes and an admin grant with its member count', () => {
    const n = buildSecurityNotice(
      [
        {
          kind: 'role_permissions',
          actor: ACTOR,
          roleId: 'r-ed',
          roleName: 'Editor',
          change: 'Given administrator rights.',
          adminChange: 'granted',
          members: 14
        },
        {
          kind: 'role_permissions',
          actor: ACTOR,
          roleId: 'r-ed',
          roleName: 'Editor',
          change: 'Can now delete Purchase orders.'
        }
      ],
      { names }
    )!
    expect(n.subject).toBe('Security: the Editor role was given administrator rights')
    expect(n.message).toContain('Can now delete Purchase orders.')
    expect(n.message).toContain('Its 14 members are now administrators.')
    expect(n.path).toBe('/roles?role=r-ed')
    expectPlainWords(n)
  })

  it('says what a new API key may do and links to it', () => {
    const n = buildSecurityNotice(
      [
        {
          kind: 'api_key',
          actor: ACTOR,
          keyId: '7',
          keyName: 'Fusion sync',
          ownerId: ANN,
          change: 'created',
          reasons: ['full access to every collection', 'It never expires.']
        }
      ],
      { names }
    )!
    expect(n.subject).toBe('Security: Alex Kim · alex@x.test created the API key "Fusion sync"')
    expect(n.message).toBe(
      'The key acts as Ann Lee · ann@x.test with full access to every collection. It never expires.'
    )
    expect(n.path).toBe('/api-keys?key=7')
    expectPlainWords(n)
  })

  it('reports an access-denied burst by person, key name or address', () => {
    const person: AccessDeniedEvent = {
      kind: 'access_denied',
      caller: { type: 'user', id: ANN },
      count: 25,
      minutes: 5
    }
    const n = buildSecurityNotice([person], { names })!
    expect(n.subject).toBe(
      'Security: Ann Lee · ann@x.test was refused access 25 times in 5 minutes'
    )
    expect(n.path).toBe(`/users/${ANN}?tab=activity`)
    expectPlainWords(n)
    const key = buildSecurityNotice([{ ...person, caller: { type: 'api_key', id: '9' } }], {
      names,
      keyNames: new Map([['9', 'Nightly export']])
    })!
    expect(key.subject).toContain('the API key "Nightly export"')
    const many = buildSecurityNotice(
      [person, { ...person, caller: { type: 'address', id: '203.0.113.9' } }],
      { names }
    )!
    expect(many.subject).toBe('Security: 2 callers were refused access over and over')
    expect(many.message).toContain('The network address 203.0.113.9: 25 refusals in 5 minutes.')
  })

  it('tells the other administrators about a new-location admin sign-in, not the person', () => {
    const n = buildSecurityNotice(
      [{ kind: 'admin_signin', userId: ANN, device: 'Chrome on macOS' }],
      { names }
    )!
    expect(n.subject).toBe(
      'Security: administrator Ann Lee · ann@x.test signed in from a new location'
    )
    expect(n.message).toContain('using Chrome on macOS')
    expect(n.exclude).toEqual([ANN.toUpperCase()])
  })
})

describe('apiKeyWidening', () => {
  const base: KeyShape = {
    scopes: [{ collection: 'projects', actions: ['read'] }],
    scope_restrictions: [{ dimension: 'zone', values: [1] }],
    ip_allowlist: ['10.0.0.1'],
    sandbox: true,
    is_active: true,
    expires_at: '2027-01-01T00:00:00Z'
  }

  it('says nothing for the same key, a narrower key or a rename', () => {
    expect(apiKeyWidening(base, { ...base })).toEqual([])
    expect(apiKeyWidening(base, { ...base, scopes: [] })).toEqual([])
    expect(apiKeyWidening(base, { ...base, ip_allowlist: ['10.0.0.1'] })).toEqual([])
  })

  it('names every way the key reaches further', () => {
    const r = apiKeyWidening(base, {
      scopes: [{ collection: '*', actions: ['*'] }],
      scope_restrictions: null,
      ip_allowlist: [],
      sandbox: false,
      is_active: true,
      expires_at: null
    })
    expect(r).toEqual([
      'It can now do anything with every collection.',
      'It is no longer limited to a slice of the records.',
      'It can now be used from any network address.',
      'Its writes are now saved (it was rehearsal-only).',
      'It no longer expires.'
    ])
  })

  it('sees loosened limits, more addresses, a later expiry and a re-enabled key', () => {
    const r = apiKeyWidening(
      { ...base, is_active: false },
      {
        ...base,
        scope_restrictions: [{ dimension: 'zone', values: [1, 2] }],
        ip_allowlist: ['10.0.0.1', '10.0.0.2'],
        expires_at: '2028-01-01T00:00:00Z'
      }
    )
    expect(r).toEqual([
      'Its record limits were loosened.',
      'It accepts more network addresses.',
      'It was switched back on.',
      'It now expires later.'
    ])
  })

  it('describes scopes in words', () => {
    expect(describeKeyScopes([{ collection: '*', actions: ['*'] }])).toBe(
      'full access to every collection'
    )
    expect(
      describeKeyScopes([{ collection: 'purchase_orders', actions: ['read', 'update'] }])
    ).toBe('read and change Purchase orders')
  })
})

describe('roleEditSentences', () => {
  it('reports admin rights, app access and a rename; stays quiet for a description', () => {
    const r = roleEditSentences(
      { name: 'Ops', admin_access: 0, app_access: true, description: 'a' },
      { name: 'Operations', admin_access: true, app_access: false, description: 'b' }
    )
    expect(r.adminChange).toBe('granted')
    expect(r.changes).toEqual([
      'Given administrator rights.',
      'Can no longer sign in to the app.',
      'Renamed from Ops to Operations.'
    ])
    expect(roleEditSentences({ description: 'a' }, { description: 'b' }).changes).toEqual([])
  })
})

describe('settings', () => {
  it('defaults every switch on and keeps bad stored values at the default', () => {
    expect(normalizeSecurityAlertSettings(null)).toEqual(SECURITY_ALERT_DEFAULTS)
    const s = normalizeSecurityAlertSettings({
      api_keys: false,
      access_denied_threshold: 2,
      access_denied_minutes: 10
    })
    expect(s.api_keys).toBe(false)
    expect(s.access_denied_threshold).toBe(25)
    expect(s.access_denied_minutes).toBe(10)
  })

  it('refuses a bad patch by field', () => {
    expect(() =>
      mergeSecurityAlertPatch(SECURITY_ALERT_DEFAULTS, { api_keys: 'no', nope: 1 })
    ).toThrow(SecurityAlertSettingsError)
    expect(
      mergeSecurityAlertPatch(SECURITY_ALERT_DEFAULTS, { admin_signin: false }).admin_signin
    ).toBe(false)
  })

  it('lets admin-rights moves through when only admin_rights is on', () => {
    const s: SecurityAlertSettings = { ...SECURITY_ALERT_DEFAULTS, role_changes: false }
    expect(eventEnabled(roleEv(ANN), s)).toBe(false)
    expect(eventEnabled(roleEv(ANN, { toAdmin: true }), s)).toBe(true)
    // A new account is news only when it starts as an administrator.
    expect(eventEnabled(roleEv(ANN, { created: true }), SECURITY_ALERT_DEFAULTS)).toBe(false)
    expect(eventEnabled(roleEv(ANN, { created: true, toAdmin: true }), s)).toBe(true)
    expect(eventEnabled(roleEv(ANN, { toAdmin: true }), { ...s, admin_rights: false })).toBe(false)
  })
})

// ─── Coalescing + delivery (memory stores; a fake Redis below) ──────────────

interface Harness {
  deps: SecurityAlertDeps
  scheduled: Array<() => void>
  sent: Array<{ to: string; notice: SecurityNotice; url: string }>
  logged: Array<{ notice: SecurityNotice; delivered: number }>
}

function harness(over: Partial<SecurityAlertDeps> = {}, settings = SECURITY_ALERT_DEFAULTS) {
  const h: Harness = { scheduled: [], sent: [], logged: [], deps: null as never }
  // A fresh shared list per test (the memory store is one per process, like production).
  const coalesce = redisCoalesceStore(fakeRedis())
  h.deps = {
    settings: async () => settings,
    coalesce: () => coalesce,
    counters: () => memoryCounterStore,
    schedule: (fn) => void h.scheduled.push(fn),
    admins: async () => [ACTOR, BOB],
    names: async () => names,
    keyNames: async () => new Map(),
    notify: async (to, notice, url) => void h.sent.push({ to, notice, url }),
    log: async (notice, delivered) => void h.logged.push({ notice, delivered }),
    linkBase: () => 'https://nivaro.example/',
    ...over
  }
  setSecurityAlertDeps(h.deps)
  return h
}

describe('raiseSecurityEvent → one notice per burst', () => {
  afterEach(() => setSecurityAlertDeps(null))

  it('coalesces a bulk role change into ONE notice, not sent to the actor', async () => {
    const h = harness()
    await raiseSecurityEvent(roleEv(ANN))
    await raiseSecurityEvent(roleEv(CAL))
    await raiseSecurityEvent(roleEv(BOB, { toAdmin: true, toName: 'Administrator' }))
    expect(h.scheduled).toHaveLength(1)
    const notice = await flushSecurityGroup(coalesceGroup(roleEv(ANN)))
    expect(notice?.subject).toContain('changed the roles of 3 people')
    expect(h.sent.map((s) => s.to)).toEqual([BOB])
    expect(h.sent[0].url).toBe('https://nivaro.example/users')
    expect(h.logged).toHaveLength(1)
    expect(h.logged[0].delivered).toBe(1)
    // The batch is gone: the next change starts (and owns) a new one.
    await raiseSecurityEvent(roleEv(ANN))
    expect(h.scheduled).toHaveLength(2)
  })

  it('keeps different actors and families apart', async () => {
    const h = harness()
    await raiseSecurityEvent(roleEv(ANN))
    await raiseSecurityEvent(roleEv(ANN, { actor: BOB }))
    await raiseSecurityEvent({ kind: 'admin_signin', userId: ANN, device: null })
    expect(h.scheduled).toHaveLength(3)
  })

  it('sends nothing for a switched-off family', async () => {
    const h = harness({}, { ...SECURITY_ALERT_DEFAULTS, role_changes: false })
    await raiseSecurityEvent(roleEv(ANN))
    expect(h.scheduled).toHaveLength(0)
  })

  // Security review 2026-11-16: a capped hour must never swallow a role/admin change.
  it('delivers role changes even past the hourly cap', async () => {
    const h = harness({
      counters: () =>
        ({ hit: async () => 9999 }) as unknown as ReturnType<SecurityAlertDeps['counters']>
    })
    await raiseSecurityEvent(roleEv(ANN))
    await flushSecurityGroup(coalesceGroup(roleEv(ANN)))
    expect(h.sent.map((s) => s.to)).toEqual([BOB])
  })

  it('still tells the only administrator about their own change', async () => {
    const h = harness({ admins: async () => [ACTOR] })
    await raiseSecurityEvent(roleEv(ANN))
    await flushSecurityGroup(coalesceGroup(roleEv(ANN)))
    expect(h.sent.map((s) => s.to)).toEqual([ACTOR])
  })
})

describe('access-denied bursts', () => {
  beforeEach(() => vi.useFakeTimers({ now: new Date('2026-11-16T12:00:00Z') }))
  afterEach(() => {
    vi.useRealTimers()
    setSecurityAlertDeps(null)
  })

  it('counts against the key, then the person, then the address', () => {
    expect(deniedCaller({ apiKeyId: 4, user: { id: ANN }, ip: '1.2.3.4' })).toEqual({
      type: 'api_key',
      id: '4'
    })
    expect(deniedCaller({ user: { id: ANN }, ip: '1.2.3.4' })).toEqual({ type: 'user', id: ANN })
    expect(deniedCaller({ ip: '1.2.3.4' })).toEqual({ type: 'address', id: '1.2.3.4' })
    expect(deniedCaller({})).toBeNull()
  })

  it('raises once at the threshold, then not again inside the cooldown', async () => {
    const h = harness()
    const caller = { type: 'user' as const, id: `${ANN}-burst` }
    const fired: boolean[] = []
    for (let i = 0; i < 60; i++) fired.push(await countAccessDenied(caller))
    expect(fired.filter(Boolean)).toHaveLength(1)
    expect(fired.indexOf(true)).toBe(24) // the 25th refusal
    expect(h.scheduled).toHaveLength(1)

    // A new window past the old one: the count restarts, but the cooldown holds the alert.
    vi.setSystemTime(new Date('2026-11-16T12:06:00Z'))
    for (let i = 0; i < 30; i++) fired.push(await countAccessDenied(caller))
    expect(fired.filter(Boolean)).toHaveLength(1)

    // After the cooldown a fresh burst alerts again.
    vi.setSystemTime(new Date('2026-11-16T13:10:00Z'))
    let again = false
    for (let i = 0; i < 25; i++) again = (await countAccessDenied(caller)) || again
    expect(again).toBe(true)
  })

  it('never counts a person still waiting for access (their tab polls by design)', async () => {
    const h = harness()
    const pending = { ip: '10.166.243.233', headers: {} } as unknown as FastifyRequest
    accessPendingRefusals.add(pending)
    for (let i = 0; i < 40; i++) noteAccessDenied(pending)
    await vi.advanceTimersByTimeAsync(10)
    expect(h.scheduled).toHaveLength(0)
    // The same address without the pending mark still alerts at the threshold.
    const other = { ip: '10.166.243.234', headers: {} } as unknown as FastifyRequest
    for (let i = 0; i < 25; i++) noteAccessDenied(other)
    await vi.advanceTimersByTimeAsync(10)
    expect(h.scheduled).toHaveLength(1)
  })

  it('is quiet below the threshold and when switched off', async () => {
    harness({}, { ...SECURITY_ALERT_DEFAULTS, access_denied_threshold: 10 })
    const caller = { type: 'address' as const, id: '198.51.100.7' }
    for (let i = 0; i < 9; i++) expect(await countAccessDenied(caller)).toBe(false)
    harness({}, { ...SECURITY_ALERT_DEFAULTS, access_denied: false })
    const off = { type: 'address' as const, id: '198.51.100.8' }
    for (let i = 0; i < 40; i++) expect(await countAccessDenied(off)).toBe(false)
  })
})

// ─── Redis stores: shared by replicas, keyed by tenant ──────────────────────

/** Just enough of ioredis for the two stores: strings with expiry, lists, MULTI. */
function fakeRedis() {
  const strings = new Map<string, { v: string; until: number | null }>()
  const lists = new Map<string, string[]>()
  const live = (k: string) => {
    const e = strings.get(k)
    if (e && e.until != null && e.until <= Date.now()) strings.delete(k)
    return strings.get(k)
  }
  const ops = {
    set(k: string, v: string, _ex: 'EX', sec: number, nx?: 'NX') {
      if (nx && live(k)) return null
      strings.set(k, { v, until: Date.now() + sec * 1000 })
      return 'OK'
    },
    incr(k: string) {
      const e = live(k) ?? { v: '0', until: null }
      e.v = String(Number(e.v) + 1)
      strings.set(k, e)
      return Number(e.v)
    },
    rpush(k: string, v: string) {
      const l = lists.get(k) ?? []
      l.push(v)
      lists.set(k, l)
      return l.length
    },
    expire() {
      return 1
    },
    lrange(k: string) {
      return [...(lists.get(k) ?? [])]
    },
    del(k: string) {
      return Number(strings.delete(k)) + Number(lists.delete(k))
    }
  }
  const client = {
    keys: () => [...strings.keys(), ...lists.keys()],
    set: async (...a: Parameters<typeof ops.set>) => ops.set(...a),
    multi() {
      const queued: Array<() => unknown> = []
      const m: Record<string, unknown> = {}
      for (const name of Object.keys(ops) as Array<keyof typeof ops>) {
        m[name] = (...args: unknown[]) => {
          queued.push(() => (ops[name] as (...x: unknown[]) => unknown)(...args))
          return m
        }
      }
      m.exec = async () => queued.map((f) => [null, f()])
      return m as {
        exec(): Promise<Array<[null, unknown]>>
      } & Record<string, (...a: unknown[]) => unknown>
    }
  }
  return client
}

function inTenant<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    runWithTenantDb(
      {} as never,
      `slug-${tenantId}`,
      () => void fn().then(resolve, reject),
      tenantId
    )
  })
}

describe('redis stores', () => {
  it('lets exactly one replica own a batch and drains it whole', async () => {
    const r = fakeRedis()
    const replicaA = redisCoalesceStore(r)
    const replicaB = redisCoalesceStore(r)
    expect((await replicaA.push('g', 'one', 120)).owner).toBe(true)
    expect((await replicaB.push('g', 'two', 120)).owner).toBe(false)
    expect(await replicaA.drain('g')).toEqual(['one', 'two'])
    // Drained = the lock is gone too; the next push owns the next flush.
    expect((await replicaB.push('g', 'three', 120)).owner).toBe(true)
  })

  it('shares one counter across replicas and expires it with the window', async () => {
    vi.useFakeTimers({ now: new Date('2026-11-16T12:00:00Z') })
    try {
      const r = fakeRedis()
      const a = redisCounterStore(r)
      const b = redisCounterStore(r)
      expect(await a.hit('denied:x', 300)).toBe(1)
      expect(await b.hit('denied:x', 300)).toBe(2)
      expect(await a.hit('denied:x', 300)).toBe(3)
      vi.setSystemTime(new Date('2026-11-16T12:05:01Z'))
      expect(await b.hit('denied:x', 300)).toBe(1)
      expect(await a.claim('c', 60)).toBe(true)
      expect(await b.claim('c', 60)).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps tenants apart: every key names the tenant', async () => {
    const r = fakeRedis()
    const store = redisCounterStore(r)
    expect(await inTenant('t-one', () => store.hit('denied:user:A', 300))).toBe(1)
    expect(await inTenant('t-two', () => store.hit('denied:user:A', 300))).toBe(1)
    expect(await inTenant('t-one', () => store.hit('denied:user:A', 300))).toBe(2)
    const keys = r.keys()
    expect(keys.some((k) => k.includes(':t-one:'))).toBe(true)
    expect(keys.some((k) => k.includes(':t-two:'))).toBe(true)
  })
})

describe('memory stores (single process, no Redis)', () => {
  it('first push owns the flush; drain empties the list', async () => {
    expect((await memoryCoalesceStore.push('mem-g', 'a', 60)).owner).toBe(true)
    expect((await memoryCoalesceStore.push('mem-g', 'b', 60)).owner).toBe(false)
    expect(await memoryCoalesceStore.drain('mem-g')).toEqual(['a', 'b'])
    expect((await memoryCoalesceStore.push('mem-g', 'c', 60)).owner).toBe(true)
    await memoryCoalesceStore.drain('mem-g')
  })
})

describe('coalesce groups', () => {
  it('groups config changes per actor and bursts per family', () => {
    const ev = (e: Partial<SecurityEvent>) => ({ ...roleEv(ANN), ...e }) as SecurityEvent
    expect(coalesceGroup(ev({}))).toBe(`user_role:${ACTOR.toUpperCase()}`)
    expect(coalesceGroup(ev({ actor: null, source: 'scim' } as Partial<UserRoleEvent>))).toBe(
      'user_role:scim'
    )
    expect(
      coalesceGroup({
        kind: 'access_denied',
        caller: { type: 'user', id: ANN },
        count: 1,
        minutes: 5
      })
    ).toBe('access_denied')
  })
})
