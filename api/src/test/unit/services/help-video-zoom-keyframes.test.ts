import { describe, expect, it } from 'vitest'
import {
  EDIT_LIMITS,
  hashEdits,
  normalizeEdits,
  normalizeZoomKeyframes,
  type VideoEdits,
  viewAt,
  zoomAt,
  zoomRectAt
} from '../../../services/help-video-edits.js'
import {
  buildRenderArgs,
  graphPath,
  lerpChain,
  zoomMotionExprs
} from '../../../services/help-video-render-plan.js'

// Moving zooms (#1539): stops stored beside the zoom's area, blended
// straight-line in the player and the render.

const SRC = 20_000
const sq = (x: number, y: number, w = 0.5) => ({ x, y, w, h: w })
const base = {
  width: 1280,
  height: 720,
  hasAudio: false,
  sourcePath: 'in.webm',
  sourceMime: 'video/webm',
  overlays: [],
  outputPath: 'out.mp4',
  threads: 2
}
const fc = (args: string[]) => args[args.indexOf('-filter_complex') + 1]

describe('normalizeEdits with zoom keyframes', () => {
  it('stores sorted stops inside the span, the area being the first stop', () => {
    const e = normalizeEdits(
      {
        zooms: [
          {
            id: 'z1',
            start_ms: 1000,
            end_ms: 5000,
            rect: sq(0, 0, 0.3),
            keyframes: [
              { at_ms: 4000, rect: sq(0.5, 0.5) },
              { at_ms: 500, rect: sq(0.1, 0.1) },
              { at_ms: 9000, rect: sq(0.2, 0.2, 0.5) }
            ]
          }
        ]
      },
      SRC
    )
    const z = e.zooms[0]
    expect(z.keyframes).toEqual([
      { at_ms: 1000, rect: sq(0.1, 0.1) },
      { at_ms: 4000, rect: sq(0.5, 0.5) },
      { at_ms: 5000, rect: sq(0.2, 0.2) }
    ])
    // `rect` is the first stop, so an older reader shows the zoom's start.
    expect(z.rect).toEqual(sq(0.1, 0.1))
  })
  it('keeps the first of two stops at one moment and squares their areas', () => {
    const k = normalizeZoomKeyframes(
      [
        { at_ms: 2000, rect: { x: 0.9, y: 0.9, w: 0.1, h: 0.1 } },
        { at_ms: 2000, rect: sq(0.2, 0.2) },
        { at_ms: 3000, rect: { x: 0, y: 0, w: 0.4, h: 0.2 } }
      ],
      { start_ms: 0, end_ms: 5000 }
    )
    expect(k).toEqual([
      { at_ms: 2000, rect: sq(0.75, 0.75, 0.25) },
      { at_ms: 3000, rect: sq(0, 0, 0.4) }
    ])
  })
  it('drops a single stop: that is a still zoom with its own area', () => {
    const e = normalizeEdits(
      {
        zooms: [
          {
            start_ms: 0,
            end_ms: 4000,
            rect: sq(0.1, 0.1),
            keyframes: [{ at_ms: 2000, rect: sq(0.4, 0.4) }]
          }
        ]
      },
      SRC
    )
    expect(e.zooms[0].keyframes).toBeUndefined()
    expect(e.zooms[0].rect).toEqual(sq(0.1, 0.1))
    expect(normalizeZoomKeyframes([], { start_ms: 0, end_ms: 1 })).toBeNull()
    expect(normalizeZoomKeyframes('nope', { start_ms: 0, end_ms: 1 })).toBeNull()
  })
  it('caps the stops per zoom and over the video', () => {
    const many = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ at_ms: i * 10, rect: sq(0.01 * i, 0) }))
    expect(normalizeZoomKeyframes(many(100), { start_ms: 0, end_ms: 5000 })).toHaveLength(
      EDIT_LIMITS.zoomKeyframes
    )
    expect(normalizeZoomKeyframes(many(100), { start_ms: 0, end_ms: 5000 }, 5)).toHaveLength(5)
    expect(normalizeZoomKeyframes(many(100), { start_ms: 0, end_ms: 5000 }, 1)).toBeNull()
    // The video's budget: later zooms get what is left, then stay still.
    const per = EDIT_LIMITS.zoomKeyframes
    const zooms = Array.from({ length: 10 }, (_, i) => ({
      start_ms: i * 1000,
      end_ms: i * 1000 + 900,
      rect: sq(0, 0),
      keyframes: many(per).map((k) => ({ ...k, at_ms: i * 1000 + k.at_ms }))
    }))
    const e = normalizeEdits({ zooms }, SRC)
    const total = e.zooms.reduce((t, z) => t + (z.keyframes?.length ?? 0), 0)
    expect(total).toBeLessThanOrEqual(EDIT_LIMITS.zoomKeyframesTotal)
    expect(e.zooms[0].keyframes).toHaveLength(per)
    expect(e.zooms[9].keyframes).toBeUndefined()
  })
  it('leaves a video without moving zooms byte-identical (no re-render)', () => {
    const raw = {
      zooms: [{ id: 'z1', start_ms: 1000, end_ms: 5000, rect: sq(0.2, 0.2), ease_ms: 300 }]
    }
    const before = normalizeEdits(raw, SRC)
    expect(JSON.stringify(before.zooms[0])).toBe(
      '{"id":"z1","start_ms":1000,"end_ms":5000,"rect":{"x":0.2,"y":0.2,"w":0.5,"h":0.5},"ease_ms":300}'
    )
    expect(hashEdits(normalizeEdits(JSON.parse(JSON.stringify(before)), SRC))).toBe(
      hashEdits(before)
    )
    expect(fc(buildRenderArgs({ ...base, edits: before }))).not.toContain('ld(0)')
  })
})

const moving = (): VideoEdits =>
  normalizeEdits(
    {
      zooms: [
        {
          id: 'z1',
          start_ms: 1000,
          end_ms: 5000,
          rect: sq(0, 0),
          ease_ms: 0,
          keyframes: [
            { at_ms: 2000, rect: sq(0, 0) },
            { at_ms: 4000, rect: sq(0.4, 0.2) }
          ]
        }
      ]
    },
    SRC
  )

describe('zoomRectAt / zoomAt / viewAt', () => {
  it('holds the first stop before it, blends between, holds the last after', () => {
    const z = moving().zooms[0]
    expect(zoomRectAt(z, 1000)).toEqual(sq(0, 0))
    expect(zoomRectAt(z, 2000)).toEqual(sq(0, 0))
    expect(zoomRectAt(z, 3000)).toEqual(sq(0.2, 0.1))
    expect(zoomRectAt(z, 4500)).toEqual(sq(0.4, 0.2))
  })
  it('is the zoom itself for a still zoom', () => {
    const z = normalizeEdits({ zooms: [{ start_ms: 0, end_ms: 1000, rect: sq(0.3, 0.3) }] }, SRC)
      .zooms[0]
    expect(zoomRectAt(z, 500)).toBe(z.rect)
  })
  it('zoomAt follows the blended area, like the player', () => {
    const e = moving()
    // At 3 s the area is (0.2,0.1,0.5): 2x, centred at (0.45,0.35).
    const v = zoomAt(e, 3000)
    expect(v.z).toBeCloseTo(2)
    expect(v.tx).toBeCloseTo(0.5 - 0.45 * 2)
    expect(v.ty).toBeCloseTo(0.5 - 0.35 * 2)
    expect(zoomAt(e, 500)).toEqual({ z: 1, tx: 0, ty: 0 })
    expect(viewAt(e, 500)).toEqual({ z: 1, sx: 1, sy: 1, ox: 0, oy: 0 })
  })
  it('viewAt applies the crop first', () => {
    const e = normalizeEdits({ crop: { x: 0.25, y: 0.25, w: 0.5, h: 0.5 } }, SRC)
    const v = viewAt(e, 0)
    // The crop's own top-left lands at 0 and its far corner at 1.
    expect(0.25 * v.sx + v.ox).toBeCloseTo(0)
    expect(0.75 * v.sx + v.ox).toBeCloseTo(1)
  })
})

describe('render plan for moving zooms', () => {
  it('lerpChain: a constant when every stop agrees, else if(lt(t,…)) pieces', () => {
    expect(
      lerpChain([
        { t_ms: 1000, v: 0.5 },
        { t_ms: 2000, v: 0.5 }
      ])
    ).toBe('0.5000')
    expect(
      lerpChain([
        { t_ms: 1000, v: 0 },
        { t_ms: 2000, v: 1 },
        { t_ms: 3000, v: 0.5 }
      ])
    ).toBe(
      'if(lt(t,1.000),0.0000,if(lt(t,2.000),0.0000+(1.0000)*(t-1.000)/1.000,if(lt(t,3.000),1.0000+(-0.5000)*(t-2.000)/1.000,0.5000)))'
    )
  })
  it('zoomMotionExprs: a still zoom gives the constants the graph always had', () => {
    const e = normalizeEdits({ zooms: [{ start_ms: 0, end_ms: 1000, rect: sq(0.5, 0.5) }] }, SRC)
    expect(zoomMotionExprs(e, e.zooms[0])).toEqual({ mag: '1.0000', cx: '0.2500', cy: '0.2500' })
  })
  it('zoomMotionExprs: a pan keeps a constant magnification and chains the centre', () => {
    const e = moving()
    const m = zoomMotionExprs(e, e.zooms[0])
    expect(m.mag).toBe('1.0000')
    expect(m.cx).toBe(
      'if(lt(t,2.000),0.2500,if(lt(t,4.000),0.2500+(0.4000)*(t-2.000)/2.000,0.6500))-0.5'
    )
    expect(m.cy).toBe(
      'if(lt(t,2.000),0.2500,if(lt(t,4.000),0.2500+(0.2000)*(t-2.000)/2.000,0.4500))-0.5'
    )
  })
  it('zoomMotionExprs: a resize follows the blended side, never below 1x', () => {
    const e = normalizeEdits(
      {
        zooms: [
          {
            start_ms: 0,
            end_ms: 4000,
            rect: sq(0, 0),
            keyframes: [
              { at_ms: 0, rect: sq(0, 0, 0.5) },
              { at_ms: 4000, rect: sq(0, 0, 1) }
            ]
          }
        ]
      },
      SRC
    )
    const m = zoomMotionExprs(e, e.zooms[0])
    expect(m.mag).toBe(
      'max(1,1.0000/(if(lt(t,0.000),0.5000,if(lt(t,4.000),0.5000+(0.5000)*(t-0.000)/4.000,1.0000))))-1'
    )
  })
  it('stores Z once per crop offset (st/ld) and keeps the scale per frame', () => {
    const graph = fc(buildRenderArgs({ ...base, edits: moving() }))
    expect(graph).toContain('eval=frame')
    expect(graph).toMatch(/x='st\(0,\(1\+\(1\.0000\)\*between\(t,1\.000,5\.000\)\)\);max\(0,min\(/)
    expect(graph).toContain('*(1280*ld(0))-1280/2,1280*ld(0)-1280))')
    expect(graph).toContain('*(720*ld(0))-720/2,720*ld(0)-720))')
    expect(graph).toContain('if(lt(t,2.000),0.2500,if(lt(t,4.000)')
    // Nothing else in the graph: no cursor without one.
    expect(graph).not.toContain('ass=')
  })
  it('burns the cursor file in after the zoom and before the cuts', () => {
    const edits = normalizeEdits(
      {
        segments: [{ start_ms: 1000, end_ms: 9000, speed: 2 }],
        zooms: [{ start_ms: 2000, end_ms: 4000, rect: sq(0.5, 0.5) }]
      },
      SRC
    )
    const graph = fc(buildRenderArgs({ ...base, edits, cursor: { assPath: '/w/r/cursor.ass' } }))
    const zoomAtIdx = graph.indexOf('crop=1280:720:')
    const ass = graph.indexOf('ass=filename=/w/r/cursor.ass')
    const trim = graph.indexOf('trim=start=')
    expect(ass).toBeGreaterThan(zoomAtIdx)
    expect(trim).toBeGreaterThan(ass)
  })
  it('graphPath escapes for the option parser and then the graph parser', () => {
    expect(graphPath('/tmp/nivaro-video/render/abc-1/cursor.ass')).toBe(
      '/tmp/nivaro-video/render/abc-1/cursor.ass'
    )
    expect(graphPath("C:/a'b,c;d.ass")).toBe("C\\\\:/a\\\\\\'b\\,c\\;d.ass")
  })
})
