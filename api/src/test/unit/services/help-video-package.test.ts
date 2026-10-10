import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))

import { hashEdits, normalizeEdits } from '../../../services/help-video-edits.js'
import { decideImportPart, exportIds } from '../../../services/help-video-package.js'
import {
  checkManifest,
  matchContexts,
  PackageError,
  sanitizeClicks
} from '../../../services/help-video-package-manifest.js'
import {
  listTar,
  readTarEntry,
  TAR_END,
  tarHeader,
  tarPadding
} from '../../../services/help-video-tar.js'

const ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const SHA = 'a'.repeat(64)
const EDITS = {
  v: 1,
  segments: [{ start_ms: 0, end_ms: 20000, speed: 1 }],
  poster_ms: 0,
  chapters: [{ id: 'c1', at_ms: 0, title: 'Start' }],
  annotations: [],
  zooms: [],
  blurs: [],
  captions: []
}
const HASH = hashEdits(normalizeEdits(EDITS, 20000))

function manifest(over: Record<string, unknown> = {}, ver: Record<string, unknown> = {}) {
  return {
    type: 'nivaro-help-video-package',
    version: 1,
    exported_at: '2026-10-09T00:00:00.000Z',
    source: { instance: 'staging', url: 'https://staging.example' },
    pages: [{ key: 'my-work', label: 'My Work', app: 'efp-new' }],
    videos: [
      {
        id: ID,
        title: 'Approve a workflow',
        description: 'How',
        category: 'Workflows',
        allow_downloads: false,
        contexts: [
          { kind: 'collection', key: 'workflows', state_key: 'started' },
          { kind: 'page', key: 'my-work', state_key: null }
        ],
        version: {
          number: 3,
          edits: EDITS,
          edits_hash: HASH,
          rendered_hash: HASH,
          source_duration_ms: 20000,
          width: 1280,
          height: 720,
          clicks: [{ t_ms: 100, x: 0.5, y: 0.5 }],
          levels: [0.1, 2, 'x'],
          note: null,
          files: {
            source: { entry: 'f1', mime: 'video/webm', size: 1000, sha256: SHA },
            rendered: { entry: 'f2', mime: 'video/mp4', size: 900, sha256: SHA },
            poster: { entry: 'f3', mime: 'image/jpeg', size: 50, sha256: SHA }
          },
          ...ver
        },
        ...over
      }
    ]
  }
}
const entries = () =>
  new Map([
    ['f1', 1000],
    ['f2', 900],
    ['f3', 50]
  ])

describe('checkManifest', () => {
  it('accepts a good package and recomputes the edits hash', () => {
    const c = checkManifest(manifest(), entries())
    expect(c.rejected).toEqual([])
    expect(c.videos).toHaveLength(1)
    const v = c.videos[0]
    expect(v.id).toBe(ID)
    expect(v.edits_hash).toBe(HASH)
    expect(v.render_reusable).toBe(true)
    expect(v.allow_downloads).toBe(false)
    expect(v.levels).toEqual([0.1, 1, 0])
    expect(v.files.rendered?.entry).toBe('f2')
    expect(c.pages).toEqual([{ key: 'my-work', label: 'My Work', app: 'efp-new' }])
  })

  it('carries the script (#1491) when the package has one, cleaned', () => {
    expect(checkManifest(manifest(), entries()).videos[0].script).toBeNull()
    const c = checkManifest(manifest({}, { script: ['  Open ', '', 'Approve', 7] }), entries())
    expect(c.videos[0].script).toEqual(['Open', 'Approve'])
  })
  it('renders again when the render was not built for these edits', () => {
    const c = checkManifest(manifest({}, { rendered_hash: 'stale' }), entries())
    expect(c.videos[0].render_reusable).toBe(false)
    expect(c.videos[0].files.rendered).toBeUndefined()
    const lied = checkManifest(manifest({}, { edits_hash: 'x', rendered_hash: 'x' }), entries())
    expect(lied.videos[0].render_reusable).toBe(false)
  })

  it('refuses what is not a package', () => {
    expect(() => checkManifest({ type: 'x' }, entries())).toThrow(PackageError)
    expect(() => checkManifest({ ...manifest(), version: 9 }, entries())).toThrow(/newer/)
    expect(() => checkManifest({ ...manifest(), videos: [] }, entries())).toThrow(/no videos/)
  })

  it('never trusts entry names, sizes or types from the package', () => {
    const bad = (files: Record<string, unknown>) =>
      checkManifest(manifest({}, { files }), entries()).rejected[0]?.reasons.join(' | ')
    expect(
      bad({ source: { entry: '../../etc/passwd', mime: 'video/webm', size: 1000, sha256: SHA } })
    ).toMatch(/unexpected name/)
    expect(bad({ source: { entry: 'f9', mime: 'video/webm', size: 1000, sha256: SHA } })).toMatch(
      /missing from the package/
    )
    expect(bad({ source: { entry: 'f1', mime: 'video/webm', size: 999, sha256: SHA } })).toMatch(
      /size does not match/
    )
    expect(bad({ source: { entry: 'f1', mime: 'text/html', size: 1000, sha256: SHA } })).toMatch(
      /not an allowed type/
    )
    expect(bad({ source: { entry: 'f1', mime: 'video/webm', size: 1000, sha256: 'x' } })).toMatch(
      /no checksum/
    )
    expect(bad({})).toMatch(/original recording is missing/)
  })

  it('rejects bad ids and duplicates per video', () => {
    const m = manifest({ id: `${ID}/../x` })
    expect(checkManifest(m, entries()).rejected[0].reasons[0]).toMatch(/id/)
    const twice = manifest()
    twice.videos.push({ ...twice.videos[0] })
    const c = checkManifest(twice, entries())
    expect(c.videos).toHaveLength(1)
    expect(c.rejected[0].reasons[0]).toMatch(/twice/)
  })

  it('drops unreadable screens and keeps the rest', () => {
    const c = checkManifest(
      manifest({
        contexts: [
          { kind: 'collection', key: 'workflows; drop table', state_key: null },
          { kind: 'page', key: 'my-work' }
        ]
      }),
      entries()
    )
    expect(c.videos[0].contexts).toEqual([{ kind: 'page', key: 'my-work', state_key: null }])
  })
})

describe('matchContexts', () => {
  const here = {
    collections: new Set(['workflows']),
    states: new Map([['workflows', new Set(['started'])]])
  }
  it('keeps contexts that exist here and says why the rest are skipped', () => {
    const r = matchContexts(
      [
        { kind: 'collection', key: 'workflows', state_key: 'started' },
        { kind: 'collection', key: 'workflows', state_key: 'gone' },
        { kind: 'collection', key: 'nope', state_key: null },
        { kind: 'page', key: 'anything', state_key: null }
      ],
      here
    )
    expect(r.matched.map((c) => `${c.key}:${c.state_key}`)).toEqual([
      'workflows:started',
      'anything:null'
    ])
    expect(r.skipped.map((s) => s.reason)).toEqual([
      'workflows has no step called gone here',
      'There is no collection named nope here'
    ])
  })
})

describe('import parts and export ids', () => {
  it('takes parts in order, accepts a resend, refuses past the cap', () => {
    const s = { next_part: 2, last_part_bytes: 10, bytes: 20 }
    expect(decideImportPart(s, 2, 10, 100)).toBe('append')
    expect(decideImportPart(s, 1, 10, 100)).toBe('duplicate')
    expect(decideImportPart(s, 1, 9, 100)).toMatchObject({ status: 409 })
    expect(decideImportPart(s, 3, 10, 100)).toMatchObject({ status: 409 })
    expect(decideImportPart(s, 2, 90, 100)).toMatchObject({ status: 413 })
  })
  it('cleans the picked ids', () => {
    expect(exportIds([ID, ID.toUpperCase(), 'nope'])).toEqual([ID])
    expect(() => exportIds([])).toThrow(/at least one/)
  })
  it('caps clicks to the recording', () => {
    expect(
      sanitizeClicks(
        [
          { t_ms: 5, x: 0.2, y: 0.3 },
          { t_ms: 99999, x: 0.2, y: 0.3 },
          { t_ms: 5, x: 2, y: 0 }
        ],
        1000
      )
    ).toEqual([{ t_ms: 5, x: 0.2, y: 0.3 }])
  })
})

describe('tar', () => {
  it('reads back what it writes, by header only', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hv-tar-'))
    const path = join(dir, 'p.tar')
    const a = Buffer.from('hello world')
    const b = Buffer.from('{"x":1}')
    writeFileSync(
      path,
      Buffer.concat([
        tarHeader('f1', a.length, 0),
        a,
        tarPadding(a.length),
        tarHeader('manifest.json', b.length, 0),
        b,
        tarPadding(b.length),
        TAR_END
      ])
    )
    const list = await listTar(path)
    expect(list.map((e) => [e.name, e.size])).toEqual([
      ['f1', 11],
      ['manifest.json', 7]
    ])
    expect((await readTarEntry(path, list[1], 100)).toString()).toBe('{"x":1}')
    await expect(readTarEntry(path, list[0], 5)).rejects.toThrow(/too large/)
  })
  it('refuses a damaged or cut archive and bad names', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hv-tar-'))
    const h = tarHeader('f1', 600, 0)
    h[0] = 0x67 // name changed after the checksum
    writeFileSync(join(dir, 'bad.tar'), Buffer.concat([h, Buffer.alloc(1024)]))
    await expect(listTar(join(dir, 'bad.tar'))).rejects.toThrow(/damaged/)
    writeFileSync(
      join(dir, 'cut.tar'),
      Buffer.concat([tarHeader('f1', 4096, 0), Buffer.alloc(100)])
    )
    await expect(listTar(join(dir, 'cut.tar'))).rejects.toThrow(/incomplete/)
    expect(() => tarHeader('../x', 1, 0)).toThrow(/name/)
  })
})
