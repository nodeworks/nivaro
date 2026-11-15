import { createHash } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../db/index.js', () => ({ db: () => ({}) }))
// No Redis in tests: the per-process copy carries the status.
vi.mock('./io-holder.js', () => ({ getApp: () => null }))

import {
  CHIP_THUMB,
  extractCacheKey,
  type ProcessDeps,
  processFile,
  processingPlan,
  readProcessingStates,
  resetFileProcessingForTests,
  transformCacheKey
} from './file-processing.js'

const FILE = 'E3B0C442-98FC-1C14-9AFB-F4C8996FB924'

function deps(over: Partial<ProcessDeps> = {}) {
  const puts: string[] = []
  const announced: string[] = []
  const d: ProcessDeps = {
    read: async () => Buffer.from('bytes'),
    put: async (key) => {
      puts.push(key)
    },
    thumbnail: async () => Buffer.from('thumb'),
    extract: async () => ({ text: 'hello', truncated: false, pages: 1 }),
    announce: async (id) => {
      announced.push(id)
    },
    ...over
  }
  return { d, puts, announced }
}

describe('processingPlan', () => {
  it('images get a thumbnail, documents get their text read, others nothing', () => {
    expect(processingPlan({ type: 'image/png', filename_download: 'a.png' })).toEqual(['thumbnail'])
    expect(processingPlan({ type: 'application/pdf', filename_download: 'q.pdf' })).toEqual([
      'text'
    ])
    expect(
      processingPlan({ type: 'application/octet-stream', filename_download: 'sheet.xlsx' })
    ).toEqual(['text'])
    expect(processingPlan({ type: 'image/svg+xml', filename_download: 'logo.svg' })).toEqual([])
    expect(processingPlan({ type: 'application/zip', filename_download: 'x.zip' })).toEqual([])
  })
})

describe('transformCacheKey', () => {
  it('is the key the transform route always used (so the route serves the processed thumbnail)', () => {
    const hash = createHash('sha1')
      .update('w=160&h=160&fit=cover&format=webp&q=80')
      .digest('hex')
      .slice(0, 16)
    expect(transformCacheKey(FILE, CHIP_THUMB)).toBe(
      `transforms/${FILE.toLowerCase()}/${hash}.webp`
    )
    expect(extractCacheKey(FILE)).toBe(`transforms/${FILE.toLowerCase()}/text.json`)
  })
})

describe('processFile — status transitions', () => {
  beforeEach(() => resetFileProcessingForTests())

  it('processing while it works, ready after, then the record viewers are told', async () => {
    let seenWhileWorking: string | undefined
    const { d, puts, announced } = deps({
      thumbnail: async () => {
        seenWhileWorking = (await readProcessingStates([FILE]))[FILE]?.status
        return Buffer.from('thumb')
      }
    })
    const out = await processFile({ id: FILE, type: 'image/jpeg', filename_download: 'p.jpg' }, d)
    expect(seenWhileWorking).toBe('processing')
    expect(out?.status).toBe('ready')
    expect((await readProcessingStates([FILE]))[FILE]?.status).toBe('ready')
    expect(puts).toEqual([transformCacheKey(FILE, CHIP_THUMB)])
    expect(announced).toEqual([FILE])
  })

  it('a step that fails ends as failed — and still tells the viewers so the chip stops waiting', async () => {
    const { d, announced } = deps({
      extract: async () => {
        throw new Error('scanned PDF')
      }
    })
    const out = await processFile(
      { id: FILE, type: 'application/pdf', filename_download: 'q.pdf' },
      d
    )
    expect(out?.status).toBe('failed')
    expect((await readProcessingStates([FILE]))[FILE]?.status).toBe('failed')
    expect(announced).toEqual([FILE])
  })

  it('a document keeps its extracted text beside the renditions', async () => {
    const { d, puts } = deps()
    await processFile({ id: FILE, type: 'application/pdf', filename_download: 'q.pdf' }, d)
    expect(puts).toEqual([extractCacheKey(FILE)])
  })

  it('a file with nothing to do has no status at all', async () => {
    const { d, announced } = deps()
    expect(
      await processFile({ id: FILE, type: 'application/zip', filename_download: 'x.zip' }, d)
    ).toBeNull()
    expect(await readProcessingStates([FILE])).toEqual({})
    expect(announced).toEqual([])
  })
})
