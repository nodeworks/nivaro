import { describe, expect, it } from 'vitest'
import {
  buildTimeline,
  type DraftSources,
  downSpans,
  normalizePostMortem,
  postMortemHtml,
  postMortemMarkdown,
  windowOf
} from '../../../services/hub/incident/postmortem.js'
import {
  chainOf,
  firstHandover,
  onCallAt,
  type Rota,
  upcomingShifts,
  validateOverride,
  validateRota
} from '../../../services/hub/incident/rota.js'
import {
  appStateOf,
  envState,
  hashToken,
  mintToken,
  pageLive,
  type StatusAnswer,
  statusPageHtml
} from '../../../services/hub/incident/status-page.js'
import {
  bannerAnnouncement,
  bannerKey,
  clearStatusBanner,
  plainBannerText,
  readStatusBanner,
  setStatusBanner
} from '../../../services/hub-link/status-banner.js'
import { maskUrlPath, maskUrlQuery } from '../../../services/secret-mask.js'

// Hub incidents (enhancements 32–35), the pure parts: rota arithmetic, the banner's plain text
// and store, status page states and HTML, post-mortem timeline and exports.

const A = 'aaaaaaaa-0000-4000-8000-000000000001'
const B = 'bbbbbbbb-0000-4000-8000-000000000002'
const C = 'cccccccc-0000-4000-8000-000000000003'

function rota(extra: Partial<Rota> = {}): Rota {
  return {
    id: 1,
    app_id: 1,
    enabled: true,
    people: [A, B, C],
    time_zone: 'America/New_York',
    handover_weekday: 1,
    handover_time: '09:00',
    // Wednesday 2026-11-04 12:00 ET
    starts_on: '2026-11-04T17:00:00.000Z',
    escalate_minutes: 15,
    steps: ['on_call', 'next', 'owners', 'admins'],
    updated_by: null,
    updated_at: null,
    ...extra
  }
}

describe('on-call rota', () => {
  it('the first person covers until the first hand-over, then the list goes round', () => {
    const r = rota()
    // Monday 2026-11-09 09:00 EST = 14:00 UTC.
    expect(new Date(firstHandover(r)).toISOString()).toBe('2026-11-09T14:00:00.000Z')
    expect(onCallAt(r, [], Date.parse('2026-11-06T10:00:00Z')).user_id).toBe(A)
    expect(onCallAt(r, [], Date.parse('2026-11-09T13:59:00Z')).user_id).toBe(A)
    const at = onCallAt(r, [], Date.parse('2026-11-09T14:00:00Z'))
    expect(at.user_id).toBe(B)
    expect(at.next_user_id).toBe(C)
    expect(onCallAt(r, [], Date.parse('2026-11-16T14:00:00Z')).user_id).toBe(C)
    expect(onCallAt(r, [], Date.parse('2026-11-23T14:00:00Z')).user_id).toBe(A)
  })

  it('keeps 09:00 on the zone clock across a DST change', () => {
    const r = rota({ starts_on: '2027-03-03T17:00:00.000Z' })
    // US DST starts 2027-03-14: Monday 2027-03-15 09:00 EDT = 13:00 UTC.
    expect(onCallAt(r, [], Date.parse('2027-03-15T12:59:00Z')).user_id).toBe(B)
    expect(onCallAt(r, [], Date.parse('2027-03-15T13:00:00Z')).user_id).toBe(C)
  })

  it('nobody before the start, nobody when off; an override wins and the rota person is next', () => {
    const r = rota()
    expect(onCallAt(r, [], Date.parse('2026-11-01T00:00:00Z')).user_id).toBeNull()
    expect(
      onCallAt({ ...r, enabled: false }, [], Date.parse('2026-11-10T00:00:00Z')).user_id
    ).toBeNull()
    const ov = {
      id: 7,
      app_id: 1,
      user_id: C,
      starts_at: '2026-11-10T00:00:00.000Z',
      ends_at: '2026-11-11T00:00:00.000Z',
      note: null,
      created_by: null
    }
    const at = onCallAt(r, [ov], Date.parse('2026-11-10T12:00:00Z'))
    expect(at.user_id).toBe(C)
    expect(at.next_user_id).toBe(B)
    expect(at.override?.id).toBe(7)
  })

  it('lists the upcoming shifts', () => {
    const s = upcomingShifts(rota(), [], Date.parse('2026-11-10T00:00:00Z'), 3)
    expect(s.map((x) => x.user_id)).toEqual([B, C, A])
    expect(s[0].to).toBe('2026-11-16T14:00:00.000Z')
  })

  it('validates a rota and an override', () => {
    expect(validateRota({ people: [A, A] })).toEqual({ error: 'a person is listed twice' })
    expect(validateRota({ people: ['bob'] })).toHaveProperty('error')
    expect(validateRota({ people: [A], steps: ['owners'] })).toEqual({
      error: 'the first step is on_call'
    })
    expect(validateRota({ people: [A], time_zone: 'Mars/Olympus' })).toHaveProperty('error')
    const ok = validateRota({ people: [A, B], time_zone: 'Europe/London', handover_time: '08:30' })
    expect(ok).toMatchObject({ people: [A, B], handover_time: '08:30', escalate_minutes: 15 })
    expect(
      validateOverride({
        user_id: A,
        starts_at: '2026-11-10T00:00:00Z',
        ends_at: '2026-11-09T00:00:00Z'
      })
    ).toHaveProperty('error')
  })
})

class FakeRedis {
  store = new Map<string, string>()
  ttl = new Map<string, number>()
  async get(k: string) {
    return this.store.get(k) ?? null
  }
  async set(k: string, v: string, _mode: 'EX', s: number) {
    this.store.set(k, v)
    this.ttl.set(k, s)
    return 'OK'
  }
  async del(k: string) {
    this.store.delete(k)
    return 1
  }
}

describe('status banner (app side)', () => {
  it('keeps plain text only: no markup, no control characters, capped', () => {
    expect(plainBannerText('<b>Down</b>\n<script>alert(1)</script>  now')).toBe(
      'bDown/b scriptalert(1)/script now'
    )
    expect(plainBannerText('   ')).toBeNull()
    expect(plainBannerText(42)).toBeNull()
    expect(plainBannerText('x'.repeat(400))?.length).toBe(280)
  })

  it('stores with a TTL, reads back, clears only its own incident', async () => {
    const r = new FakeRedis()
    const out = await setStatusBanner(r, { text: 'Orders <slow>', tone: 'warn', incident_id: 4 })
    expect(out).toMatchObject({
      ok: true,
      banner: { text: 'Orders slow', tone: 'warn', incident: 4 }
    })
    expect(r.ttl.get(bannerKey())).toBe(7200)
    expect((await readStatusBanner(r))?.text).toBe('Orders slow')
    await clearStatusBanner(r, { incident_id: 5 })
    expect(await readStatusBanner(r)).not.toBeNull()
    await clearStatusBanner(r, { incident_id: 4 })
    expect(await readStatusBanner(r)).toBeNull()
    expect(await setStatusBanner(r, { text: '', incident_id: 4 })).toMatchObject({
      ok: false,
      code: 'BAD_BANNER'
    })
    expect(await setStatusBanner(null, { text: 'x', incident_id: 4 })).toMatchObject({
      code: 'REDIS_UNAVAILABLE'
    })
  })

  it('is a non-dismissable announcement row', () => {
    const row = bannerAnnouncement({ text: 'Down', tone: 'critical', incident: 1, set_at: '' })
    expect(row).toMatchObject({ id: -3, message: 'Down', severity: 'critical', dismissable: false })
  })

  it('keys per app: the hub-link tag on a dedicated app', () => {
    const a = bannerKey({ HUB_TOKEN: 'a'.repeat(40) } as NodeJS.ProcessEnv)
    const b = bannerKey({ HUB_TOKEN: 'b'.repeat(40) } as NodeJS.ProcessEnv)
    expect(a).not.toBe(b)
    expect(a.startsWith('nvr:hub-banner:')).toBe(true)
  })
})

describe('status page', () => {
  const now = Date.parse('2026-11-25T12:00:00Z')
  it('judges an environment and an app from its production environments', () => {
    const fresh = '2026-11-25T11:59:00.000Z'
    expect(envState(undefined, now)).toBe('unknown')
    expect(
      envState({ up: true, state: 'ok', probed_at: '2026-11-25T10:00:00Z', checked_at: null }, now)
    ).toBe('unknown')
    expect(envState({ up: false, state: 'ok', probed_at: fresh, checked_at: null }, now)).toBe(
      'major_outage'
    )
    expect(envState({ up: true, state: 'degraded', probed_at: fresh, checked_at: null }, now)).toBe(
      'degraded'
    )
    expect(appStateOf(['major_outage', 'operational'])).toBe('partial_outage')
    expect(appStateOf(['major_outage', 'unknown'])).toBe('major_outage')
    expect(appStateOf(['unknown'])).toBe('unknown')
  })

  it('tokens: prefix, SHA-256, hint; expiry and revocation', () => {
    const t = mintToken()
    expect(t.token).toMatch(/^nvs_[A-Za-z0-9_-]{43}$/)
    expect(t.hash).toBe(hashToken(t.token))
    expect(t.hash).toHaveLength(64)
    expect(t.token.endsWith(t.hint)).toBe(true)
    expect(pageLive({ revoked_at: null, expires_at: '2026-11-26T00:00:00Z' }, now)).toBe(true)
    expect(pageLive({ revoked_at: null, expires_at: '2026-11-25T00:00:00Z' }, now)).toBe(false)
    expect(pageLive({ revoked_at: '2026-11-20T00:00:00Z', expires_at: null }, now)).toBe(false)
  })

  it('renders escaped, script-free HTML', () => {
    const a: StatusAnswer = {
      name: 'Acme <status>',
      overall: 'partial_outage',
      overall_word: 'Partial outage',
      apps: [
        {
          name: 'EFP "prod"',
          state: 'partial_outage',
          state_word: 'Partial outage',
          uptime_30d: 99.5,
          days: [{ date: '2026-11-25', uptime: 98 }],
          incident: {
            state: 'partial_outage',
            text: '<img src=x onerror=1>',
            since: '2026-11-25T11:00:00.000Z'
          }
        }
      ],
      planned: [
        {
          app: null,
          title: 'Planned update',
          starts_at: '2026-11-26T10:00:00.000Z',
          ends_at: null,
          kind: 'update'
        }
      ],
      updated_at: '2026-11-25T12:00:00.000Z'
    }
    const html = statusPageHtml(a)
    expect(html).not.toContain('<script')
    expect(html).not.toContain('<img')
    expect(html).toContain('&lt;img src=x onerror=1&gt;')
    expect(html).toContain('Acme &lt;status&gt;')
    expect(html).toContain('EFP &quot;prod&quot;')
    expect(html).toContain('All apps: Planned update')
  })
})

describe('post-mortem', () => {
  const inc = { opened_at: '2026-11-25T10:00:00.000Z', resolved_at: '2026-11-25T11:00:00.000Z' }
  it('windows from two hours before to thirty minutes after', () => {
    const w = windowOf(inc, Date.parse('2026-11-26T00:00:00Z'))
    expect(new Date(w.from).toISOString()).toBe('2026-11-25T08:00:00.000Z')
    expect(new Date(w.to).toISOString()).toBe('2026-11-25T11:30:00.000Z')
  })

  it('folds probes into down spans', () => {
    expect(
      downSpans([
        { at: 'a', up: true },
        { at: 'b', up: false },
        { at: 'c', up: false },
        { at: 'd', up: true },
        { at: 'e', up: false }
      ])
    ).toEqual([
      { from: 'b', to: 'd', failed: 2 },
      { from: 'e', to: null, failed: 1 }
    ])
  })

  it('builds the timeline from deploys, alerts, errors, uptime and the incident', () => {
    const src: DraftSources = {
      envKeys: new Map([[3, 'production']]),
      deploys: [
        {
          environment_id: 3,
          kind: 'promote',
          version: '0.3.215',
          from_version: '0.3.214',
          status: 'failed',
          started_at: '2026-11-25T09:50:00Z',
          finished_at: '2026-11-25T09:55:00Z',
          started_by: A
        }
      ],
      moves: [],
      alerts: [
        { environment_id: 3, message: 'production behind', opened_at: '2026-11-25T10:05:00Z' }
      ],
      pages: [],
      issues: [
        {
          environment_id: 3,
          kind: 'server',
          title: 'Pool exhausted',
          occurrences: 12,
          first_seen: '2026-11-25T09:56:00Z'
        }
      ],
      samples: [
        { environment_id: 3, at: '2026-11-25T09:57:00.000Z', up: false },
        { environment_id: 3, at: '2026-11-25T09:58:00.000Z', up: false },
        { environment_id: 3, at: '2026-11-25T10:20:00.000Z', up: true }
      ],
      hours: [],
      events: [
        {
          id: 1,
          incident_id: 1,
          at: '2026-11-25T10:00:00.000Z',
          kind: 'opened',
          text: 'SEV 1 · Down',
          user_id: A
        }
      ],
      names: new Map([[A.toLowerCase(), 'Ada Admin']])
    }
    const t = buildTimeline(src, {
      from: Date.parse('2026-11-25T08:00:00Z'),
      to: Date.parse('2026-11-25T11:30:00Z')
    })
    const texts = t.map((x) => x.text)
    expect(texts[0]).toBe('Deploy of 0.3.215 to production started by Ada Admin (from 0.3.214)')
    expect(texts).toContain('Deploy of 0.3.215 to production failed')
    expect(texts).toContain('New error on production: Pool exhausted (12 times)')
    expect(texts).toContain('production stopped answering the Hub’s probes')
    expect(texts).toContain('production answered again after 23 min')
    expect(texts).toContain('Incident opened: SEV 1 · Down (Ada Admin)')
    expect(t.map((x) => x.at)).toEqual([...t.map((x) => x.at)].sort())
  })

  it('exports Markdown and HTML with values escaped; validates an edit', () => {
    const pm = normalizePostMortem({
      title: 'PM <x>',
      summary: '<script>bad</script>',
      timeline: [{ at: '2026-11-25T10:00:00Z', kind: 'note', text: 'a <b>c</b>' }],
      actions: [{ text: 'Add an alert', owner: 'Ops', done: true }, { text: '' }]
    })
    if ('error' in pm) throw new Error(pm.error)
    expect(pm.actions).toHaveLength(1)
    const facts = {
      app: 'EFP',
      environment: 'production',
      severity: 'sev1',
      status: 'resolved',
      opened_at: '2026-11-25T10:00:00.000Z',
      resolved_at: '2026-11-25T11:00:00.000Z'
    }
    const md = postMortemMarkdown(pm, facts)
    expect(md).toContain('# PM &lt;x&gt;')
    expect(md).not.toContain('<script>')
    expect(md).toContain('- [x] Add an alert — Ops')
    expect(md).toContain('**Duration:** 60 min')
    const html = postMortemHtml(pm, facts)
    expect(html).not.toContain('<script>bad')
    expect(html).toContain('&lt;script&gt;bad&lt;/script&gt;')
    expect(normalizePostMortem({ timeline: [{ at: 'nope', text: 'x' }] })).toHaveProperty('error')
  })
})

describe('review fixes (pure)', () => {
  it('M1: a status page token never reaches a log in clear', () => {
    const t = `nvs_${'a'.repeat(43)}`
    expect(maskUrlPath(`/api/hub/status-page/${t}`)).toBe('/api/hub/status-page/••••••')
    expect(maskUrlQuery(`/api/hub/status-page/${t}?format=json`)).not.toContain(t)
  })

  it('L7: Markdown export escapes link and image syntax', () => {
    const pm = normalizePostMortem({
      title: 'PM',
      summary: '![x](https://tracker.example/beacon) and [click](javascript:alert(1))',
      timeline: [],
      actions: []
    })
    if ('error' in pm) throw new Error(pm.error)
    const md = postMortemMarkdown(pm, {
      app: 'EFP',
      environment: null,
      severity: 'sev2',
      status: 'open',
      opened_at: '2026-11-25T10:00:00.000Z',
      resolved_at: null
    })
    expect(md).not.toContain('![x](')
    expect(md).not.toContain('[click](')
    expect(md).toContain('\\!\\[x\\]\\(https://tracker.example/beacon\\)')
  })

  it('M2: a rota without people is refused; the chain always ends with owners and admins', () => {
    expect(validateRota({ people: [] })).toEqual({ error: 'a rota names at least one person' })
    expect(chainOf({ steps: ['on_call'] })).toEqual(['on_call', 'owners', 'admins'])
    expect(chainOf({ steps: ['on_call', 'admins'] })).toEqual(['on_call', 'admins', 'owners'])
  })
})
