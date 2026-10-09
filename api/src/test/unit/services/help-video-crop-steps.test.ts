import { describe, expect, it } from 'vitest'
import { drawOrder } from '../../../services/help-video-annotations.js'
import {
  type Annotation,
  editedDuration,
  hashEdits,
  normalizeEdits,
  STEP_STYLE_DEFAULTS,
  stepNumbers,
  stepStyleOf,
  type VideoEdits,
  zoomInView
} from '../../../services/help-video-edits.js'
import { buildRenderArgs, renderSizes } from '../../../services/help-video-render-plan.js'
import { viewerMayPlaySource } from '../../../services/help-video-views.js'

// Slow motion (#1538), crop (#1544), numbered steps and spotlight (#1524).

const SRC = 10_000
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
const ann = (id: string, type: Annotation['type'], start: number, y = 0.1): unknown => ({
  id,
  type,
  start_ms: start,
  end_ms: start + 1000,
  rect: { x: 0.1, y, w: 0.2, h: 0.1 },
  text: 'Do this',
  tone: 'accent'
})

describe('slow motion', () => {
  it('keeps 0.5x and doubles the piece in edited time', () => {
    const e = normalizeEdits({ segments: [{ start_ms: 0, end_ms: SRC, speed: 0.5 }] }, SRC)
    expect(e.segments[0].speed).toBe(0.5)
    expect(editedDuration(e)).toBe(20_000)
  })
  it('slows the picture with setpts and keeps the pitch with atempo=0.5', () => {
    const e = normalizeEdits(
      {
        segments: [
          { start_ms: 0, end_ms: 4000, speed: 1 },
          { start_ms: 4000, end_ms: SRC, speed: 0.5 }
        ]
      },
      SRC
    )
    const g = fc(buildRenderArgs({ ...base, edits: e }))
    expect(g).toContain('setpts=(PTS-STARTPTS)/0.5[c1]')
    expect(g).toContain('atempo=0.5[ca1]')
  })
})

describe('crop', () => {
  it('is stored only when smaller than the whole frame', () => {
    const plain = normalizeEdits({}, SRC)
    expect(normalizeEdits({ crop: { x: 0, y: 0, w: 1, h: 1 } }, SRC)).toEqual(plain)
    expect(hashEdits(normalizeEdits({ crop: null }, SRC))).toBe(hashEdits(plain))
    const e = normalizeEdits({ crop: { x: 0.2, y: 0, w: 0.8, h: 1 } }, SRC)
    expect(e.crop).toEqual({ x: 0.2, y: 0, w: 0.8, h: 1 })
  })
  it('keeps a crop inside the frame and at least the smallest side', () => {
    const e = normalizeEdits({ crop: { x: 0.95, y: -1, w: 0.05, h: 0.5 } }, SRC)
    expect(e.crop).toEqual({ x: 0.8, y: 0, w: 0.2, h: 0.5 })
  })
  it('sizes the work frame so the cropped part comes out at most 1920x1080', () => {
    expect(renderSizes(1280, 720, null)).toEqual({
      work: { width: 1280, height: 720 },
      out: { width: 1280, height: 720 },
      crop: null
    })
    // 1920x1440 of a 2560x1440 recording: the height decides (0.75x).
    const s = renderSizes(2560, 1440, { x: 0.25, y: 0, w: 0.75, h: 1 })
    expect(s.work).toEqual({ width: 1920, height: 1080 })
    expect(s.out).toEqual({ width: 1440, height: 1080 })
    expect(s.crop).toEqual({ x: 480, y: 0, w: 1440, h: 1080 })
    // A small crop is never enlarged: the recording keeps its own size.
    const small = renderSizes(1280, 720, { x: 0, y: 0, w: 0.5, h: 0.5 })
    expect(small.work).toEqual({ width: 1280, height: 720 })
    expect(small.out).toEqual({ width: 640, height: 360 })
  })
  it('crops after blur and annotations, before the zoom', () => {
    const e = normalizeEdits(
      {
        crop: { x: 0.25, y: 0, w: 0.5, h: 1 },
        blurs: [{ start_ms: 0, end_ms: 2000, rect: { x: 0, y: 0, w: 0.1, h: 0.1 }, strength: 8 }],
        zooms: [{ start_ms: 0, end_ms: 2000, rect: { x: 0.25, y: 0, w: 0.5, h: 0.5 } }]
      },
      SRC
    )
    const g = fc(buildRenderArgs({ ...base, edits: e }))
    expect(g.startsWith('[0:v]scale=1280:720,')).toBe(true)
    const cropAt = g.indexOf('crop=640:720:320:0')
    expect(cropAt).toBeGreaterThan(g.indexOf('boxblur'))
    expect(g.indexOf("scale=w='trunc(640")).toBeGreaterThan(cropAt)
  })
  it('maps a zoom into the cropped picture (unchanged without a crop)', () => {
    const rect = { x: 0.5, y: 0.5, w: 0.5, h: 0.5 }
    const plain = normalizeEdits({}, SRC)
    expect(zoomInView(plain, rect)).toEqual({ mag: 2, cx: 0.75, cy: 0.75 })
    const cropped = normalizeEdits({ crop: { x: 0.5, y: 0, w: 0.5, h: 1 } }, SRC)
    // A zoom as wide as the crop magnifies by the height it leaves out.
    expect(zoomInView(cropped, rect)).toEqual({ mag: 1, cx: 0.5, cy: 0.75 })
  })
  it('makes viewers wait for the render', () => {
    const edits = JSON.stringify({ crop: { x: 0.1, y: 0, w: 0.9, h: 1 } })
    expect(viewerMayPlaySource(edits, SRC)).toBe(false)
    expect(viewerMayPlaySource('{}', SRC)).toBe(true)
  })
})

describe('steps and spotlight', () => {
  it('keeps step text and drops spotlight text', () => {
    const e = normalizeEdits({ annotations: [ann('s', 'step', 0), ann('p', 'spotlight', 0)] }, SRC)
    expect(e.annotations.map((a) => [a.type, a.text])).toEqual([
      ['step', 'Do this'],
      ['spotlight', '']
    ])
  })
  it('numbers steps in timeline order, skipping ones inside a cut', () => {
    const e = normalizeEdits(
      {
        segments: [
          { start_ms: 0, end_ms: 5000, speed: 1 },
          { start_ms: 7000, end_ms: SRC, speed: 1 }
        ],
        annotations: [
          ann('late', 'step', 8000),
          ann('cut', 'step', 5500),
          ann('low', 'step', 1000, 0.6),
          ann('high', 'step', 1000, 0.2),
          ann('c', 'callout', 500)
        ]
      },
      SRC
    )
    expect([...stepNumbers(e)]).toEqual([
      ['high', 1],
      ['low', 2],
      ['late', 3]
    ])
  })
  it('stores the step style only when it is not the default', () => {
    expect(normalizeEdits({ step_style: STEP_STYLE_DEFAULTS }, SRC).step_style).toBeUndefined()
    const e = normalizeEdits({ step_style: { shape: 'square', size: 'huge' } }, SRC)
    expect(e.step_style).toEqual({ shape: 'square', size: 'medium' })
    expect(stepStyleOf(normalizeEdits({}, SRC))).toEqual(STEP_STYLE_DEFAULTS)
  })
  it('draws spotlights under every other annotation', () => {
    const e = normalizeEdits(
      { annotations: [ann('a', 'callout', 0), ann('s', 'spotlight', 0), ann('b', 'step', 0)] },
      SRC
    )
    expect(drawOrder(e.annotations).map((a) => a.id)).toEqual(['s', 'a', 'b'])
  })
  it('makes viewers wait for a step, not for a spotlight', () => {
    const step = JSON.stringify({ annotations: [ann('s', 'step', 0)] })
    const spot = JSON.stringify({ annotations: [ann('p', 'spotlight', 0)] })
    expect(viewerMayPlaySource(step, SRC)).toBe(false)
    expect(viewerMayPlaySource(spot, SRC)).toBe(true)
  })
  it('leaves old edits and their hash as they were', () => {
    const old: VideoEdits = normalizeEdits(
      { annotations: [ann('c', 'callout', 0)], segments: [{ start_ms: 0, end_ms: SRC, speed: 2 }] },
      SRC
    )
    expect(Object.keys(old).sort()).toEqual(
      ['annotations', 'blurs', 'captions', 'chapters', 'poster_ms', 'segments', 'v', 'zooms'].sort()
    )
    expect(hashEdits(normalizeEdits(JSON.parse(JSON.stringify(old)), SRC))).toBe(hashEdits(old))
  })
})
