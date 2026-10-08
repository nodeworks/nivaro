import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { hasFfmpeg, probeVideo, remuxToFile, runFfmpeg } from '../../services/ffmpeg.js'

const dir = mkdtempSync(join(tmpdir(), 'nvr-ff-'))
let ok = false
beforeAll(async () => {
  ok = await hasFfmpeg()
})

describe('ffmpeg helpers', () => {
  it('probes a generated webm and remuxes it with a finite duration', async (ctx) => {
    if (!ok) ctx.skip() // reported as skipped, never as a silent pass
    const raw = join(dir, 'raw.webm')
    // A MediaRecorder-like file: live-style webm without cues.
    await runFfmpeg([
      '-y',
      '-f',
      'lavfi',
      '-i',
      'testsrc=size=320x240:rate=15:duration=3',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:duration=3',
      '-c:v',
      'libvpx',
      '-c:a',
      'libopus',
      '-live',
      '1',
      '-f',
      'webm',
      raw
    ])
    const fixed = join(dir, 'fixed.webm')
    await remuxToFile(raw, fixed)
    const p = await probeVideo(fixed)
    expect(p.width).toBe(320)
    expect(p.height).toBe(240)
    expect(p.has_audio).toBe(true)
    expect(p.duration_ms).toBeGreaterThan(2500)
    expect(p.duration_ms).toBeLessThan(3500)
  }, 60_000)
})
