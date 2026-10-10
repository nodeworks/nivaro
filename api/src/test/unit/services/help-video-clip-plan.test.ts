import { describe, expect, it } from 'vitest'
import {
  buildClipArgs,
  buildClipPlan,
  CLIP_LIMITS,
  type ClipPlanInput,
  clipDurationMs,
  clipInputWindow,
  clipOutputSize,
  clipSpans,
  isClipKind
} from '../../../services/help-video-clip-plan.js'
import {
  EDIT_LIMITS,
  emptyEdits,
  normalizeEdits,
  type VideoEdits
} from '../../../services/help-video-edits.js'

// #1562: the edit mapping and ffmpeg arguments of a clip, with no ffmpeg.

const edits: VideoEdits = {
  ...emptyEdits(60_000),
  segments: [
    { start_ms: 0, end_ms: 10_000, speed: 1 },
    { start_ms: 20_000, end_ms: 30_000, speed: 2 },
    { start_ms: 40_000, end_ms: 60_000, speed: 1 }
  ]
}
const withIntro: VideoEdits = {
  ...edits,
  intro: { enabled: true, duration_ms: 3000, show_chapters: false, title: '', subtitle: '' }
}

describe('clipSpans', () => {
  it('maps an edited window inside one piece', () => {
    expect(clipSpans(edits, 2000, 5000)).toEqual([{ start_ms: 2000, end_ms: 5000, speed: 1 }])
  })
  it('crosses a cut and a sped-up piece at its speed', () => {
    // Edited 8–13 s: 8–10 s of piece 1, then 3 edited s of the 2x piece (6 source s).
    expect(clipSpans(edits, 8000, 13_000)).toEqual([
      { start_ms: 8000, end_ms: 10_000, speed: 1 },
      { start_ms: 20_000, end_ms: 26_000, speed: 2 }
    ])
  })
  it('counts the intro card as edited time that covers no recording', () => {
    expect(clipSpans(withIntro, 0, 3000)).toEqual([])
    expect(clipSpans(withIntro, 1000, 5000)).toEqual([{ start_ms: 0, end_ms: 2000, speed: 1 }])
  })
})

describe('clipDurationMs / clipInputWindow / clipOutputSize', () => {
  it('measures a rendered cut and a source cut in edited time', () => {
    expect(clipDurationMs({ from: 'rendered', start_ms: 1000, end_ms: 4500 })).toBe(3500)
    expect(clipDurationMs({ from: 'source', spans: clipSpans(edits, 8000, 13_000), edits })).toBe(
      5000
    )
  })
  it('seeks to the first moment the clip needs and reads only to the last', () => {
    expect(clipInputWindow({ from: 'rendered', start_ms: 1000, end_ms: 4500 })).toEqual({
      offset_ms: 1000,
      length_ms: 3500
    })
    expect(
      clipInputWindow({ from: 'source', spans: clipSpans(edits, 8000, 13_000), edits })
    ).toEqual({ offset_ms: 8000, length_ms: 18_000 })
  })
  it('caps a GIF at 640 wide and an MP4 at 1280, keeping even sizes', () => {
    expect(clipOutputSize('gif', { width: 1920, height: 1080 })).toEqual({
      width: 640,
      height: 360
    })
    expect(clipOutputSize('mp4', { width: 1920, height: 1080 })).toEqual({
      width: 1280,
      height: 720
    })
    expect(clipOutputSize('mp4', { width: 800, height: 601 })).toEqual({ width: 800, height: 600 })
  })
  it('measures a source cut after the crop', () => {
    const cropped = { ...edits, crop: { x: 0.25, y: 0, w: 0.5, h: 1 } }
    const cut = { from: 'source' as const, spans: clipSpans(cropped, 0, 1000), edits: cropped }
    expect(clipOutputSize('mp4', { width: 1920, height: 1080 }, cut)).toEqual({
      width: 960,
      height: 1080
    })
  })
  it('knows the kinds', () => {
    expect(isClipKind('gif')).toBe(true)
    expect(isClipKind('webm')).toBe(false)
  })
})

const base: ClipPlanInput = {
  kind: 'mp4',
  inputPath: '/w/in.mp4',
  inputMime: 'video/mp4',
  width: 1920,
  height: 1080,
  hasAudio: true,
  threads: 2,
  outputPath: '/w/clip.mp4',
  cut: { from: 'rendered', start_ms: 65_000, end_ms: 70_000 },
  palettePath: '/w/palette.png'
}
const graph = (args: string[]) => args[args.indexOf('-filter_complex') + 1]
const argAfter = (args: string[], flag: string) => args[args.indexOf(flag) + 1]

describe('buildClipPlan (the graph by file)', () => {
  it('names the file with -filter_complex_script and hands the graph back', () => {
    const inline = buildClipArgs(base)
    const plan = buildClipPlan({ ...base, graphFile: '/w/filters.txt' })
    const i = plan.args.indexOf('-filter_complex_script')
    expect(i).toBeGreaterThan(0)
    expect(plan.args[i + 1]).toBe('/w/filters.txt')
    expect(plan.args).not.toContain('-filter_complex')
    expect(plan.args.join('\n')).not.toContain('[vcut]')
    expect(plan.graph).toBe(graph(inline))
    // The GIF passes too.
    const gif = { ...base, kind: 'gif' as const, graphFile: '/w/filters.txt' }
    for (const pass of ['palette', 'encode'] as const) {
      const g = buildClipPlan(gif, pass)
      expect(g.args).toContain('-filter_complex_script')
      expect(g.graph).toBe(graph(buildClipArgs({ ...base, kind: 'gif' }, pass)))
    }
  })
  it('builds a window over as many kept pieces as it can hold, with the graph off argv', () => {
    // EDIT_LIMITS.segments pieces of 100 ms with 100 ms gaps: a 30 s window
    // crosses 300 of them, every one a branch of the graph.
    const segments = []
    for (let i = 0; i < EDIT_LIMITS.segments; i++)
      segments.push({ start_ms: i * 200, end_ms: i * 200 + 100, speed: 1 })
    const e = normalizeEdits({ segments }, 200 * EDIT_LIMITS.segments)
    expect(e.segments).toHaveLength(EDIT_LIMITS.segments)
    const spans = clipSpans(e, 0, 30_000)
    expect(spans).toHaveLength(300)
    const plan = buildClipPlan({
      ...base,
      inputPath: '/w/in.webm',
      inputMime: 'video/webm',
      cut: { from: 'source', spans, edits: e },
      graphFile: '/w/filters.txt'
    })
    expect(plan.graph).toContain('concat=n=300:v=1:a=1[vcut][acut]')
    expect(Buffer.byteLength(plan.graph)).toBeGreaterThan(32 * 1024)
    for (const a of plan.args) expect(Buffer.byteLength(a)).toBeLessThan(4096)
    expect(plan.args).not.toContain('-filter_complex')
  })
})

describe('buildClipArgs', () => {
  it('cuts a rendered MP4 by seeking before decoding, with sound', () => {
    const args = buildClipArgs(base)
    expect(argAfter(args, '-ss')).toBe('65.000')
    expect(argAfter(args, '-t')).toBe('5.000')
    expect(args.indexOf('-ss')).toBeLessThan(args.indexOf('-i'))
    expect(graph(args)).toContain('[0:v]trim=end=5.000,setpts=PTS-STARTPTS[vcut]')
    expect(graph(args)).toContain('[0:a]atrim=end=5.000,asetpts=PTS-STARTPTS[acut]')
    expect(graph(args)).toContain('[vcut]scale=1280:720:flags=lanczos,format=yuv420p[vout]')
    expect(args).toContain('[acut]')
    expect(argAfter(args, '-c:v')).toBe('libx264')
    expect(argAfter(args, '-c:a')).toBe('aac')
    expect(args.slice(-2)).toEqual(['mp4', '/w/clip.mp4'])
  })
  it('leaves the sound out of a silent recording', () => {
    const args = buildClipArgs({ ...base, hasAudio: false })
    expect(args).toContain('-an')
    expect(graph(args)).not.toContain('[0:a]')
  })
  it('cuts the original with the edit mapping: pieces at their speed, joined', () => {
    const args = buildClipArgs({
      ...base,
      inputPath: '/w/in.webm',
      inputMime: 'video/webm',
      cut: { from: 'source', spans: clipSpans(edits, 8000, 13_000), edits }
    })
    const g = graph(args)
    expect(argAfter(args, '-ss')).toBe('8.000')
    expect(argAfter(args, '-t')).toBe('18.000')
    // Times are shifted by the seek: piece 1 runs 0–2 s, piece 2 12–18 s at 2x.
    expect(g).toContain('[s0]trim=start=0.000:end=2.000,setpts=(PTS-STARTPTS)/1[c0]')
    expect(g).toContain('[s1]trim=start=12.000:end=18.000,setpts=(PTS-STARTPTS)/2[c1]')
    expect(g).toContain('asetpts=PTS-STARTPTS,atempo=2[ca1]')
    expect(g).toContain('[c0][ca0][c1][ca1]concat=n=2:v=1:a=1[vcut][acut]')
    expect(g).toContain('[0:v]scale=1920:1080,format=yuv420p,setsar=1[v0]')
  })
  it('draws the blurs and the crop before the cut, in shifted time', () => {
    const e: VideoEdits = {
      ...edits,
      blurs: [
        {
          id: 'b',
          start_ms: 1000,
          end_ms: 9000,
          rect: { x: 0.5, y: 0.5, w: 0.25, h: 0.25 },
          strength: 10
        }
      ],
      crop: { x: 0, y: 0, w: 0.5, h: 1 }
    }
    const args = buildClipArgs({
      ...base,
      cut: { from: 'source', spans: clipSpans(e, 2000, 5000), edits: e }
    })
    const g = graph(args)
    expect(g).toContain('boxblur=')
    expect(g).toContain("enable='between(t,0.000,7.000)'")
    expect(g).toContain('crop=960:1080:0:0,setsar=1')
    expect(g).toContain('trim=start=0.000:end=3.000')
  })
  it('skips a blur the window never reaches', () => {
    const e: VideoEdits = {
      ...edits,
      blurs: [
        {
          id: 'b',
          start_ms: 50_000,
          end_ms: 55_000,
          rect: { x: 0, y: 0, w: 0.5, h: 0.5 },
          strength: 10
        }
      ]
    }
    const args = buildClipArgs({
      ...base,
      cut: { from: 'source', spans: clipSpans(e, 2000, 5000), edits: e }
    })
    expect(graph(args)).not.toContain('boxblur')
  })
  it('makes a GIF in two passes: a palette, then the frames drawn with it', () => {
    const gif = { ...base, kind: 'gif' as const, outputPath: '/w/clip.gif' }
    const p1 = buildClipArgs(gif, 'palette')
    expect(graph(p1)).toContain(
      `fps=${CLIP_LIMITS.gifFps},scale=640:360:flags=lanczos,palettegen=stats_mode=diff[pal]`
    )
    expect(p1.slice(-1)).toEqual(['/w/palette.png'])
    expect(graph(p1)).not.toContain('[0:a]') // GIFs are silent
    const p2 = buildClipArgs(gif, 'encode')
    expect(p2.filter((a) => a === '-i')).toHaveLength(2)
    expect(p2[p2.lastIndexOf('-i') + 1]).toBe('/w/palette.png')
    expect(graph(p2)).toContain(
      '[vg][1:v]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle[gif]'
    )
    expect(p2.slice(-4)).toEqual(['-loop', '0', '-f', 'gif', '/w/clip.gif'].slice(1))
  })
  it('refuses a GIF without a pass, and a container ffmpeg would have to guess', () => {
    expect(() => buildClipArgs({ ...base, kind: 'gif' })).toThrow(/pass/)
    expect(() => buildClipArgs({ ...base, inputMime: 'video/quicktime' })).toThrow(/Unsupported/)
    expect(() => buildClipArgs({ ...base, cut: { from: 'source', spans: [], edits } })).toThrow(
      /covers nothing/
    )
  })
})
