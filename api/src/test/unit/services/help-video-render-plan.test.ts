import { describe, expect, it } from 'vitest'
import { normalizeEdits } from '../../../services/help-video-edits.js'
import {
  buildPosterArgs,
  buildRenderArgs,
  outputSize,
  pixelRect
} from '../../../services/help-video-render-plan.js'

const base = {
  width: 1280,
  height: 720,
  hasAudio: true,
  sourcePath: 'in.webm',
  sourceMime: 'video/webm',
  overlays: [],
  outputPath: 'out.mp4',
  threads: 2
}
const fc = (args: string[]) => args[args.indexOf('-filter_complex') + 1]

describe('outputSize', () => {
  it('keeps small frames', () =>
    expect(outputSize(1280, 720)).toEqual({ width: 1280, height: 720 }))
  it('caps at 1080p keeping the aspect', () =>
    expect(outputSize(2560, 1440)).toEqual({ width: 1920, height: 1080 }))
  it('rounds to even sizes', () =>
    expect(outputSize(1281, 721)).toEqual({ width: 1280, height: 720 }))
  it('caps a tall frame by height', () =>
    expect(outputSize(1440, 2560)).toEqual({ width: 606, height: 1080 }))
})

describe('pixelRect', () => {
  it('converts fractions to even pixels inside the frame', () =>
    expect(pixelRect({ x: 0.5, y: 0.5, w: 0.25, h: 0.1 }, { width: 1280, height: 720 })).toEqual({
      x: 640,
      y: 360,
      w: 320,
      h: 72
    }))
  it('never returns less than 2×2', () =>
    expect(
      pixelRect({ x: 0.99, y: 0.99, w: 0.001, h: 0.001 }, { width: 100, height: 100 })
    ).toEqual({
      x: 98,
      y: 98,
      w: 2,
      h: 2
    }))
})

describe('buildRenderArgs', () => {
  it('caps threads, uses the fast H.264 preset and faststart', () => {
    const args = buildRenderArgs({ ...base, edits: normalizeEdits({}, 10_000) })
    expect(args).toEqual(
      expect.arrayContaining([
        '-threads',
        '2',
        '-filter_complex_threads',
        '1',
        '-preset',
        'veryfast',
        '-crf',
        '23',
        '+faststart'
      ])
    )
    expect(args.at(-1)).toBe('out.mp4')
  })
  it('skips trimming when nothing is cut', () => {
    const graph = fc(buildRenderArgs({ ...base, edits: normalizeEdits({}, 10_000) }))
    expect(graph).not.toContain('trim=start')
    expect(graph).not.toContain('concat')
    expect(graph).toContain('trim=end=10.000')
    expect(graph).toContain('[vout]')
    expect(graph).toContain('[aout]')
  })
  it('trims, retimes and concatenates kept pieces', () => {
    const edits = normalizeEdits(
      {
        segments: [
          { start_ms: 0, end_ms: 2000, speed: 1 },
          { start_ms: 5000, end_ms: 9000, speed: 4 }
        ]
      },
      10_000
    )
    const graph = fc(buildRenderArgs({ ...base, edits }))
    expect(graph).toContain('trim=start=0.000:end=2.000')
    expect(graph).toContain('trim=start=5.000:end=9.000,setpts=(PTS-STARTPTS)/4')
    expect(graph).toContain('atempo=2,atempo=2')
    expect(graph).toContain('concat=n=2:v=1:a=1[vout][aout]')
  })
  it('handles recordings without sound', () => {
    const edits = normalizeEdits(
      {
        segments: [
          { start_ms: 0, end_ms: 2000, speed: 1 },
          { start_ms: 5000, end_ms: 9000, speed: 2 }
        ]
      },
      10_000
    )
    const args = buildRenderArgs({ ...base, hasAudio: false, edits })
    expect(fc(args)).toContain('concat=n=2:v=1:a=0[vout]')
    expect(fc(args)).not.toContain('asplit')
    expect(args).not.toContain('[aout]')
  })
  it('blurs a region only during its window', () => {
    const edits = normalizeEdits(
      {
        blurs: [
          { start_ms: 1000, end_ms: 3000, rect: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 }, strength: 12 }
        ]
      },
      10_000
    )
    const graph = fc(buildRenderArgs({ ...base, edits }))
    expect(graph).toContain('crop=256:144:128:72,boxblur=12:1')
    expect(graph).toContain("overlay=128:72:enable='between(t,1.000,3.000)'")
  })
  it('lays annotation images over their windows', () => {
    const args = buildRenderArgs({
      ...base,
      edits: normalizeEdits({}, 10_000),
      overlays: [{ path: 'a1.png', start_ms: 2000, end_ms: 4000 }]
    })
    expect(args).toEqual(expect.arrayContaining(['-i', 'a1.png']))
    expect(fc(args)).toContain("[1:v]overlay=0:0:enable='between(t,2.000,4.000)'")
  })
  it('zooms with a per-frame scale and crop', () => {
    const edits = normalizeEdits(
      {
        zooms: [
          { start_ms: 1000, end_ms: 5000, rect: { x: 0.5, y: 0.5, w: 0.5, h: 0.5 }, ease_ms: 500 }
        ]
      },
      10_000
    )
    const graph = fc(buildRenderArgs({ ...base, edits }))
    expect(graph).toContain('eval=frame')
    expect(graph).toContain('crop=1280:720')
    expect(graph).toContain('clip(min((t-1.000)/0.500,(5.000-t)/0.500),0,1)')
  })
})

describe('input hardening', () => {
  it('pins the source input to its demuxer immediately before -i', () => {
    const args = buildRenderArgs({ ...base, edits: normalizeEdits({}, 10_000) })
    const i = args.indexOf('in.webm')
    expect(args.slice(i - 7, i)).toEqual([
      '-protocol_whitelist',
      'file',
      '-f',
      'matroska,webm',
      '-format_whitelist',
      'matroska,webm',
      '-i'
    ])
  })
  it('fails closed on an unmapped or empty recording mime', () => {
    const edits = normalizeEdits({}, 10_000)
    expect(() => buildRenderArgs({ ...base, edits, sourceMime: 'application/x-mpegurl' })).toThrow(
      'Unsupported recording format: application/x-mpegurl'
    )
    expect(() => buildRenderArgs({ ...base, edits, sourceMime: '' })).toThrow(
      /Unsupported recording format/
    )
  })
  it('pins every overlay input to png_pipe', () => {
    const args = buildRenderArgs({
      ...base,
      edits: normalizeEdits({}, 10_000),
      overlays: [
        { path: 'a1.png', start_ms: 0, end_ms: 1000 },
        { path: 'a2.png', start_ms: 1000, end_ms: 2000 }
      ]
    })
    for (const p of ['a1.png', 'a2.png']) {
      const i = args.indexOf(p)
      expect(args.slice(i - 5, i)).toEqual(['-protocol_whitelist', 'file', '-f', 'png_pipe', '-i'])
    }
  })
})

describe('buildPosterArgs', () => {
  it('grabs one frame at the poster time from a pinned input', () =>
    expect(buildPosterArgs('out.mp4', 12_345, 'p.jpg')).toEqual([
      '-y',
      '-v',
      'error',
      '-ss',
      '12.345',
      '-protocol_whitelist',
      'file',
      '-f',
      'mov,mp4,m4a,3gp,3g2,mj2',
      '-format_whitelist',
      'mov,mp4,m4a,3gp,3g2,mj2',
      '-i',
      'out.mp4',
      '-frames:v',
      '1',
      '-q:v',
      '3',
      'p.jpg'
    ]))
})
