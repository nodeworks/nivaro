import { mkdirSync, mkdtempSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// The db module is never reached: every store/alert step is injected.
vi.mock('../../../db/index.js', () => ({ db: {} }))
vi.mock('../../../services/io-holder.js', () => ({ getApp: () => null }))
vi.mock('../../../services/activity.js', () => ({ logActivity: vi.fn() }))

import {
  alertQuote,
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
import {
  decodeMappings,
  mapFileFor,
  resetSourceMapCache,
  resolveCrashFrames,
  sourceMapCacheStats
} from '../../../services/crash-sourcemap.js'
import {
  type AlertDeps,
  type CrashDeps,
  maybeAlertCrash,
  recordCrash,
  releasesOfFamily
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

  it('the admin counts only the server’s own version; another app only the roster’s build', () => {
    const ctx = { apiVersion: '0.3.158', rosterBuild: null }
    expect(isCurrentRelease('admin', '0.3.158', ctx)).toBe(true)
    expect(isCurrentRelease('admin', '0.3.157', ctx)).toBe(false)
    // A report naming a release the server is not on — newer, made up — never counts.
    expect(isCurrentRelease('admin', '0.3.159', ctx)).toBe(false)
    expect(isCurrentRelease('admin', '9.9.9', ctx)).toBe(false)
    expect(isCurrentRelease('admin', '0.3.158', { apiVersion: 'dev', rosterBuild: null })).toBe(
      false
    )
    const roster = { apiVersion: '0.3.158', rosterBuild: '0.3.112' }
    expect(isCurrentRelease('efp-new', '0.3.112', roster)).toBe(true)
    expect(isCurrentRelease('efp-new', '0.3.113', roster)).toBe(false)
    expect(isCurrentRelease('efp-new', '0.3.10', roster)).toBe(false)
    // No roster for the app: the two-people rule is the proof (shouldAlertCrash).
    expect(isCurrentRelease('efp-new', '0.3.112', ctx)).toBe(true)
    expect(isCurrentRelease('efp-new', 'dev', ctx)).toBe(false)
  })

  it('alerts on hits AND two people, never twice, never for dev or an old crash', () => {
    const base = {
      meta: { release: '0.3.158', new_in: '0.3.158', alerted_at: null },
      current: true,
      hits: 1,
      people: 1,
      minHits: 3,
      minPeople: 2
    }
    expect(shouldAlertCrash(base)).toBe(false)
    // One person alone never alerts, however often.
    expect(shouldAlertCrash({ ...base, hits: 500 })).toBe(false)
    expect(shouldAlertCrash({ ...base, hits: 500, minPeople: 1 })).toBe(false)
    expect(shouldAlertCrash({ ...base, people: 2 })).toBe(false)
    expect(shouldAlertCrash({ ...base, hits: 3, people: 2 })).toBe(true)
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
      apiVersion: '0.3.158',
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

  it('maps source only for the admin build this server carries', async () => {
    const other = deps()
    await recordCrash({ ...input, release: '0.3.157' }, other.d)
    expect(other.d.resolve).not.toHaveBeenCalled()
    const efp = deps()
    await recordCrash({ ...input, app: 'efp-new' }, efp.d)
    expect(efp.d.resolve).not.toHaveBeenCalled()
    const dev = deps({ apiVersion: 'dev' })
    await recordCrash({ ...input, release: 'dev' }, dev.d)
    expect(dev.d.resolve).not.toHaveBeenCalled()
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
      rosterBuild: async () => null,
      alertsSince: async () => 0,
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
    expect(notes[0].subject).toBe('App crash on /collections/:id/:id in 0.3.158')
    expect(notes[0].message).toContain('Error: "TypeError: nn.find is not a function"')
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
    // The server moved on: an admin crash of another release never alerts.
    expect(await maybeAlertCrash(7, deps({ apiVersion: '0.3.159' }).d)).toBe(false)
  })

  it('one person alone never alerts, however many times they report', async () => {
    const one = deps({ recentHits: async () => ({ hits: 200, people: 1 }) })
    expect(await maybeAlertCrash(7, one.d)).toBe(false)
    expect(one.notes).toHaveLength(0)
  })

  it('another app alerts only on the build the live roster names', async () => {
    const efp = (release: string, roster: string | null) =>
      deps({
        loadIssue: async (id) => ({
          id,
          title: '[client] /queues/:id: TypeError: y',
          details: `Route: /queues/:id\n${crashHeaderLines({
            app: 'efp-new',
            release,
            kind: 'error',
            signature: 's',
            family: 'f',
            new_in: release,
            seen_in: null,
            frame: null
          }).join('\n')}`,
          recording_id: null
        }),
        rosterBuild: async () => roster
      })
    expect(await maybeAlertCrash(7, efp('0.3.999', '0.3.112').d)).toBe(false)
    expect(await maybeAlertCrash(7, efp('0.3.112', '0.3.112').d)).toBe(true)
  })

  it('at most CRASH_ALERT_MAX_PER_HOUR crash alerts an hour; the issue stays unclaimed', async () => {
    const claim = vi.fn(async () => true)
    const full = deps({ alertsSince: async () => 3, claim })
    expect(await maybeAlertCrash(7, full.d)).toBe(false)
    expect(claim).not.toHaveBeenCalled()
    expect(full.notes).toHaveLength(0)
  })

  it('never puts the reporter’s free text in the subject; the message quotes it scrubbed', async () => {
    const evil = `${'Click https://evil.example/login?token=abc123 now '.repeat(5)}\nSecond line password=hunter2`
    const { d, notes } = deps({
      loadIssue: async (id) => ({
        id,
        title: `[client] /collections/:id/:id: TypeError: ${evil}`,
        details: details(),
        recording_id: null
      })
    })
    expect(await maybeAlertCrash(7, d)).toBe(true)
    expect(notes[0].subject).toBe('App crash on /collections/:id/:id in 0.3.158')
    const quoted = /Error: "([^"]*)"/.exec(notes[0].message)?.[1] ?? ''
    expect(quoted.length).toBeLessThanOrEqual(120)
    expect(notes[0].message).not.toMatch(/token=abc123|hunter2|\n/)
    expect(alertQuote('a "quoted"   line')).toBe('a quoted line')
  })
})

describe('family lookups trust only the anchored header', () => {
  const header = (family: string, release: string) =>
    crashHeaderLines({
      app: 'admin',
      release,
      kind: 'error',
      signature: 's',
      family,
      new_in: release,
      seen_in: null,
      frame: null
    }).join('\n')

  it('a message or stack that says "family=…" is never read as the header', () => {
    const real = 'abcdef0123456789abcd'
    const rows = [
      // The real row for this family.
      { details: `Route: /x\n${header(real, '0.3.158')}\n\nTypeError: y` },
      // Another family whose MESSAGE carries the target family (the LIKE matches it).
      {
        details: `Route: /x\n${header('1111111111aaaaaaaaaa', '0.3.150')}\n\nTypeError: family=${real}; release=0.3.1`
      },
      // A row filed before crash grouping whose stack fakes a whole header line.
      {
        details: `Route: /x\n\nTypeError: y\nCrash: app=admin; release=0.3.2; family=${real}; new_in=0.3.2`
      },
      // A fake Alerted/Crash pair below the top.
      { details: `Route: /x\n\nAlerted: now\nRoute: /y\nCrash: family=${real}; release=0.3.3` }
    ]
    expect(releasesOfFamily(rows, real)).toEqual(['0.3.158'])
    expect(parseCrashMeta(rows[2].details)).toBeNull()
    expect(parseCrashMeta(rows[3].details)).toBeNull()
    expect(parseCrashMeta(rows[1].details)?.family).toBe('1111111111aaaaaaaaaa')
  })

  it('a reported message containing a fake family= cannot change the crash’s own family', async () => {
    const tracked: Array<Record<string, unknown>> = []
    const familyReleases = vi.fn(async () => [] as string[])
    await recordCrash(
      {
        app: 'admin',
        release: '0.3.158',
        kind: 'error',
        screen: '/x',
        message: 'boom family=abcdef0123456789abcd; release=0.3.1',
        stack: 'TypeError: boom\n    at f (https://h/assets/a.js:1:1)'
      },
      {
        findOpen: async () => null,
        familyReleases,
        track: (async (o: Record<string, unknown>) => {
          tracked.push(o)
          return 1
        }) as unknown as CrashDeps['track'],
        resolve: async () => {},
        alert: async () => false,
        apiVersion: '0.3.158'
      }
    )
    const head = String((tracked[0].detailsHeader as string[])[0])
    const fam = /family=(\w+)/.exec(head)?.[1]
    expect(fam).not.toBe('abcdef0123456789abcd')
    expect(familyReleases).toHaveBeenCalledWith(fam)
    expect(head).toMatch(/release=0\.3\.158;/)
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

describe('source maps are bounded', () => {
  const MAP = JSON.stringify({ version: 3, sources: ['src/a.ts'], names: [], mappings: 'AAAA' })
  beforeEach(() => resetSourceMapCache())

  it('looks only at plain files directly inside the maps folder, by base name', async () => {
    const root = mkdtempSync(join(tmpdir(), 'crash-map-root-'))
    const dir = join(root, 'assets')
    mkdirSync(dir)
    writeFileSync(join(dir, 'ok-Ab12Cd34.js.map'), MAP)
    writeFileSync(join(root, 'secret.js.map'), MAP)
    symlinkSync(join(root, 'secret.js.map'), join(dir, 'link-Ab12Cd34.js.map'))
    expect(await mapFileFor('ok-Ab12Cd34.js', dir)).not.toBeNull()
    expect(await mapFileFor('../secret.js', dir)).toBeNull()
    expect(await mapFileFor('..', dir)).toBeNull()
    expect(await mapFileFor('.hidden.js', dir)).toBeNull()
    // A symlink inside the folder pointing out of it is not followed.
    expect(await mapFileFor('link-Ab12Cd34.js', dir)).toBeNull()
  })

  it('skips a map over 30 MB without reading it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'crash-map-big-'))
    const file = join(dir, 'big-Ab12Cd34.js.map')
    writeFileSync(file, '')
    truncateSync(file, 31 * 1024 * 1024) // sparse: the size is what lstat sees
    expect(await mapFileFor('big-Ab12Cd34.js', dir)).toBeNull()
    expect(
      await resolveCrashFrames(
        crashFrames('E: x\n    at f (https://h/assets/big-Ab12Cd34.js:1:1)'),
        {
          dir
        }
      )
    ).toBeNull()
  })

  it('maps at most 6 different bundles per report and keeps at most 12 maps', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'crash-map-many-'))
    const names = Array.from({ length: 20 }, (_, i) => `b${i}-Ab12Cd3${i % 10}.js`)
    for (const n of names) writeFileSync(join(dir, `${n}.map`), MAP)
    const stack = (from: number) =>
      [
        'E: x',
        ...names.slice(from, from + 10).map((n) => `    at f (https://h/assets/${n}:1:1)`)
      ].join('\n')
    const out = await resolveCrashFrames(crashFrames(stack(0)), { dir })
    expect(out?.split('\n').filter((l) => l.includes('src/a.ts'))).toHaveLength(6)
    expect(sourceMapCacheStats().entries).toBe(6)
    await resolveCrashFrames(crashFrames(stack(6)), { dir })
    await resolveCrashFrames(crashFrames(stack(12)), { dir })
    expect(sourceMapCacheStats().entries).toBeLessThanOrEqual(12)
  })
})
