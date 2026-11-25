import { describe, expect, it, vi } from 'vitest'

// Hub fleet: the pure parts — drift rules, uptime arithmetic, settings validation, the probe's
// up/down verdict, audit labels/categories/comments and the CSV.

vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))

const { evaluateDrift, isUnverified, knownReleases, newestVersion, releasesApart, releasesBehind } =
  await import('../../../services/hub/fleet/rules.js')
const { monthBounds, monthOf, previousMonth, sloFigures, toBp, uptimePercent } = await import(
  '../../../services/hub/fleet/uptime.js'
)
const { defaultFleetSettings, normalizeFleetSettings, targetFor } = await import(
  '../../../services/hub/fleet/settings.js'
)
const { eachBounded, probeEnvironment, probeFetch, versionOf, PROBE_BODY_MAX } = await import(
  '../../../services/hub/fleet/probe.js'
)
const { rotate } = await import('../../../services/hub/fleet/tick.js')
const { p95 } = await import('../../../services/hub/fleet/store.js')
const { auditCsv, categoryOf, labelOf, readComment } = await import(
  '../../../services/hub/fleet/audit.js'
)

const rule = (over: Record<string, unknown>) => ({
  id: 'r',
  kind: 'behind_newest' as const,
  enabled: true,
  n: 3,
  env_keys: [] as string[],
  from_key: null,
  to_key: null,
  ...over
})

const env = (id: number, key: string, version: string | null, over = {}) => ({
  app_id: 1,
  app_key: 'efp',
  environment_id: id,
  env_key: key,
  version,
  deployed_at: '2026-11-20T00:00:00.000Z',
  ...over
})

// What the Hub knows: a few 0.3.x releases and one 0.4.0.
const KNOWN = knownReleases([
  '0.3.210',
  '0.3.211',
  '0.3.212',
  '0.3.213',
  '0.3.214',
  '0.4.0',
  'junk'
])

describe('versions (counted in known releases)', () => {
  it('newest is the highest KNOWN release; distances count known releases, across lines too', () => {
    expect(newestVersion(KNOWN)).toBe('0.4.0')
    expect(newestVersion([])).toBeNull()
    expect(releasesBehind('0.4.0', KNOWN)).toBe(0)
    expect(releasesBehind('0.3.214', KNOWN)).toBe(1) // only 0.4.0 is newer
    expect(releasesBehind('0.3.210', KNOWN)).toBe(5)
    expect(releasesBehind('0.2.99', KNOWN)).toBe(6) // a different line: still a count
    expect(releasesBehind('junk', KNOWN)).toBeNull()
    expect(releasesBehind('0.3.1', [])).toBeNull()
    expect(releasesApart('0.3.214', '0.3.210', KNOWN)).toBe(4)
    expect(releasesApart('0.3.210', '0.4.0', KNOWN)).toBe(5)
  })
  it('a self-reported version above every known release is unverified and never counted', () => {
    expect(isUnverified('99.0.0', KNOWN)).toBe(true)
    expect(isUnverified('0.4.0', KNOWN)).toBe(false)
    expect(releasesBehind('99.0.0', KNOWN)).toBeNull()
    expect(releasesApart('99.0.0', '0.3.210', KNOWN)).toBeNull()
  })
  it('a version string is stored only when it looks like one', () => {
    expect(versionOf(' 0.3.214 ')).toBe('0.3.214')
    expect(versionOf('0.3.214-rc.1+build.5')).toBe('0.3.214-rc.1+build.5')
    expect(versionOf('x'.repeat(65))).toBeNull()
    expect(versionOf('<script>')).toBeNull()
    expect(versionOf(7)).toBeNull()
  })
})

describe('evaluateDrift', () => {
  const now = new Date('2026-11-24T00:00:00.000Z')
  it('behind_newest fires at n and above, never for an unknown or unverified version', () => {
    const out = evaluateDrift(
      [rule({ n: 3 })],
      [
        env(1, 'production', '0.3.211'),
        env(2, 'staging', '0.3.213'),
        env(3, 'dev', null),
        env(4, 'preview', '1.0.0-beta')
      ],
      KNOWN,
      now
    )
    expect(out.map((f) => f.environment_id)).toEqual([1])
    expect(out[0].subject_key).toBe('env:1')
    expect(out[0].message).toContain('4 releases behind the newest (0.4.0)')
  })
  it('a Hub upgraded to a new line alone never fires: newest comes from known releases only', () => {
    const known = knownReleases(['0.3.213', '0.3.214'])
    const envs = [env(1, 'production', '0.3.214'), env(2, 'staging', '0.3.214')]
    expect(evaluateDrift([rule({ n: 1 })], envs, known, now)).toHaveLength(0)
  })
  it('env_keys scope the rule; disabled rules never fire', () => {
    const envs = [env(1, 'production', '0.2.90'), env(2, 'staging', '0.2.90')]
    expect(evaluateDrift([rule({ env_keys: ['production'] })], envs, KNOWN, now)).toHaveLength(1)
    expect(evaluateDrift([rule({ enabled: false })], envs, KNOWN, now)).toHaveLength(0)
  })
  it('pair_apart compares two environments of one app; the alert is on the second environment', () => {
    const r = rule({ kind: 'pair_apart', id: 'p', from_key: 'staging', to_key: 'production', n: 3 })
    const envs = [
      env(1, 'staging', '0.3.214'),
      env(2, 'production', '0.3.210'),
      env(3, 'staging', '0.3.214', { app_id: 2, app_key: 'pole' }),
      env(4, 'production', '0.3.212', { app_id: 2, app_key: 'pole' })
    ]
    const out = evaluateDrift([r], envs, KNOWN, now)
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ subject_key: 'env:2', environment_id: 2 })
  })
  it('stale_deploy counts whole days since the last deploy', () => {
    const r = rule({ kind: 'stale_deploy', id: 's', n: 30 })
    const envs = [
      env(1, 'production', '0.3.1', { deployed_at: '2026-10-20T00:00:00.000Z' }),
      env(2, 'staging', '0.3.1', { deployed_at: '2026-11-01T00:00:00.000Z' }),
      env(3, 'dev', '0.3.1', { deployed_at: null })
    ]
    const out = evaluateDrift([r], envs, KNOWN, now)
    expect(out.map((f) => f.environment_id)).toEqual([1])
    expect(out[0].message).toContain('35 days')
  })
})

describe('tick helpers', () => {
  it('rotate leads with a different environment; p95 is nearest-rank', () => {
    expect(rotate([1, 2, 3, 4], 1)).toEqual([2, 3, 4, 1])
    expect(rotate([1, 2, 3, 4], 9)).toEqual([2, 3, 4, 1])
    expect(rotate([], 3)).toEqual([])
    expect(p95([])).toBeNull()
    expect(p95(Array.from({ length: 100 }, (_, i) => i + 1))).toBe(95)
  })
})

describe('probeFetch (redirects never followed, body capped)', () => {
  const realFetch = globalThis.fetch
  const answer = (res: Response) => {
    globalThis.fetch = vi.fn(async () => res) as typeof fetch
  }
  it('a 3xx is REDIRECT; a body over the cap is BODY_TOO_LARGE; JSON is parsed', async () => {
    try {
      answer(new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/' } }))
      await expect(probeFetch('https://a.example/api/version', {}, 1000)).rejects.toMatchObject({
        code: 'REDIRECT'
      })
      expect(vi.mocked(globalThis.fetch).mock.calls[0][1]).toMatchObject({ redirect: 'manual' })
      answer(new Response('x'.repeat(PROBE_BODY_MAX + 10), { status: 200 }))
      await expect(probeFetch('https://a.example/api/version', {}, 1000)).rejects.toMatchObject({
        code: 'BODY_TOO_LARGE'
      })
      answer(new Response(JSON.stringify({ version: '0.3.214' }), { status: 200 }))
      expect(await probeFetch('https://a.example/api/version', {}, 1000)).toEqual({
        ok: true,
        status: 200,
        body: { version: '0.3.214' }
      })
    } finally {
      globalThis.fetch = realFetch
    }
  })
  it('a redirecting environment is down with code REDIRECT', async () => {
    try {
      answer(new Response(null, { status: 301, headers: { location: 'https://elsewhere/' } }))
      expect(await probeEnvironment('https://a.example')).toMatchObject({
        up: false,
        code: 'REDIRECT'
      })
    } finally {
      globalThis.fetch = realFetch
    }
  })
})

describe('uptime', () => {
  it('percent, budget, months', () => {
    expect(uptimePercent({ samples: 0, up: 0 })).toBeNull()
    expect(uptimePercent({ samples: 1000, up: 995 })).toBe(99.5)
    expect(toBp(99.95)).toBe(9995)
    const f = sloFigures({ samples: 1000, up: 996 }, 99.5)
    expect(f).toMatchObject({ met: true, budget_samples: 5, used_samples: 4, left_samples: 1 })
    expect(sloFigures({ samples: 0, up: 0 }, 99).met).toBeNull()
    expect(previousMonth(new Date('2026-01-01T07:00:00Z'))).toBe('2025-12')
    expect(monthOf(new Date('2026-11-24T00:00:00Z'))).toBe('2026-11')
    expect(monthBounds('2026-02')).toEqual({
      from: new Date('2026-02-01T00:00:00.000Z'),
      to: new Date('2026-03-01T00:00:00.000Z')
    })
    expect(monthBounds('2026-13')).toBeNull()
  })
})

describe('settings', () => {
  it('defaults are valid and round-trip', () => {
    const d = defaultFleetSettings()
    const out = normalizeFleetSettings(JSON.parse(JSON.stringify(d)))
    expect(out).toEqual({ ok: true, settings: d })
    // Every rule ships off: an admin turns each one on.
    expect(d.rules.every((r) => !r.enabled)).toBe(true)
  })
  it('refuses bad rules and targets', () => {
    expect(normalizeFleetSettings({ rules: [{ id: 'A b', kind: 'behind_newest', n: 1 }] }).ok).toBe(
      false
    )
    expect(normalizeFleetSettings({ rules: [{ id: 'a', kind: 'nope', n: 1 }] }).ok).toBe(false)
    expect(normalizeFleetSettings({ rules: [{ id: 'a', kind: 'behind_newest', n: 0 }] }).ok).toBe(
      false
    )
    expect(
      normalizeFleetSettings({
        rules: [{ id: 'a', kind: 'pair_apart', n: 2, from_key: 'x', to_key: 'x' }]
      }).ok
    ).toBe(false)
    expect(normalizeFleetSettings({ slo: { default_target: 20 } }).ok).toBe(false)
    expect(normalizeFleetSettings({ slo: { targets: { abc: 99 } } }).ok).toBe(false)
    const many = Object.fromEntries(Array.from({ length: 2001 }, (_, i) => [String(i + 1), 99]))
    expect(normalizeFleetSettings({ slo: { targets: many } }).ok).toBe(false)
    expect(
      normalizeFleetSettings({
        rules: [
          { id: 'a', kind: 'stale_deploy', n: 3 },
          { id: 'a', kind: 'stale_deploy', n: 4 }
        ]
      }).ok
    ).toBe(false)
  })
  it('per-environment targets win over the default; blanks drop', () => {
    const out = normalizeFleetSettings({
      slo: { default_target: 99, targets: { '7': 99.9, '8': '' } }
    })
    if (!out.ok) throw new Error(out.error)
    expect(out.settings.slo.targets).toEqual({ '7': 99.9 })
    expect(targetFor(out.settings, 7)).toBe(99.9)
    expect(targetFor(out.settings, 9)).toBe(99)
  })
})

describe('probeEnvironment', () => {
  const answers = (v: unknown, r: unknown) =>
    vi.fn(async (url: string) => {
      const a = url.endsWith('/api/version') ? v : r
      if (a instanceof Error) throw a
      return a as { ok: boolean; status: number; body: unknown }
    })
  it('up when the version answers and ready did not refuse', async () => {
    const fetch = answers(
      { ok: true, status: 200, body: { version: '0.3.214' } },
      { ok: false, status: 404, body: null }
    )
    const s = await probeEnvironment('https://efp.example.com/x?y', { fetch })
    expect(s).toMatchObject({ up: true, version_ok: true, ready: null, version: '0.3.214' })
    expect(fetch).toHaveBeenCalledWith(
      'https://efp.example.com/api/version',
      expect.anything(),
      expect.any(Number)
    )
  })
  it('down when not ready, on an HTTP error, or unreachable', async () => {
    const ok = { ok: true, status: 200, body: { version: '0.3.214' } }
    expect(
      await probeEnvironment('https://a.example', {
        fetch: answers(ok, { ok: false, status: 503, body: {} })
      })
    ).toMatchObject({ up: false, ready: false, code: 'NOT_READY' })
    expect(
      await probeEnvironment('https://a.example', {
        fetch: answers({ ok: false, status: 502, body: '' }, ok)
      })
    ).toMatchObject({ up: false, code: 'HTTP_502' })
    expect(
      await probeEnvironment('https://a.example', {
        fetch: answers(new Error('ECONNREFUSED'), ok)
      })
    ).toMatchObject({ up: false, code: 'UNREACHABLE' })
    expect(await probeEnvironment('ftp://a.example')).toMatchObject({ code: 'BAD_BASE_URL' })
  })
  it('a hung answer is a timeout, never a hung tick', async () => {
    const fetch = vi.fn(() => new Promise<never>(() => {}))
    const s = await probeEnvironment('https://a.example', { fetch, timeoutMs: 20 })
    expect(s).toMatchObject({ up: false, code: 'TIMEOUT' })
  })
})

describe('eachBounded', () => {
  it('stops starting work once the budget is spent', async () => {
    let t = 0
    const seen: number[] = []
    const out = await eachBounded(
      [1, 2, 3, 4],
      1,
      async (i) => {
        seen.push(i)
        t += 10
      },
      15,
      () => t
    )
    expect(seen).toEqual([1, 2])
    expect(out).toEqual({ done: 2, skipped: 2 })
  })
})

describe('audit helpers', () => {
  it('labels, categories and comments', () => {
    expect(labelOf('hub-promote-start', 'nivaro_hub_deploys')).toBe('Promotion started')
    expect(labelOf('update', 'nivaro_hub_drivers')).toBe('Driver changed')
    expect(categoryOf('hub-promote-start', 'nivaro_hub_deploys', 'rollback')).toBe('rollback')
    expect(categoryOf('hub-stack-apply', 'nivaro_hub_deploys')).toBe('stack')
    expect(categoryOf('hub-move-start', 'nivaro_hub_environments')).toBe('move')
    expect(categoryOf('hub-signin-key-rotate', 'nivaro_hub_oidc_keys')).toBe('keys')
    expect(categoryOf('hub-signin-client-create', 'nivaro_hub_oidc_clients')).toBe('signin')
    expect(categoryOf('hub-shared-upgrade', 'nivaro_hub_shared_deployments')).toBe('upgrade')
    expect(categoryOf('hub-create-start', 'nivaro_hub_apps')).toBe('creation')
    expect(categoryOf('update', 'nivaro_hub_drivers')).toBe('config')
    expect(readComment('{"move_id":3,"reason":"cut costs"}')).toMatchObject({
      note: 'cut costs',
      detail: 'move_id: 3'
    })
    expect(readComment('Check now: ok')).toMatchObject({ note: null, detail: 'Check now: ok' })
  })
  it('CSV quotes cells and defuses formulas', () => {
    const csv = auditCsv([
      {
        id: 'a:1',
        at: '2026-11-24T00:00:00.000Z',
        action: 'hub-promote-start',
        category: 'promote',
        label: 'Promotion started',
        app_id: 1,
        app_key: 'efp',
        environment_id: 2,
        env_key: 'production',
        user_id: null,
        user_name: 'Rob, Lee',
        result: 'success',
        note: '=cmd()',
        detail: null,
        target: { table: 'nivaro_hub_deploys', id: '9' }
      }
    ])
    const [head, row] = csv.trim().split('\r\n')
    expect(head.startsWith('"When (UTC)","Action",')).toBe(true)
    expect(row).toContain('"Rob, Lee"')
    expect(row).toContain('"\'=cmd()"')
  })
})
