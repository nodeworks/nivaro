import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

// The db module is never reached: every store/alert step is injected.
vi.mock('../../../db/index.js', () => ({ db: {} }))
vi.mock('../../../services/io-holder.js', () => ({ getApp: () => null }))
vi.mock('../../../services/activity.js', () => ({ logActivity: vi.fn() }))

import {
  bundleFile,
  crashFamily,
  crashFamilyMessage,
  crashFingerprint,
  crashFrames,
  crashHeaderLines,
  crashResolvedStackOf,
  crashSignature,
  crashStackOf,
  isCurrentRelease,
  newInRelease,
  parseCrashMeta,
  scrubCrashText,
  shouldAlertCrash
} from '../../../services/crash-signature.js'
import { decodeMappings, resolveCrashFrames } from '../../../services/crash-sourcemap.js'
import {
  type AlertDeps,
  type CrashDeps,
  maybeAlertCrash,
  recordCrash
} from '../../../services/crash-tracking.js'

const STACK_157 = [
  'TypeError: nn.find is not a function',
  '    at Kt (https://cms.example/assets/LinesGrid-B3kF9a_x.js:1:2345)',
  '    at Xo (https://cms.example/assets/index-Qw12Er34.js:40:99)',
  '    at div',
  '---',
  '    at LinesGrid (https://cms.example/assets/LinesGrid-B3kF9a_x.js:1:100)'
].join('\n')
// The next build: same crash, different minified names and hashes.
const STACK_158 = STACK_157.replaceAll('Kt', 'Zq')
  .replaceAll('Xo', 'Ab')
  .replaceAll('B3kF9a_x', 'C9dLm2Pq')
  .replaceAll('Qw12Er34', 'Zz98Yy76')
  .replace('nn.find', 'rn.find')

describe('crash signature', () => {
  it('reads frames without hashes, origin or the component stack', () => {
    const f = crashFrames(STACK_157)
    expect(f.map((x) => `${x.fn}@${x.file}`)).toEqual([
      'Kt@assets/LinesGrid.js',
      'Xo@assets/index.js'
    ])
    expect(f[0].rawFile).toBe('https://cms.example/assets/LinesGrid-B3kF9a_x.js')
    expect(bundleFile('https://h/assets/page-error-boundary.js')).toBe(
      'assets/page-error-boundary.js'
    )
  })

  it('groups ids and numbers in the message together, not different errors', () => {
    const a = crashSignature({ name: 'TypeError', message: 'Row 4471 has no id', stack: STACK_157 })
    const b = crashSignature({ name: 'TypeError', message: 'Row 9 has no id', stack: STACK_157 })
    const c = crashSignature({
      name: 'TypeError',
      message: 'x.map is not a function',
      stack: STACK_157
    })
    expect(a).toBe(b)
    expect(a).not.toBe(c)
  })

  it('one issue per signature + screen + release', () => {
    const base = { app: 'admin', signature: 's', screen: '/collections/:id', release: '0.3.157' }
    expect(crashFingerprint(base)).toBe(crashFingerprint({ ...base }))
    expect(crashFingerprint(base)).not.toBe(crashFingerprint({ ...base, release: '0.3.158' }))
    expect(crashFingerprint(base)).not.toBe(crashFingerprint({ ...base, screen: '/users' }))
    expect(crashFingerprint(base)).toHaveLength(64)
  })

  it('the family survives a rebuild (minified names and hashes change)', () => {
    const key = { app: 'admin', name: 'TypeError', screen: '/collections/:id/:id' }
    const a = crashFamily({ ...key, message: 'nn.find is not a function', stack: STACK_157 })
    const b = crashFamily({ ...key, message: 'rn.find is not a function', stack: STACK_158 })
    expect(a).toBe(b)
    expect(crashFamilyMessage('nn.find is not a function')).toBe(
      crashFamilyMessage('Qt.find is not a function')
    )
    // …but not across screens or real message differences.
    expect(
      crashFamily({
        ...key,
        screen: '/users',
        message: 'nn.find is not a function',
        stack: STACK_157
      })
    ).not.toBe(a)
  })

  it('the header round-trips and keeps the stack readable', () => {
    const lines = crashHeaderLines({
      app: 'admin',
      release: '0.3.157',
      kind: 'render',
      signature: 'abc',
      family: 'def',
      new_in: '0.3.157',
      seen_in: null,
      frame: 'Kt (assets/LinesGrid.js)'
    })
    const details = [
      'Alerted: 2026-11-13T20:00:00.000Z',
      'Route: /collections/:id/:id',
      ...lines,
      '',
      STACK_157,
      '',
      'Source-mapped stack:',
      '  at LinesGrid (src/components/lines-grid.tsx:88:12)'
    ].join('\n')
    expect(parseCrashMeta(details)).toEqual({
      app: 'admin',
      release: '0.3.157',
      kind: 'render',
      signature: 'abc',
      family: 'def',
      new_in: '0.3.157',
      seen_in: null,
      frame: 'Kt (assets/LinesGrid.js)',
      alerted_at: '2026-11-13T20:00:00.000Z'
    })
    expect(crashStackOf(details)?.startsWith('TypeError: nn.find')).toBe(true)
    expect(crashStackOf(details)).not.toContain('Source-mapped')
    expect(crashResolvedStackOf(details)).toContain('lines-grid.tsx:88:12')
    expect(parseCrashMeta('Route: /x\nTypeError: y')).toBeNull()
  })

  it('scrubs secrets and typed values on the server too', () => {
    const s = scrubCrashText('Invalid "Jane Smith" token=abc123xyz https://h/a.js?x=1:2:3')
    expect(s).toBe('Invalid "…" token=<redacted> https://h/a.js:2:3')
  })
})

describe('new in a release', () => {
  it('is new when the family was never seen in another release', () => {
    expect(newInRelease('0.3.158', [])).toEqual({ new_in: '0.3.158', seen_in: null })
    expect(newInRelease('0.3.158', ['0.3.158'])).toEqual({ new_in: '0.3.158', seen_in: null })
    expect(newInRelease('0.3.158', ['0.3.157', '0.3.150'])).toEqual({
      new_in: null,
      seen_in: '0.3.150'
    })
  })

  it('an older tab or an older admin build is not the current release', () => {
    expect(
      isCurrentRelease('efp-new', '0.3.10', { apiVersion: '0.3.158', newestSeen: '0.3.11' })
    ).toBe(false)
    expect(
      isCurrentRelease('efp-new', '0.3.11', { apiVersion: '0.3.158', newestSeen: '0.3.11' })
    ).toBe(true)
    expect(isCurrentRelease('admin', '0.3.157', { apiVersion: '0.3.158', newestSeen: null })).toBe(
      false
    )
    expect(isCurrentRelease('admin', '0.3.158', { apiVersion: '0.3.158', newestSeen: null })).toBe(
      true
    )
  })

  it('alerts on hits or people, never twice, never for dev or an old crash', () => {
    const base = {
      meta: { release: '0.3.158', new_in: '0.3.158', alerted_at: null },
      current: true,
      hits: 1,
      people: 1,
      minHits: 3,
      minPeople: 2
    }
    expect(shouldAlertCrash(base)).toBe(false)
    expect(shouldAlertCrash({ ...base, hits: 3 })).toBe(true)
    expect(shouldAlertCrash({ ...base, people: 2 })).toBe(true)
    expect(shouldAlertCrash({ ...base, hits: 9, meta: { ...base.meta, alerted_at: 'x' } })).toBe(
      false
    )
    expect(shouldAlertCrash({ ...base, hits: 9, meta: { ...base.meta, new_in: null } })).toBe(false)
    expect(shouldAlertCrash({ ...base, hits: 9, current: false })).toBe(false)
    expect(
      shouldAlertCrash({
        ...base,
        hits: 9,
        meta: { release: 'dev', new_in: 'dev', alerted_at: null }
      })
    ).toBe(false)
  })
})

describe('recordCrash', () => {
  function deps(over: Partial<CrashDeps> = {}) {
    const tracked: Array<Record<string, unknown>> = []
    const d: CrashDeps = {
      findOpen: async () => null,
      familyReleases: async () => [],
      track: vi.fn(async (o) => {
        tracked.push(o as Record<string, unknown>)
        return 42
      }) as unknown as CrashDeps['track'],
      resolve: vi.fn(async () => {}),
      alert: vi.fn(async () => false),
      ...over
    }
    return { d, tracked }
  }
  const input = {
    app: 'admin',
    release: '0.3.158',
    kind: 'render' as const,
    screen: '/collections/:id/:id',
    message: 'nn.find is not a function',
    stack: STACK_157,
    userId: 'u1'
  }

  it('opens a row new in this release, scrubbed, with the crash header and source mapping', async () => {
    const { d, tracked } = deps()
    const r = await recordCrash({ ...input, message: 'bad "Jane Smith" nn.find' }, d)
    expect(r).toMatchObject({ issueId: 42, opened: true })
    expect(r.meta.new_in).toBe('0.3.158')
    const t = tracked[0]
    expect(t.message).toBe('TypeError: bad "…" nn.find')
    expect(t.route).toBe('/collections/:id/:id')
    expect(t.build).toBe('0.3.158')
    expect(String((t.detailsHeader as string[])[0])).toMatch(
      /^Crash: app=admin; release=0.3.158; kind=render; sig=\w+; family=\w+; new_in=0.3.158$/
    )
    expect(t.fingerprint).toHaveLength(64)
    expect(t.awaitOccurrence).toBe(true)
    expect(d.resolve).toHaveBeenCalledWith(42, expect.stringContaining('LinesGrid'))
    expect(d.alert).toHaveBeenCalledWith(42)
  })

  it('a family seen in an earlier release is not new', async () => {
    const { d } = deps({ familyReleases: async () => ['0.3.157'] })
    const r = await recordCrash(input, d)
    expect(r.meta).toMatchObject({ new_in: null, seen_in: '0.3.157' })
  })

  it('a repeat keeps the open row and its header; no source mapping again', async () => {
    const header = crashHeaderLines({
      app: 'admin',
      release: '0.3.158',
      kind: 'render',
      signature: 's',
      family: 'f',
      new_in: '0.3.158',
      seen_in: null,
      frame: null
    })
    const { d } = deps({
      findOpen: async () => ({ id: 42, details: `Route: /x\n${header.join('\n')}` }),
      familyReleases: vi.fn(async () => ['0.3.1'])
    })
    const r = await recordCrash(input, d)
    expect(r.opened).toBe(false)
    expect(r.meta.new_in).toBe('0.3.158')
    expect(d.familyReleases).not.toHaveBeenCalled()
    expect(d.resolve).not.toHaveBeenCalled()
  })

  it('the same crash on two releases is two rows (different fingerprints)', async () => {
    const { d, tracked } = deps()
    await recordCrash(input, d)
    await recordCrash({ ...input, release: '0.3.159' }, d)
    await recordCrash({ ...input, message: 'nn.find is not a function' }, d)
    expect(tracked[0].fingerprint).not.toBe(tracked[1].fingerprint)
    expect(tracked[0].fingerprint).toBe(tracked[2].fingerprint)
  })
})

describe('maybeAlertCrash', () => {
  const details = (extra = '') =>
    `${extra}Route: /collections/:id/:id\n${crashHeaderLines({
      app: 'admin',
      release: '0.3.158',
      kind: 'render',
      signature: 's',
      family: 'f',
      new_in: '0.3.158',
      seen_in: null,
      frame: null
    }).join('\n')}\n\nTypeError: x`
  function deps(over: Partial<AlertDeps> = {}) {
    const notes: Array<{ user: string; subject: string; message: string }> = []
    let claimed = false
    const d: AlertDeps = {
      loadIssue: async (id) => ({
        id,
        title: '[client] /collections/:id/:id: TypeError: nn.find is not a function',
        details: details(),
        recording_id: 'rec-1'
      }),
      recentHits: async () => ({ hits: 4, people: 2 }),
      newestRelease: async () => '0.3.158',
      claim: async () => {
        if (claimed) return false
        claimed = true
        return true
      },
      admins: async () => ['a1', 'a2'],
      notify: async (user, note) => void notes.push({ user, ...note }),
      log: async () => {},
      now: () => Date.parse('2026-11-13T20:00:00Z'),
      apiVersion: '0.3.158',
      ...over
    }
    return { d, notes }
  }

  it('tells every admin once, naming screen, error, version, people and the replay', async () => {
    const { d, notes } = deps()
    expect(await maybeAlertCrash(7, d)).toBe(true)
    expect(notes.map((n) => n.user)).toEqual(['a1', 'a2'])
    expect(notes[0].subject).toBe(
      'New crash in admin 0.3.158: TypeError: nn.find is not a function'
    )
    expect(notes[0].message).toContain('on /collections/:id/:id')
    expect(notes[0].message).toContain('4 times, 2 people in the last 15 minutes')
    expect(notes[0].message).toContain('replay')
    // A second hit (another replica) finds the claim taken.
    expect(await maybeAlertCrash(7, d)).toBe(false)
    expect(notes).toHaveLength(2)
  })

  it('stays quiet under the thresholds, once alerted, or for an old release', async () => {
    expect(
      await maybeAlertCrash(7, deps({ recentHits: async () => ({ hits: 2, people: 1 }) }).d)
    ).toBe(false)
    const alerted = deps({
      loadIssue: async (id) => ({
        id,
        title: '[client] /x: TypeError: y',
        details: details('Alerted: 2026-11-13T19:00:00.000Z\n'),
        recording_id: null
      })
    })
    expect(await maybeAlertCrash(7, alerted.d)).toBe(false)
    expect(await maybeAlertCrash(7, deps({ newestRelease: async () => '0.3.159' }).d)).toBe(false)
  })
})

describe('source maps', () => {
  it('decodes VLQ mappings and maps a minified frame back to source', async () => {
    // "AAAA,KAAKA;AACA" — line 1: col 0 → src 0:0:0; col 5 → src 0:0:5 named 0. Source
    // line and column carry over lines (only the generated column resets).
    expect(decodeMappings('AAAA,KAAKA;AACA').map((l) => l.map((s) => [...s]))).toEqual([
      [
        [0, 0, 0, 0, -1],
        [5, 0, 0, 5, 0]
      ],
      [[0, 0, 1, 5, -1]]
    ])
    const dir = mkdtempSync(join(tmpdir(), 'crash-map-'))
    writeFileSync(
      join(dir, 'LinesGrid-B3kF9a_x.js.map'),
      JSON.stringify({
        version: 3,
        sources: ['../../src/components/lines-grid.tsx'],
        names: ['openRow'],
        mappings: 'AAAA,KAAKA;AACA'
      })
    )
    const out = await resolveCrashFrames(
      crashFrames(
        'TypeError: x\n    at Kt (https://h/assets/LinesGrid-B3kF9a_x.js:1:7)\n    at y (https://h/assets/../../etc/passwd.js:1:1)'
      ),
      { dir }
    )
    expect(out).toContain('at openRow (src/components/lines-grid.tsx:1:6)')
    // A frame outside the assets folder is never looked up by its path.
    expect(out).toContain('at y (')
  })
})
