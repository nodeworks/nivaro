import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../db/index.js', () => ({ db: vi.fn() }))

import {
  classifyRunner,
  gitlabContainerPattern,
  loadGitlabHealth,
  parseReadiness,
  setGitlabFetchForTests,
  summarizePending
} from './gitlab-health.js'

const saved = { ...process.env }
beforeEach(() => {
  delete process.env.TELEMETRY_STORE_URL
  delete process.env.GITLAB_HEALTH_TOKEN
})
afterEach(() => {
  process.env = { ...saved }
  setGitlabFetchForTests(null)
})

const NOW = Date.parse('2026-10-21T12:00:00Z')

describe('classifyRunner', () => {
  it('flags stale (by status or by contacted_at over a day) and never-contacted', () => {
    expect(classifyRunner({ id: 1, status: 'stale' }, NOW).state).toBe('stale')
    expect(
      classifyRunner({ id: 2, status: 'offline', contacted_at: '2026-10-19T12:00:00Z' }, NOW).state
    ).toBe('stale')
    expect(classifyRunner({ id: 3, status: 'never_contacted' }, NOW).state).toBe('never_contacted')
    const ok = classifyRunner(
      { id: 4, status: 'online', online: true, contacted_at: '2026-10-21T11:59:00Z' },
      NOW
    )
    expect(ok.state).toBe('online')
    expect(ok.flagged).toBe(false)
    expect(
      classifyRunner(
        { id: 5, status: 'offline', online: false, contacted_at: '2026-10-21T10:00:00Z' },
        NOW
      ).state
    ).toBe('offline')
  })
})

describe('parseReadiness', () => {
  it('reads the status and names the failing checks', () => {
    const r = parseReadiness({
      status: 'failed',
      db_check: [{ status: 'ok' }],
      redis_check: [{ status: 'failed' }]
    })
    expect(r?.ok).toBe(false)
    expect(r?.checks).toEqual([
      { name: 'db', status: 'ok' },
      { name: 'redis', status: 'failing' }
    ])
    expect(parseReadiness('not json')).toBeNull()
  })
})

describe('summarizePending', () => {
  it('counts and finds the oldest', () => {
    const s = summarizePending(
      [{ created_at: '2026-10-21T11:00:00Z' }, { created_at: '2026-10-21T09:00:00Z' }],
      NOW
    )
    expect(s).toEqual({ count: 2, oldest_age_s: 3 * 3600 })
    expect(summarizePending([], NOW)).toEqual({ count: 0, oldest_age_s: null })
  })
})

describe('gitlabContainerPattern', () => {
  it('anchors an operator pattern as "contains", case-insensitive', () => {
    expect(gitlabContainerPattern('')).toBe('(?i).*(gitlab).*')
    expect(gitlabContainerPattern('/gitlab-ce/')).toBe('(?i).*(gitlab-ce).*')
  })
})

describe('loadGitlabHealth', () => {
  it('is unconfigured without a component', async () => {
    const v = await loadGitlabHealth(null)
    expect(v.configured).toBe(false)
  })

  it('degrades per part: health blocked, runners fall back, jobs fall back to projects', async () => {
    const calls: string[] = []
    setGitlabFetchForTests(async (url, init) => {
      calls.push(url)
      const h = init.headers as Record<string, string>
      const u = new URL(url)
      if (u.pathname.startsWith('/-/')) return new Response('', { status: 404 })
      expect(h['PRIVATE-TOKEN']).toBe('tok-secret')
      if (u.pathname === '/api/v4/version')
        return new Response(JSON.stringify({ version: '17.5.1', revision: 'abc' }), { status: 200 })
      if (u.pathname === '/api/v4/runners/all') return new Response('{}', { status: 403 })
      if (u.pathname === '/api/v4/runners')
        return new Response(
          JSON.stringify([
            {
              id: 1,
              description: 'r1',
              status: 'online',
              online: true,
              contacted_at: new Date().toISOString()
            },
            { id: 2, description: 'r2', status: 'stale' }
          ]),
          { status: 200 }
        )
      if (u.pathname === '/api/v4/jobs') return new Response('{}', { status: 403 })
      if (u.pathname === '/api/v4/projects/grp%2Fapp/jobs')
        return new Response(JSON.stringify([{ created_at: '2026-10-21T11:00:00Z' }]), {
          status: 200
        })
      return new Response('', { status: 500 })
    })
    const v = await loadGitlabHealth({
      base: 'https://git.example.com',
      token: 'tok-secret',
      projects: ['grp/app']
    })
    expect(v.health?.ok).toBe(false)
    expect(v.health?.error).toContain('Not reachable from this server')
    expect(v.version?.data?.version).toBe('17.5.1')
    expect(v.runners?.data?.scope).toBe('visible')
    expect(v.runners?.data?.counts.stale).toBe(1)
    expect(v.runners?.data?.runners[0].name).toBe('r2')
    expect(v.pending?.data?.source).toBe('projects')
    expect(v.pending?.data?.count).toBe(1)
    expect(v.container?.error).toBe('telemetry store not configured')
    expect(JSON.stringify(v)).not.toContain('tok-secret')
  })

  it('sends the health token only to the health endpoints, as a query value', async () => {
    process.env.GITLAB_HEALTH_TOKEN = 'hk-secret'
    const urls: string[] = []
    setGitlabFetchForTests(async (url) => {
      urls.push(url)
      if (url.includes('/-/readiness'))
        return new Response(JSON.stringify({ status: 'ok', db_check: [{ status: 'ok' }] }), {
          status: 200
        })
      if (url.includes('/-/liveness')) return new Response('{"status":"ok"}', { status: 200 })
      return new Response('[]', { status: 200 })
    })
    const v = await loadGitlabHealth({ base: 'https://g', token: null, projects: [] })
    expect(v.health?.data?.readiness?.ok).toBe(true)
    expect(v.health?.data?.liveness).toBe(true)
    expect(urls.filter((u) => u.includes('token=hk-secret'))).toHaveLength(2)
    expect(JSON.stringify(v)).not.toContain('hk-secret')
  })
})
