import { describe, expect, it } from 'vitest'
import { EDIT_LIMITS, normalizeEdits } from '../../../services/help-video-edits.js'
import {
  blurPower,
  buildPosterArgs,
  buildRenderArgs,
  buildRenderPlan,
  graphArgs,
  MAX_GRAPH_BYTES,
  musicShareWindows,
  outputSize,
  pixelRect,
  renderPieces,
  rippleTickEditedTimes
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
  it('crops against the zoomed size, since crop sees iw/ih before the scale', () => {
    const edits = normalizeEdits(
      {
        zooms: [{ start_ms: 0, end_ms: 5000, rect: { x: 0.5, y: 0.5, w: 0.5, h: 0.5 }, ease_ms: 0 }]
      },
      10_000
    )
    const graph = fc(buildRenderArgs({ ...base, edits }))
    const z = '(1+(1.0000)*between(t,0.000,5.000))'
    const cx = '(0.5+(0.2500)*between(t,0.000,5.000))'
    const cy = '(0.5+(0.2500)*between(t,0.000,5.000))'
    expect(graph).toContain(`x='max(0,min(${cx}*(1280*${z})-1280/2,1280*${z}-1280))'`)
    expect(graph).toContain(`y='max(0,min(${cy}*(720*${z})-720/2,720*${z}-720))'`)
    expect(graph).not.toMatch(/\*iw|\*ih|iw-|ih-/)
  })
})

// The graph by file: as one argument it can pass Linux's 128 KiB
// per-argument limit and ffmpeg never starts (E2BIG).
describe('graph file', () => {
  const SRC = 600_000
  /** Every zoom and every keyframe EDIT_LIMITS allows, all moving. */
  function fullZooms() {
    const per = EDIT_LIMITS.zoomKeyframesTotal / EDIT_LIMITS.zooms
    const zooms = []
    for (let i = 0; i < EDIT_LIMITS.zooms; i++) {
      const start = 1000 + i * 10_000
      const end = start + 8000
      const keyframes = []
      for (let k = 0; k < per; k++) {
        keyframes.push({
          at_ms: start + Math.round((k * (end - start)) / (per - 1)),
          rect: { x: (k % 3) * 0.2 + 0.01 * i, y: (k % 2) * 0.3, w: 0.3 + 0.05 * k, h: 0.3 }
        })
      }
      zooms.push({ start_ms: start, end_ms: end, rect: keyframes[0].rect, ease_ms: 300, keyframes })
    }
    return zooms
  }
  /** The zooms plus every blur and hold EDIT_LIMITS allows. */
  function fullEdits() {
    const blurs = Array.from({ length: EDIT_LIMITS.blurs }, (_, i) => ({
      start_ms: i * 10_000,
      end_ms: i * 10_000 + 9000,
      rect: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 },
      strength: 12
    }))
    const holds = Array.from({ length: EDIT_LIMITS.holds }, (_, i) => ({
      at_ms: 500 + i * 10_000,
      hold_ms: 1000
    }))
    return normalizeEdits({ zooms: fullZooms(), blurs, holds }, SRC)
  }
  /** Every callout EDIT_LIMITS allows, rasterised (one fading overlay each). */
  const fullOverlays = () =>
    Array.from({ length: EDIT_LIMITS.annotations }, (_, i) => ({
      path: `/scratch/a${i}.png`,
      start_ms: i * 2000,
      end_ms: i * 2000 + 1500,
      fade_ms: 200
    }))

  it('names the file with -filter_complex_script and hands the graph back', () => {
    const edits = normalizeEdits({}, 10_000)
    const inline = buildRenderArgs({ ...base, edits })
    const plan = buildRenderPlan({ ...base, edits, graphFile: '/scratch/filters.txt' })
    const i = plan.args.indexOf('-filter_complex_script')
    expect(i).toBeGreaterThan(0)
    expect(plan.args[i + 1]).toBe('/scratch/filters.txt')
    expect(plan.args).not.toContain('-filter_complex')
    expect(plan.args).not.toContain(plan.graph)
    expect(plan.args.some((a) => a.includes('[0:v]'))).toBe(false)
    expect(plan.graph).toBe(fc(inline))
    // Only the graph's place differs.
    expect(
      plan.args.filter((a) => a !== '-filter_complex_script' && a !== '/scratch/filters.txt')
    ).toEqual(inline.filter((a) => a !== '-filter_complex' && a !== plan.graph))
  })
  it('builds 50 moving zooms of 6 stops each, without the graph in argv', () => {
    const edits = normalizeEdits({ zooms: fullZooms() }, SRC)
    expect(edits.zooms).toHaveLength(EDIT_LIMITS.zooms)
    expect(edits.zooms.every((z) => z.keyframes?.length === 6)).toBe(true)
    const plan = buildRenderPlan({ ...base, edits, graphFile: '/scratch/filters.txt' })
    // About 110 KB of zoom expressions alone.
    expect(Buffer.byteLength(plan.graph)).toBeGreaterThan(96 * 1024)
    for (const a of plan.args) expect(Buffer.byteLength(a)).toBeLessThan(4096)
    expect(plan.args).not.toContain('-filter_complex')
    // A moving zoom's Z is stored once per crop offset (st/ld).
    expect(plan.graph).toContain("x='st(0,")
    expect(plan.graph).toContain("y='st(0,")
  })
  it('builds edits inside every cap, past the 128 KiB per-argument limit, and in argv it would not', () => {
    const edits = fullEdits()
    expect(edits.blurs).toHaveLength(EDIT_LIMITS.blurs)
    expect(edits.holds).toHaveLength(EDIT_LIMITS.holds)
    const input = { ...base, edits, overlays: fullOverlays() }
    const plan = buildRenderPlan({ ...input, graphFile: '/scratch/filters.txt' })
    expect(Buffer.byteLength(plan.graph)).toBeGreaterThan(128 * 1024)
    expect(Buffer.byteLength(plan.graph)).toBeLessThanOrEqual(MAX_GRAPH_BYTES)
    for (const a of plan.args) expect(Buffer.byteLength(a)).toBeLessThan(4096)
    // The inline form (tests only) is the same graph as one argument.
    const inline = buildRenderArgs(input)
    expect(fc(inline)).toBe(plan.graph)
    expect(Buffer.byteLength(fc(inline))).toBeGreaterThan(128 * 1024)
  })
  it('refuses a graph over the sanity limit', () => {
    expect(() => graphArgs(['x'.repeat(MAX_GRAPH_BYTES)], undefined)).not.toThrow()
    expect(() => graphArgs(['x'.repeat(MAX_GRAPH_BYTES + 1)], '/scratch/filters.txt')).toThrow(
      /filter graph is too large/
    )
    const edits = normalizeEdits({}, 10_000)
    expect(() =>
      buildRenderPlan({
        ...base,
        edits,
        cursor: { assPath: `/${'c'.repeat(MAX_GRAPH_BYTES)}.ass` },
        graphFile: '/scratch/filters.txt'
      })
    ).toThrow(/filter graph is too large/)
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

describe('blur radius cap', () => {
  it('caps a tiny box so the half-size chroma planes accept it', () => {
    const edits = normalizeEdits(
      {
        blurs: [
          {
            start_ms: 0,
            end_ms: 3000,
            rect: { x: 0.1, y: 0.1, w: 0.0625, h: 0.1125 },
            strength: 40
          }
        ]
      },
      10_000
    )
    // 1280x720 frame: the box is 80x80, so the radius is floor(80/4)-1 = 19 at most;
    // 5 passes of 19 spread at least as far as one of 40 (5*19*20 >= 40*41).
    const graph = fc(buildRenderArgs({ ...base, edits }))
    expect(graph).toContain('crop=80:80:128:72,boxblur=19:5')
  })
  it('never goes below 1 for the smallest box', () => {
    const edits = normalizeEdits(
      {
        blurs: [
          { start_ms: 0, end_ms: 3000, rect: { x: 0.1, y: 0.1, w: 0.001, h: 0.001 }, strength: 40 }
        ]
      },
      10_000
    )
    // normalizeEdits floors the rect at 0.01 (12x6 px here); radius stays 1, and
    // the passes stop at 50 (the 12x6 field is uniform long before that)
    expect(fc(buildRenderArgs({ ...base, edits }))).toContain('crop=12:6:128:72,boxblur=1:50')
  })
  it('an uncapped blur keeps one pass', () => {
    expect(blurPower(12, 12)).toBe(1)
    expect(blurPower(12, 40)).toBe(1)
  })
  it('a capped blur spreads at least as far as the one asked for', () => {
    for (const [R, r] of [
      [40, 19],
      [20, 3],
      [12, 5],
      [8, 2]
    ]) {
      const p = blurPower(R, r)
      expect(p * r * (r + 1), `${R}->${r}`).toBeGreaterThanOrEqual(R * (R + 1))
      expect((p - 1) * r * (r + 1), `${R}->${r} minimal`).toBeLessThan(R * (R + 1))
    }
    expect(blurPower(40, 1)).toBe(50)
  })
})

describe('audio chain, interleaving and chaining', () => {
  const segs = (speed: number) =>
    normalizeEdits(
      {
        segments: [
          { start_ms: 0, end_ms: 2000, speed },
          { start_ms: 5000, end_ms: 9000, speed: 1 }
        ]
      },
      10_000
    )
  it.each([
    [1.5, 'atempo=1.5'],
    [2, 'atempo=2'],
    [1, 'anull']
  ])('speed %s uses %s after atrim and asetpts', (speed, filter) => {
    const graph = fc(buildRenderArgs({ ...base, edits: segs(speed) }))
    expect(graph).toContain(`[as0]atrim=start=0.000:end=2.000,asetpts=PTS-STARTPTS,${filter}[ca0]`)
  })
  it('interleaves concat inputs video then audio per piece', () => {
    const graph = fc(buildRenderArgs({ ...base, edits: segs(1) }))
    expect(graph).toContain('[c0][ca0][c1][ca1]concat=n=2:v=1:a=1[vout][aout]')
  })
  it('maps only video when there is no sound', () => {
    const args = buildRenderArgs({ ...base, hasAudio: false, edits: segs(1) })
    expect(args.filter((a) => a === '-map')).toHaveLength(1)
    expect(args).toContain('[vout]')
    expect(fc(args)).not.toContain('[aout]')
    expect(args).not.toContain('-c:a')
  })
  it('chains two blurs and sums two zoom terms', () => {
    const edits = normalizeEdits(
      {
        blurs: [
          { start_ms: 0, end_ms: 1000, rect: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 }, strength: 6 },
          { start_ms: 2000, end_ms: 3000, rect: { x: 0.5, y: 0.5, w: 0.2, h: 0.2 }, strength: 6 }
        ],
        zooms: [
          { start_ms: 1000, end_ms: 2000, rect: { x: 0, y: 0, w: 0.5, h: 0.5 }, ease_ms: 0 },
          { start_ms: 4000, end_ms: 6000, rect: { x: 0.5, y: 0.5, w: 0.5, h: 0.5 }, ease_ms: 0 }
        ]
      },
      10_000
    )
    const graph = fc(buildRenderArgs({ ...base, edits }))
    expect(graph).toContain('[v0]split[v0a][v0b]')
    expect(graph).toContain('[v0a][bl0]overlay=')
    expect(graph).toContain('[v1]split[v1a][v1b]')
    expect(graph).toContain('[v1a][bl1]overlay=')
    expect(graph).toContain('[v2]scale=')
    expect(graph).toContain('(1+(1.0000)*between(t,1.000,2.000)+(1.0000)*between(t,4.000,6.000))')
  })
  it('builds a valid graph for one trimmed or sped-up segment', () => {
    for (const seg of [
      { start_ms: 1000, end_ms: 9000, speed: 1 },
      { start_ms: 0, end_ms: 10_000, speed: 2 }
    ]) {
      const edits = normalizeEdits({ segments: [seg] }, 10_000)
      const graph = fc(buildRenderArgs({ ...base, edits }))
      expect(graph).toContain('split=1[s0]')
      expect(graph).toContain('concat=n=1:v=1:a=1[vout][aout]')
    }
  })
})

describe('held frames (#1537)', () => {
  const held = normalizeEdits(
    {
      segments: [{ start_ms: 0, end_ms: 10_000, speed: 1 }],
      holds: [{ id: 'h1', at_ms: 4000, hold_ms: 2000 }]
    },
    10_000
  )
  it('splits each kept piece around its holds into played stretches and holds', () => {
    expect(renderPieces(held)).toEqual([
      { kind: 'play', start_ms: 0, end_ms: 4000, speed: 1 },
      { kind: 'hold', at_ms: 4000, hold_ms: 2000 },
      { kind: 'play', start_ms: 4000, end_ms: 10_000, speed: 1 }
    ])
    const edge = normalizeEdits(
      {
        segments: [
          { start_ms: 0, end_ms: 2000, speed: 1 },
          { start_ms: 5000, end_ms: 9000, speed: 2 }
        ],
        holds: [
          { at_ms: 5000, hold_ms: 500 },
          { at_ms: 7000, hold_ms: 1000 }
        ]
      },
      10_000
    )
    expect(renderPieces(edge)).toEqual([
      { kind: 'play', start_ms: 0, end_ms: 2000, speed: 1 },
      { kind: 'hold', at_ms: 5000, hold_ms: 500 },
      { kind: 'play', start_ms: 5000, end_ms: 7000, speed: 2 },
      { kind: 'hold', at_ms: 7000, hold_ms: 1000 },
      { kind: 'play', start_ms: 7000, end_ms: 9000, speed: 2 }
    ])
  })
  it('holds one frame in the same graph: a steady, padded pick, looped over silence', () => {
    const graph = fc(buildRenderArgs({ ...base, edits: held }))
    expect(graph).toContain('split=3[s0][s1][s2]')
    expect(graph).toContain('[0:a]asplit=2[as0][as2]')
    expect(graph).toContain('[s0]trim=start=0.000:end=4.000,setpts=(PTS-STARTPTS)/1[c0]')
    expect(graph).toContain(
      '[s1]fps=30,tpad=stop_mode=clone:stop_duration=4.100,trim=start=4.000:end=4.100,setpts=PTS-STARTPTS,trim=end_frame=1,loop=loop=59:size=1:start=0,setpts=N/(30*TB)[c1]'
    )
    expect(graph).toContain(
      'anullsrc=r=48000:cl=stereo,atrim=duration=2.000,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[ca1]'
    )
    expect(graph).toContain('[s2]trim=start=4.000:end=10.000,setpts=(PTS-STARTPTS)/1[c2]')
    // The pieces' sound is brought to the hold's format before the concat.
    expect(graph).toContain(
      '[as2]atrim=start=4.000:end=10.000,asetpts=PTS-STARTPTS,anull,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[ca2]'
    )
    expect(graph).toContain('[c0][ca0][c1][ca1][c2][ca2]concat=n=3:v=1:a=1[vout][aout]')
    expect(graph).not.toContain('trim=end=10.000,setpts=PTS-STARTPTS[vout]')
  })
  it('holds without sound, and leaves a video without holds exactly as before', () => {
    const silent = fc(buildRenderArgs({ ...base, hasAudio: false, edits: held }))
    expect(silent).not.toContain('anullsrc')
    expect(silent).toContain('[c0][c1][c2]concat=n=3:v=1:a=0[vout]')
    const plain = normalizeEdits({ segments: [{ start_ms: 0, end_ms: 10_000, speed: 1 }] }, 10_000)
    const graph = fc(buildRenderArgs({ ...base, edits: plain }))
    expect(graph).toContain('trim=end=10.000,setpts=PTS-STARTPTS[vout]')
    expect(graph).not.toContain('aformat')
  })
  it('music shares and ticks follow the longer edited pieces', () => {
    const e = normalizeEdits(
      {
        segments: [
          { start_ms: 0, end_ms: 4000, speed: 1, music: 0.5 },
          { start_ms: 4000, end_ms: 8000, speed: 1 }
        ],
        holds: [{ at_ms: 2000, hold_ms: 1500 }],
        annotations: [
          {
            type: 'ripple',
            start_ms: 6000,
            end_ms: 6500,
            rect: { x: 0.5, y: 0.5, w: 0.05, h: 0.05 }
          }
        ],
        music: { enabled: true, source: 'library', track: 'calm', name: 'Calm', volume: 0.3 }
      },
      8000
    )
    expect(musicShareWindows(e)).toEqual([{ start_ms: 0, end_ms: 5500, share: 0.5 }])
    expect(rippleTickEditedTimes(e)).toEqual([7500])
  })
})
