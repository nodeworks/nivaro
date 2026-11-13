import { gunzipSync, gzipSync } from 'node:zlib'
import { describe, expect, it, vi } from 'vitest'

/**
 * Packing a recording into its storage object (the hourly "move recordings to storage" job).
 * The pack used to inflate every chunk and gzip the whole object on the event loop: about a
 * second in one block per 15 MB recording. It now runs a chunk at a time on zlib's thread
 * pool. Objects already in storage were written the old way and new ones are read by the
 * same reader, so the new pack must write exactly what the old one did.
 */

vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))

import { packReplayChunks, replayObjectLines } from '../../../services/session-replay-storage.js'

// ── The pack as it was before (reference only) ──────────────────────────────

const HEADER = '#nivaro-replay v1'

function decodeChunkOld(stored: string): string {
  if (stored.startsWith('gz:')) {
    return gunzipSync(Buffer.from(stored.slice(3), 'base64')).toString('utf8')
  }
  return stored
}

function packReplayChunksOld(
  recordingId: string,
  chunks: Array<{ seq: number; events: string }>
): Buffer {
  const parts: Buffer[] = [Buffer.from(`${HEADER} ${recordingId}\n`, 'utf8')]
  for (const c of chunks) {
    let json: string
    try {
      json = decodeChunkOld(c.events)
    } catch {
      continue
    }
    if (json.includes('\n')) json = JSON.stringify(JSON.parse(json))
    parts.push(Buffer.from(`${Math.trunc(c.seq)}\t${json}\n`, 'utf8'))
  }
  return gzipSync(Buffer.concat(parts))
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

const gz = (json: string) => `gz:${gzipSync(Buffer.from(json)).toString('base64')}`

/** The chunks a reader gets back from a stored object (what rehydrate puts back). */
const unpack = (body: Buffer) =>
  [...replayObjectLines(gunzipSync(body))].map((l) => ({
    seq: l.seq,
    json: l.json.toString('utf8')
  }))

/** Every shape a stored chunk takes, the odd ones included. */
const mixedChunks = (): Array<{ seq: number; events: string }> => [
  { seq: 0, events: gz('[{"type":4,"data":{"href":"x\\ny"}}]') },
  { seq: 1, events: '[{"type":3,"timestamp":5}]' }, // plain, from before gzip storage
  { seq: 2, events: gz('[{"t":"naïve — 日本語 — 😀\\ttab"}]') },
  { seq: 3, events: 'gz:not-really-gzip' }, // unreadable: skipped
  { seq: 4, events: '[{"a":1},\n{"b":2}]' }, // a raw newline: re-stringified to one line
  { seq: 5.7, events: gz('[{"type":2}]') }, // seq truncated
  { seq: -1, events: gz('[]') },
  { seq: 9, events: '' }
]

/** A recording of `count` chunks of about `bytesEach` of rrweb-like JSON each, gzip-stored. */
function bigRecording(count: number, bytesEach: number): Array<{ seq: number; events: string }> {
  const out: Array<{ seq: number; events: string }> = []
  for (let seq = 0; seq < count; seq++) {
    const events: unknown[] = []
    let size = 2
    let i = 0
    while (size < bytesEach) {
      const e = {
        type: 3,
        timestamp: 1_760_000_000_000 + seq * 1000 + i,
        data: {
          source: i % 5,
          id: (seq * 7919 + i * 104729) % 100_000,
          text: `node ${i} ${Math.sin(seq * 31 + i).toString(36)}`,
          attributes: { class: `c-${(i * 2654435761) % 9973}`, style: 'width: 12px' }
        }
      }
      size += JSON.stringify(e).length + 1
      events.push(e)
      i++
    }
    out.push({ seq, events: gz(JSON.stringify(events)) })
  }
  return out
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('packing a recording for storage', () => {
  it('writes the same object, byte for byte, as the old pack', async () => {
    const chunks = mixedChunks()
    const fresh = await packReplayChunks('R1', chunks)
    const old = packReplayChunksOld('R1', chunks)
    expect(fresh.equals(old)).toBe(true)
  })

  it('reads back, through the existing reader, to the same chunks either way', async () => {
    const chunks = mixedChunks()
    const fresh = unpack(await packReplayChunks('R1', chunks))
    expect(fresh).toEqual(unpack(packReplayChunksOld('R1', chunks)))
    expect(fresh).toEqual([
      { seq: 0, json: '[{"type":4,"data":{"href":"x\\ny"}}]' },
      { seq: 1, json: '[{"type":3,"timestamp":5}]' },
      { seq: 2, json: '[{"t":"naïve — 日本語 — 😀\\ttab"}]' },
      { seq: 4, json: '[{"a":1},{"b":2}]' },
      { seq: 5, json: '[{"type":2}]' },
      { seq: -1, json: '[]' },
      { seq: 9, json: '' }
    ])
  })

  it('matches the old pack on a large recording too', async () => {
    const chunks = bigRecording(40, 64 * 1024)
    const fresh = await packReplayChunks('R-big', chunks)
    expect(fresh.equals(packReplayChunksOld('R-big', chunks))).toBe(true)
    const lines = unpack(fresh)
    expect(lines).toHaveLength(40)
    expect(lines[39].json).toBe(
      gunzipSync(Buffer.from(chunks[39].events.slice(3), 'base64')).toString()
    )
  })

  it('writes just the header for a recording whose chunks are all unreadable', async () => {
    const chunks = [{ seq: 0, events: 'gz:broken' }]
    const fresh = await packReplayChunks('R1', chunks)
    expect(fresh.equals(packReplayChunksOld('R1', chunks))).toBe(true)
    expect(unpack(fresh)).toEqual([])
  })

  it('fails the same way the old pack did on a chunk that is not JSON and holds a newline', async () => {
    const chunks = [{ seq: 0, events: 'not json\nat all' }]
    expect(() => packReplayChunksOld('R1', chunks)).toThrow()
    await expect(packReplayChunks('R1', chunks)).rejects.toThrow()
  })

  it('lets the event loop run between chunks', async () => {
    const chunks = bigRecording(30, 16 * 1024)
    let turns = 0
    let running = true
    const spin = () => {
      if (!running) return
      turns++
      setImmediate(spin)
    }
    setImmediate(spin)
    const before = turns
    const packing = packReplayChunks('R1', chunks)
    const afterCall = turns
    await packing
    running = false
    // The call itself returns at once; the work runs while other callbacks keep getting turns.
    expect(afterCall).toBe(before)
    expect(turns - before).toBeGreaterThanOrEqual(chunks.length)
  })
})
