import { describe, expect, it } from 'vitest'
import type { UploadRow } from '../api'
import {
  FileUploadError,
  isCancelled,
  MAX_FILE_BYTES,
  partRanges,
  phaseText,
  pickedFileProblem,
  resumePoint,
  titleFromFile,
  uploadVideoFile
} from './fileUpload'

const row = (p: Partial<UploadRow>): UploadRow => ({
  id: 'u1',
  bytes_received: 0,
  next_part: 0,
  status: 'open',
  duration_ms: null,
  created_at: '2026-10-09T10:00:00.000Z',
  updated_at: '2026-10-09T10:00:00.000Z',
  source: 'upload',
  name: 'demo.mp4',
  size: 25,
  ...p
})

describe('pickedFileProblem', () => {
  it('accepts MP4, WebM and MOV by extension or type', () => {
    expect(pickedFileProblem({ name: 'a.mp4', size: 1, type: '' })).toBeNull()
    expect(pickedFileProblem({ name: 'a.MOV', size: 1, type: '' })).toBeNull()
    expect(pickedFileProblem({ name: 'clip', size: 1, type: 'video/webm' })).toBeNull()
  })
  it('says why before anything is sent', () => {
    expect(pickedFileProblem({ name: 'a.mp4', size: 0, type: '' })).toBe('That file is empty.')
    expect(pickedFileProblem({ name: 'a.mp4', size: MAX_FILE_BYTES + 1, type: '' })).toMatch(
      /1\.2 GB/
    )
    expect(pickedFileProblem({ name: 'notes.pdf', size: 9, type: 'application/pdf' })).toBe(
      'Choose an MP4, WebM or MOV video.'
    )
  })
})

describe('titleFromFile', () => {
  it('drops the extension and underscores', () => {
    expect(titleFromFile('Approving_a_request.mov')).toBe('Approving a request')
  })
})

describe('partRanges', () => {
  it('cuts the file into numbered parts from where the server stopped', () => {
    expect(partRanges(25, 0, 0, 10)).toEqual([
      { n: 0, start: 0, end: 10 },
      { n: 1, start: 10, end: 20 },
      { n: 2, start: 20, end: 25 }
    ])
    expect(partRanges(25, 20, 2, 10)).toEqual([{ n: 2, start: 20, end: 25 }])
    expect(partRanges(25, 25, 3, 10)).toEqual([])
  })
})

describe('resumePoint', () => {
  const f = { name: 'demo.mp4', size: 25, type: 'video/mp4' }
  it('carries on the newest open upload of the same file', () => {
    const rows = [
      row({ id: 'old', bytes_received: 10, next_part: 1, updated_at: '2026-10-09T09:00:00.000Z' }),
      row({ id: 'new', bytes_received: 20, next_part: 2 })
    ]
    expect(resumePoint(rows, f, 10)).toEqual({ id: 'new', next_part: 2, offset: 20 })
    expect(resumePoint([row({ bytes_received: 25, next_part: 3 })], f, 10)).toMatchObject({
      offset: 25
    })
  })
  it('never resumes another file, a recording, a closed upload or odd part sizes', () => {
    expect(resumePoint([row({ name: 'other.mp4' })], f, 10)).toBeNull()
    expect(resumePoint([row({ size: 26 })], f, 10)).toBeNull()
    expect(resumePoint([row({ source: 'recording' })], f, 10)).toBeNull()
    expect(resumePoint([row({ status: 'finalized' })], f, 10)).toBeNull()
    expect(resumePoint([row({ bytes_received: 7, next_part: 1 })], f, 10)).toBeNull()
  })
})

describe('phaseText', () => {
  it('reads the server phase', () => {
    expect(phaseText('converting', 40)).toBe('Converting it so every browser can play it · 40%')
    expect(phaseText('saving', null)).toBe('Saving the video')
    expect(phaseText(null, null)).toBe('Checking the video')
  })
})

describe('uploadVideoFile', () => {
  const file = new File(['0123456789abcdefghijKLMNO'], 'demo.mp4', { type: 'video/mp4' })
  function deps(statuses: Array<Partial<UploadRow>>, open: UploadRow[] = []) {
    const sent: Array<[number, number]> = []
    const calls: string[] = []
    return {
      sent,
      calls,
      d: {
        api: {
          myUploads: async () => open,
          openFileUpload: async () => {
            calls.push('open')
            return { id: 'u1', next_part: 0 }
          },
          finalizeFileUpload: async () => {
            calls.push('finalize')
          },
          uploadStatus: async () => row({ status: 'finalizing', ...statuses.shift() })
        },
        send: async (_id: string, n: number, blob: Blob) => {
          sent.push([n, blob.size])
        },
        sleep: async () => undefined,
        partBytes: 10
      }
    }
  }
  const run = (d: ReturnType<typeof deps>['d'], signal = new AbortController().signal) => {
    const seen: string[] = []
    return {
      seen,
      done: uploadVideoFile(d, file, {
        signal,
        onProgress: (p) =>
          seen.push(p.stage === 'uploading' ? `up ${p.sent}` : `${p.phase} ${p.progress}`),
        onUploadId: () => undefined
      })
    }
  }

  it('sends every part in order, finalizes and waits for the server', async () => {
    const t = deps([{ phase: 'converting', progress: 50 }, { status: 'finalized' }])
    const r = run(t.d)
    await expect(r.done).resolves.toBe('u1')
    expect(t.sent).toEqual([
      [0, 10],
      [1, 10],
      [2, 5]
    ])
    expect(t.calls).toEqual(['open', 'finalize'])
    expect(r.seen).toEqual(['up 0', 'up 10', 'up 20', 'up 25', 'checking null', 'converting 50'])
  })
  it('resumes the same file from where the server stopped', async () => {
    const t = deps([{ status: 'finalized' }], [row({ bytes_received: 20, next_part: 2 })])
    await run(t.d).done
    expect(t.calls).toEqual(['finalize'])
    expect(t.sent).toEqual([[2, 5]])
  })
  it("passes on the server's reason when the file is refused", async () => {
    const t = deps([{ status: 'abandoned', error: 'That file has no video in it' }])
    await expect(run(t.d).done).rejects.toMatchObject({
      message: 'That file has no video in it',
      retryable: false
    })
  })
  it('a save failure can be tried again', async () => {
    const t = deps([
      { status: 'open', error: 'The video could not be saved. Try again in a moment.' }
    ])
    const err = await run(t.d).done.catch((e) => e)
    expect(err).toBeInstanceOf(FileUploadError)
    expect(err.retryable).toBe(true)
  })
  it('stops when cancelled', async () => {
    const t = deps([])
    const c = new AbortController()
    c.abort()
    expect(isCancelled(await run(t.d, c.signal).done.catch((e) => e))).toBe(true)
  })
  it('refuses a non-video file before opening anything', async () => {
    const t = deps([])
    const pdf = new File(['%PDF'], 'a.pdf', { type: 'application/pdf' })
    await expect(
      uploadVideoFile(t.d, pdf, {
        signal: new AbortController().signal,
        onProgress: () => undefined,
        onUploadId: () => undefined
      })
    ).rejects.toMatchObject({ message: 'Choose an MP4, WebM or MOV video.' })
    expect(t.calls).toEqual([])
  })
})
