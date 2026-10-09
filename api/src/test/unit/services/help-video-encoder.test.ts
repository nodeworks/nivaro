import { devNull } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'

const ff = vi.hoisted(() => ({
  has: true,
  encoders: '',
  trialFails: new Set<string>(),
  calls: [] as string[][]
}))
vi.mock('../../../services/ffmpeg.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../services/ffmpeg.js')>()),
  hasFfmpeg: async () => ff.has,
  ffmpegOutput: async (args: string[]) => {
    ff.calls.push(args)
    if (args.includes('-encoders')) return ff.encoders
    const codec = args[args.indexOf('-c:v') + 1]
    if (ff.trialFails.has(codec)) throw new Error(`${codec}: no device`)
    return ''
  }
}))

const enc = await import('../../../services/help-video-encoder.js')
const { ENCODER_DEFAULTS } = await import('../../../services/help-video-settings.js')
const { buildRenderArgs } = await import('../../../services/help-video-render-plan.js')
const { normalizeEdits } = await import('../../../services/help-video-edits.js')

const size = { width: 1920, height: 1080 }

afterEach(() => {
  enc.resetEncoderDetection()
  ff.has = true
  ff.encoders = ''
  ff.trialFails.clear()
  ff.calls = []
  delete process.env.HELP_VIDEO_HARDWARE_TEST_FAIL
})

describe('softwarePlan', () => {
  it("is today's encode at the defaults", () => {
    const p = enc.softwarePlan(ENCODER_DEFAULTS, size, 60_000)
    expect(p.videoArgs).toEqual(enc.DEFAULT_VIDEO_ARGS)
    expect(p).toMatchObject({ kind: 'libx264', twoPass: false, hwFilter: null })
  })
  it('uses the preset and CRF', () => {
    const p = enc.softwarePlan({ ...ENCODER_DEFAULTS, preset: 'medium', crf: 19 }, size, 60_000)
    expect(p.videoArgs).toEqual([
      '-c:v',
      'libx264',
      '-preset',
      'medium',
      '-crf',
      '19',
      '-pix_fmt',
      'yuv420p'
    ])
  })
  it('goes two-pass only past the set length, at a bitrate from the CRF', () => {
    const s = { ...ENCODER_DEFAULTS, two_pass_over_minutes: 5 }
    expect(enc.softwarePlan(s, size, 5 * 60_000).twoPass).toBe(false)
    const p = enc.softwarePlan(s, size, 5 * 60_000 + 1)
    expect(p.twoPass).toBe(true)
    expect(p.videoArgs).toContain('-b:v')
    expect(p.videoArgs).not.toContain('-crf')
  })
})

describe('targetKbps', () => {
  it('is about 4.4 Mbit/s for 1080p at CRF 23 and doubles 6 steps down', () => {
    expect(enc.targetKbps(1920, 1080, 23)).toBe(4355)
    expect(enc.targetKbps(1920, 1080, 17)).toBe(8709)
  })
  it('never goes below 300 kbit/s', () => expect(enc.targetKbps(64, 64, 32)).toBe(300))
})

describe('hardwarePlan', () => {
  it('VideoToolbox takes a bitrate, never a CRF or preset', () => {
    const p = enc.hardwarePlan('videotoolbox', ENCODER_DEFAULTS, size)
    expect(p.videoArgs.slice(0, 2)).toEqual(['-c:v', 'h264_videotoolbox'])
    expect(p.videoArgs).not.toContain('-crf')
    expect(p.videoArgs).not.toContain('-preset')
    expect(p.videoArgs).toContain('4355k')
  })
  it('VAAPI uploads the picture and runs constant QP at the CRF', () => {
    const p = enc.hardwarePlan('vaapi', { ...ENCODER_DEFAULTS, crf: 21 }, size)
    expect(p.hwFilter).toBe('format=nv12,hwupload')
    expect(p.inputArgs).toContain('-init_hw_device')
    expect(p.videoArgs).toEqual(['-c:v', 'h264_vaapi', '-rc_mode', 'CQP', '-qp', '21'])
  })
  it('can be told to fail (dev) to exercise the software fallback', () => {
    process.env.HELP_VIDEO_HARDWARE_TEST_FAIL = '1'
    expect(enc.hardwarePlan('videotoolbox', ENCODER_DEFAULTS, size).videoArgs).toContain(
      'nivaro-test-failure'
    )
  })
})

describe('detection and planVideoEncode', () => {
  it('keeps encoders that pass a one-frame trial', async () => {
    ff.encoders = ' V....D h264_videotoolbox  VideoToolbox\n V....D h264_vaapi  VAAPI'
    ff.trialFails.add('h264_vaapi')
    const r = await enc.detectHardwareEncoders()
    expect(r.available).toEqual(['videotoolbox'])
    expect(r.failed).toEqual([{ kind: 'vaapi', reason: 'h264_vaapi: no device' }])
    // Once per process.
    await enc.detectHardwareEncoders()
    expect(ff.calls.filter((c) => c.includes('-encoders'))).toHaveLength(1)
  })
  it('uses hardware only when the settings say auto', async () => {
    ff.encoders = 'h264_videotoolbox'
    expect((await enc.planVideoEncode(ENCODER_DEFAULTS, size, 1000)).kind).toBe('libx264')
    expect(ff.calls).toEqual([]) // 'off' never even detects
    expect(
      (await enc.planVideoEncode({ ...ENCODER_DEFAULTS, hardware: 'auto' }, size, 1000)).kind
    ).toBe('videotoolbox')
  })
  it('skips an encoder that failed mid-render', async () => {
    ff.encoders = 'h264_videotoolbox'
    enc.markHardwareFailed('videotoolbox')
    expect(
      (await enc.planVideoEncode({ ...ENCODER_DEFAULTS, hardware: 'auto' }, size, 1000)).kind
    ).toBe('libx264')
  })
  it('falls back to software on a host without ffmpeg encoders', async () => {
    ff.has = false
    expect(
      (await enc.planVideoEncode({ ...ENCODER_DEFAULTS, hardware: 'auto' }, size, 1000)).kind
    ).toBe('libx264')
  })
})

describe('buildRenderArgs with an encoder plan', () => {
  const base = {
    width: 1280,
    height: 720,
    hasAudio: true,
    sourcePath: 'in.webm',
    sourceMime: 'video/webm',
    overlays: [],
    outputPath: 'out.mp4',
    threads: 2,
    edits: normalizeEdits({}, 10_000)
  }
  it('is unchanged without one', () => {
    const args = buildRenderArgs(base)
    const i = args.indexOf('-c:v')
    expect(args.slice(i, i + 8)).toEqual(enc.DEFAULT_VIDEO_ARGS)
    expect(args.slice(-3)).toEqual(['-movflags', '+faststart', 'out.mp4'])
  })
  it('VAAPI: device before the inputs, picture uploaded and mapped', () => {
    const args = buildRenderArgs({
      ...base,
      video: enc.hardwarePlan('vaapi', ENCODER_DEFAULTS, size)
    })
    expect(args.indexOf('-init_hw_device')).toBeLessThan(args.indexOf('-i'))
    expect(args[args.indexOf('-filter_complex') + 1]).toContain('[vout]format=nv12,hwupload[vhw]')
    expect(args[args.indexOf('-map') + 1]).toBe('[vhw]')
    expect(args).not.toContain('-pix_fmt')
  })
  it('two-pass: pass 1 writes no file, pass 2 the MP4', () => {
    const plan = enc.softwarePlan({ ...ENCODER_DEFAULTS, two_pass_over_minutes: 0.1 }, size, 60_000)
    const p1 = buildRenderArgs({ ...base, video: plan, pass: { n: 1, logfile: '/w/x' } })
    expect(p1).toEqual(expect.arrayContaining(['-pass', '1', '-passlogfile', '/w/x']))
    expect(p1.slice(-3)).toEqual(['-f', 'null', devNull])
    expect(p1).not.toContain('+faststart')
    const p2 = buildRenderArgs({ ...base, video: plan, pass: { n: 2, logfile: '/w/x' } })
    expect(p2).toEqual(expect.arrayContaining(['-pass', '2']))
    expect(p2.slice(-1)).toEqual(['out.mp4'])
  })
})
