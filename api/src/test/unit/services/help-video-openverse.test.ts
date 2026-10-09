import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../lib/ssrf.js', () => ({
  assertSafeUrl: vi.fn(async (u: string) => {
    if (/internal|127\.0\.0\.1/.test(u)) throw new Error('blocked')
    return new URL(u)
  })
}))

import {
  downloadTrack,
  normalizeOrigin,
  openverseTrack,
  originOf,
  previewBytes,
  searchOpenverse,
  toTrack
} from '../../../services/help-video-openverse.js'

const ID = '0f2b7f35-9a65-4c1d-8f0a-2b6c4e1d9a10'
const item = (over: Record<string, unknown> = {}) => ({
  id: ID,
  title: 'Soft Piano Loop.wav',
  creator: 'someone',
  license: 'cc0',
  license_url: 'https://creativecommons.org/publicdomain/zero/1.0/',
  url: 'https://cdn.example.org/a.mp3',
  duration: 31_000,
  source: 'freesound',
  foreign_landing_url: 'https://freesound.org/s/1/',
  mature: false,
  ...over
})

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

describe('toTrack', () => {
  it('keeps CC0 / public domain and drops everything else', () => {
    expect(toTrack(item())?.title).toBe('Soft Piano Loop')
    expect(toTrack(item({ license: 'pdm' }))?.license).toBe('pdm')
    expect(toTrack(item({ license: 'by' }))).toBeNull()
    expect(toTrack(item({ license: 'by-nc' }))).toBeNull()
    expect(toTrack(item({ mature: true }))).toBeNull()
    expect(toTrack(item({ duration: 21 * 60_000 }))).toBeNull()
    expect(toTrack(item({ url: 'ftp://x/a.mp3' }))).toBeNull()
    expect(toTrack(item({ id: 'not-a-uuid' }))).toBeNull()
  })
})

describe('normalizeOrigin', () => {
  it('keeps the known shape only', () => {
    const t = toTrack(item())!
    expect(normalizeOrigin(originOf(t))).toEqual({
      provider: 'openverse',
      id: ID,
      creator: 'someone',
      license: 'cc0',
      license_url: 'https://creativecommons.org/publicdomain/zero/1.0/',
      landing_url: 'https://freesound.org/s/1/',
      source: 'freesound'
    })
    expect(normalizeOrigin({ ...originOf(t), license: 'by' })).toBeNull()
    expect(normalizeOrigin({ ...originOf(t), provider: 'elsewhere' })).toBeNull()
    expect(
      normalizeOrigin({ ...originOf(t), landing_url: 'javascript:alert(1)' })?.landing_url
    ).toBeNull()
  })
})

describe('Openverse calls', () => {
  const fetchMock = vi.fn()
  beforeEach(() => {
    fetchMock.mockReset()
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => vi.unstubAllGlobals())

  it('asks for CC0 / public domain and filters what comes back', async () => {
    fetchMock.mockResolvedValueOnce(
      json({
        results: [item(), item({ id: '1f2b7f35-9a65-4c1d-8f0a-2b6c4e1d9a10', license: 'by' })],
        page_count: 3,
        result_count: 50
      })
    )
    const r = await searchOpenverse('  calm   piano ')
    const url = new URL(String(fetchMock.mock.calls[0][0]))
    expect(url.searchParams.get('license')).toBe('cc0,pdm')
    expect(url.searchParams.get('q')).toBe('calm piano')
    expect(r.results.map((t) => t.id)).toEqual([ID])
    expect('audio_url' in r.results[0]).toBe(false)
    expect(r.page_count).toBe(3)
  })

  it('refuses an item that is no longer CC0', async () => {
    fetchMock.mockResolvedValueOnce(
      json(item({ id: '2f2b7f35-9a65-4c1d-8f0a-2b6c4e1d9a10', license: 'by' }))
    )
    await expect(openverseTrack('2f2b7f35-9a65-4c1d-8f0a-2b6c4e1d9a10')).rejects.toMatchObject({
      statusCode: 422,
      code: 'OPENVERSE_LICENSE'
    })
  })

  it('names a rate limit plainly', async () => {
    fetchMock.mockResolvedValueOnce(new Response('', { status: 429 }))
    await expect(searchOpenverse('busy words')).rejects.toMatchObject({ code: 'OPENVERSE_BUSY' })
  })

  describe('downloads', () => {
    let dir = ''
    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), 'ov-'))
    })
    afterEach(() => rm(dir, { recursive: true, force: true }))

    it('follows a public redirect and writes the audio', async () => {
      fetchMock
        .mockResolvedValueOnce(
          new Response(null, { status: 302, headers: { location: 'https://cdn2.example.org/b' } })
        )
        .mockResolvedValueOnce(new Response(Buffer.from('ID3 audio')))
      const p = join(dir, 'a')
      await downloadTrack({ audio_url: 'https://cdn.example.org/a.mp3' }, p, 1024)
      expect((await readFile(p)).toString()).toBe('ID3 audio')
      expect(fetchMock.mock.calls[0][1]).toMatchObject({ redirect: 'manual' })
    })

    it('refuses a redirect to a private host', async () => {
      fetchMock.mockResolvedValueOnce(
        new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/x' } })
      )
      await expect(
        downloadTrack({ audio_url: 'https://cdn.example.org/a.mp3' }, join(dir, 'b'), 1024)
      ).rejects.toMatchObject({ code: 'OPENVERSE_UNREACHABLE' })
      expect(fetchMock).toHaveBeenCalledTimes(1)
    })

    it('a preview asks for the opening only, cuts it at 512 KB and keeps it', async () => {
      fetchMock.mockResolvedValueOnce(
        new Response(Buffer.alloc(700 * 1024, 1), { headers: { 'content-type': 'audio/mpeg' } })
      )
      const t = { id: ID, audio_url: 'https://cdn.example.org/a.mp3' }
      const p = await previewBytes(t)
      expect(p.type).toBe('audio/mpeg')
      expect(p.bytes.length).toBe(512 * 1024)
      expect((fetchMock.mock.calls[0][1] as RequestInit).headers).toMatchObject({
        Range: 'bytes=0-524287'
      })
      await previewBytes(t)
      expect(fetchMock).toHaveBeenCalledTimes(1)
    })

    it('a source that fails mid-preview keeps what arrived, never crashes', async () => {
      const body = new ReadableStream({
        start(c) {
          c.enqueue(new Uint8Array([1, 2, 3]))
          setTimeout(() => c.error(new Error('cdn dropped')), 5)
        }
      })
      fetchMock.mockResolvedValueOnce(
        new Response(body, { headers: { 'content-type': 'audio/ogg' } })
      )
      const p = await previewBytes({
        id: '3f2b7f35-9a65-4c1d-8f0a-2b6c4e1d9a10',
        audio_url: 'https://cdn.example.org/b.ogg'
      })
      expect([...p.bytes]).toEqual([1, 2, 3])
    })

    it('stops at the size cap', async () => {
      fetchMock.mockResolvedValueOnce(new Response(Buffer.alloc(4096)))
      await expect(
        downloadTrack({ audio_url: 'https://cdn.example.org/a.mp3' }, join(dir, 'c'), 1024)
      ).rejects.toMatchObject({ code: 'MUSIC_TOO_LARGE' })
    })
  })
})
