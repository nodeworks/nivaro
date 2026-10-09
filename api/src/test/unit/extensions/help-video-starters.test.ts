import { describe, expect, it, vi } from 'vitest'
import { registrationMembers } from '../../../extensions/loader.js'
import {
  clearHelpVideoRegistrations,
  describeHelpVideoRegistrations,
  resolveStarterPath,
  toPackageContexts
} from '../../../services/help-video-starters.js'

const VID = '11111111-1111-4111-8111-111111111111'

function members(extDir?: string) {
  const owned: string[] = []
  const noted: string[] = []
  const ctx = {
    app: { cron: { schedule: vi.fn(), unschedule: vi.fn(), annotate: vi.fn() } } as never,
    logger: { info() {}, warn() {}, error() {}, debug() {} } as never,
    database: {} as never
  }
  const m = registrationMembers('hv', ctx, {
    note: (c) => noted.push(c),
    own: (kind, label) => owned.push(`${kind}: ${label}`),
    cronPrefix: 'ext:hv:',
    extDir
  })
  return { m, owned, noted }
}

describe('ctx.helpVideos (#1514)', () => {
  it('records pages, starters and screens in the ledger', () => {
    clearHelpVideoRegistrations('hv')
    const { m, owned, noted } = members('/srv/ext/hv')
    m.helpVideos.declarePage({ key: 'orders.board', label: 'Orders board', app: 'admin' })
    m.helpVideos.registerStarter({
      package: 'videos/starters.tar',
      contexts: [{ kind: 'collection', key: 'orders' }]
    })
    m.helpVideos.addContexts(VID, [{ kind: 'collection', key: 'orders', state_key: 'review' }])
    expect(owned).toEqual([
      'help_videos: page orders.board · Orders board',
      'help_videos: starter videos/starters.tar',
      `help_videos: screens for ${VID} · 1`
    ])
    expect(noted).toEqual(['help-videos', 'help-videos', 'help-videos'])
    expect(describeHelpVideoRegistrations('hv')).toEqual({
      pages: ['orders.board'],
      starters: ['videos/starters.tar'],
      contexts: [VID]
    })
  })

  it('skips a bad declaration without throwing out of register()', () => {
    clearHelpVideoRegistrations('hv')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { m, owned } = members('/srv/ext/hv')
    expect(() => m.helpVideos.declarePage({ key: 'has space', label: 'x' })).not.toThrow()
    expect(() => m.helpVideos.registerStarter({ package: '../other/x.tar' })).not.toThrow()
    expect(() => m.helpVideos.registerStarter({ package: '/etc/passwd' })).not.toThrow()
    expect(() => m.helpVideos.addContexts('not-a-uuid', [])).not.toThrow()
    expect(() =>
      m.helpVideos.addContexts(VID, [{ kind: 'nope' as 'page', key: 'x' }])
    ).not.toThrow()
    expect(owned).toEqual([])
    expect(warn).toHaveBeenCalledTimes(5)
    warn.mockRestore()
    // No extension folder (nothing to resolve a package against): skipped too.
    const bare = members(undefined)
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    bare.m.helpVideos.registerStarter({ package: 'videos/a.tar' })
    expect(bare.owned).toEqual([])
  })
})

describe('resolveStarterPath + toPackageContexts', () => {
  it('keeps package paths inside the extension folder', () => {
    expect(resolveStarterPath('/srv/ext/hv', 'videos/a.tar')).toBe('/srv/ext/hv/videos/a.tar')
    expect(() => resolveStarterPath('/srv/ext/hv', '../hv2/a.tar')).toThrow(/inside/)
    expect(() => resolveStarterPath('/srv/ext/hv', 'videos/../../x')).toThrow(/inside/)
    expect(() => resolveStarterPath('/srv/ext/hv', '/abs/a.tar')).toThrow(/relative/)
    expect(() => resolveStarterPath('/srv/ext/hv', '.')).toThrow(/inside/)
  })
  it('validates and dedupes screens', () => {
    expect(
      toPackageContexts([
        { kind: 'page', key: 'a.b' },
        { kind: 'page', key: 'a.b' },
        { kind: 'collection', key: 'orders', state_key: 'review' },
        { kind: 'page', key: 'p', state_key: 'ignored' }
      ])
    ).toEqual([
      { kind: 'page', key: 'a.b', state_key: null },
      { kind: 'collection', key: 'orders', state_key: 'review' },
      { kind: 'page', key: 'p', state_key: null }
    ])
    expect(() => toPackageContexts([{ kind: 'collection', key: 'bad key' }])).toThrow(/Invalid/)
  })
})
