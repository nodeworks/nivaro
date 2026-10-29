import { describe, expect, it, vi } from 'vitest'

// #16 — evidence export bundle: three files, a manifest with each file's sha256, spreadsheet-safe
// CSV, and a hard cap on the window size.

const state = vi.hoisted(() => ({ count: 2 }))

vi.mock('../../../../db/index.js', async () => {
  const { makeFakeDb } = await import('../../../fake-sql.js')
  return {
    db: makeFakeDb((q) => {
      if (q.sql.includes('count(*)')) return { n: state.count }
      if (q.method === 'select')
        return [
          {
            id: 1,
            timestamp: new Date('2026-10-01T00:00:00Z'),
            action: 'update',
            comment: '=HYPERLINK("x")'
          },
          { id: 2, timestamp: new Date('2026-10-01T00:00:01Z'), action: 'delete', comment: 'a,b' }
        ]
      return []
    })
  }
})
vi.mock('../../../../lib/column-probe.js', () => ({ hasColumn: vi.fn(async () => true) }))
vi.mock('../../../../services/activity-trail/store.js', async (importOriginal) => {
  const orig = (await importOriginal()) as Record<string, unknown>
  return { ...orig, trailReady: vi.fn(async () => false) }
})

import { createHash } from 'node:crypto'
import {
  buildEvidence,
  csvCell,
  EvidenceTooLargeError
} from '../../../../services/activity-trail/evidence.js'

/** Read a stored (uncompressed) zip's entries. */
function unzip(buf: Buffer): Map<string, Buffer> {
  const out = new Map<string, Buffer>()
  let off = 0
  while (buf.readUInt32LE(off) === 0x04034b50) {
    const size = buf.readUInt32LE(off + 18)
    const nameLen = buf.readUInt16LE(off + 26)
    const name = buf.subarray(off + 30, off + 30 + nameLen).toString()
    out.set(name, buf.subarray(off + 30 + nameLen, off + 30 + nameLen + size))
    off += 30 + nameLen + size
  }
  return out
}

const opts = {
  from: new Date('2026-10-01T00:00:00Z'),
  to: new Date('2026-10-01T23:59:59Z'),
  generatedBy: { id: 'u1', name: 'Pat Admin' }
}

describe('evidence export', () => {
  it('bundles entries.csv, manifest.json and summary.html with matching hashes', async () => {
    state.count = 2
    const out = await buildEvidence(opts)
    const files = unzip(out.zip)
    expect([...files.keys()]).toEqual(['manifest.json', 'entries.csv', 'summary.html'])
    const manifest = JSON.parse(files.get('manifest.json')!.toString())
    const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex')
    expect(manifest.files['entries.csv']).toBe(sha(files.get('entries.csv')!))
    expect(manifest.files['summary.html']).toBe(sha(files.get('summary.html')!))
    expect(out.manifestSha256).toBe(sha(files.get('manifest.json')!))
    expect(manifest.verification.status).toBe('not_sealed')
    expect(manifest.rows).toMatchObject({ in_window: 2, unsealed: 2 })
    const csv = files.get('entries.csv')!.toString()
    expect(csv.split('\r\n')[0]).toMatch(/^id,timestamp,action,/)
    expect(csv).toContain(`"'=HYPERLINK(""x"")"`)
    expect(csv).toContain('"a,b"')
  })

  it('refuses a window over the cap', async () => {
    state.count = 100_001
    await expect(buildEvidence(opts)).rejects.toBeInstanceOf(EvidenceTooLargeError)
  })

  it('csvCell neutralises formulas and quotes separators', () => {
    expect(csvCell('+1')).toBe("'+1")
    expect(csvCell('@x')).toBe("'@x")
    expect(csvCell('{"id":1}')).toBe('"{""id"":1}"')
    expect(csvCell(null)).toBe('')
  })
})
