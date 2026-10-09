import { mkdtempSync, writeFileSync } from 'node:fs'
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
    await remuxToFile(raw, fixed, 'video/webm')
    const p = await probeVideo(fixed, 'video/webm')
    expect(p.width).toBe(320)
    expect(p.height).toBe(240)
    expect(p.has_audio).toBe(true)
    expect(p.duration_ms).toBeGreaterThan(2500)
    expect(p.duration_ms).toBeLessThan(3500)
  }, 60_000)

  it('refuses a playlist posing as a webm instead of following it', async (ctx) => {
    if (!ok) ctx.skip()
    const fake = join(dir, 'fake.webm')
    writeFileSync(fake, '#EXTM3U\n#EXT-X-VERSION:3\n#EXTINF:1,\n/etc/hosts\n#EXT-X-ENDLIST\n')
    await expect(remuxToFile(fake, join(dir, 'out.webm'), 'video/webm')).rejects.toThrow()
    await expect(probeVideo(fake, 'video/webm')).rejects.toThrow()
  }, 30_000)
})
