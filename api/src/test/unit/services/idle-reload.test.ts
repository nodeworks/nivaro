import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../version.js', () => ({ NIVARO_VERSION: '0.3.9' }))
vi.mock('../../../db/index.js', () => ({ db: () => ({}) }))

import { makeBuildJudge, SETTLE_MS } from '../../../services/client-versions-cluster.js'
import {
  effectiveIdleReload,
  IDLE_RELOAD_DEFAULTS,
  idleReloadEnv,
  idleReloadVerdict,
  normalizeIdleReloadSettings
} from '../../../services/idle-reload.js'

const NOW = 1_800_000_000_000

function tab(app: string, build: string, loaded: number, api: string | null = null) {
  return {
    app,
    user: { id: 'U1', name: 'A' },
    version: { build, api, tab: `t-${build}-${loaded}`, loaded }
  }
}

describe('idle reload — settings', () => {
  afterEach(() => {
    delete process.env.AUTO_RELOAD_IDLE
  })

  it('defaults on, 60 s', () => {
    expect(normalizeIdleReloadSettings(undefined)).toEqual(IDLE_RELOAD_DEFAULTS)
    expect(IDLE_RELOAD_DEFAULTS).toEqual({ auto_reload_idle: true, idle_seconds: 60 })
  })

  it('only an explicit false turns it off; seconds are clamped', () => {
    expect(normalizeIdleReloadSettings({ auto_reload_idle: false }).auto_reload_idle).toBe(false)
    expect(normalizeIdleReloadSettings({ auto_reload_idle: 'no' }).auto_reload_idle).toBe(true)
    expect(normalizeIdleReloadSettings({ idle_seconds: 5 }).idle_seconds).toBe(30)
    expect(normalizeIdleReloadSettings({ idle_seconds: 99999 }).idle_seconds).toBe(3600)
    expect(normalizeIdleReloadSettings({ idle_seconds: 'x' }).idle_seconds).toBe(60)
  })

  it('AUTO_RELOAD_IDLE wins over the stored value', () => {
    expect(idleReloadEnv('off')).toBe(false)
    expect(idleReloadEnv('on')).toBe(true)
    expect(idleReloadEnv('')).toBeNull()
    process.env.AUTO_RELOAD_IDLE = 'off'
    expect(effectiveIdleReload(IDLE_RELOAD_DEFAULTS)).toMatchObject({
      auto_reload_idle: false,
      env: false
    })
  })
})

describe('idle reload — is this tab old (the cluster BuildJudge)', () => {
  it('a tab on an older build is old once the new build is current', () => {
    const clients = [tab('efp', 'b1', NOW - 2 * SETTLE_MS), tab('efp', 'b2', NOW - SETTLE_MS - 1)]
    const judge = makeBuildJudge(clients, { roster: [], now: NOW })
    const v = idleReloadVerdict(judge, clients[0], false)
    expect(v).toEqual({ older: 'build', target: 'b2', id: 'idle-efp-b2', reason: 'old' })
    expect(idleReloadVerdict(judge, clients[1], false).reason).toBe('current')
  })

  it('never while a deploy is settling (two builds loaded in the last 10 minutes)', () => {
    const clients = [tab('efp', 'b1', NOW - 60_000), tab('efp', 'b2', NOW - 1000)]
    const judge = makeBuildJudge(clients, { roster: [], now: NOW })
    expect(idleReloadVerdict(judge, clients[0], false)).toMatchObject({
      older: null,
      reason: 'settling'
    })
  })

  it('admin follows the API roster: one version serving = current once a tab reports it', () => {
    const clients = [
      tab('admin', '0.3.8', NOW - 60_000, '0.3.8'),
      tab('admin', '0.3.9', NOW - 2 * SETTLE_MS, '0.3.9')
    ]
    const judge = makeBuildJudge(clients, { roster: ['0.3.9'], now: NOW })
    expect(idleReloadVerdict(judge, clients[0], false)).toMatchObject({
      older: 'build',
      id: 'idle-admin-0.3.9'
    })
    // Two API versions serving: not judged.
    const mixed = makeBuildJudge(clients, { roster: ['0.3.8', '0.3.9'], now: NOW })
    expect(idleReloadVerdict(mixed, clients[0], false).older).toBeNull()
  })

  it('never on a partial cluster read, a dev build or an unreported tab', () => {
    const clients = [tab('efp', 'b1', NOW - 2 * SETTLE_MS), tab('efp', 'b2', NOW - SETTLE_MS - 1)]
    const judge = makeBuildJudge(clients, { roster: [], now: NOW })
    expect(idleReloadVerdict(judge, clients[0], true).reason).toBe('partial')
    expect(idleReloadVerdict(judge, tab('efp', 'dev', NOW), false).reason).toBe('unknown')
    expect(idleReloadVerdict(judge, { app: 'efp', version: null }, false).reason).toBe('unknown')
  })
})
