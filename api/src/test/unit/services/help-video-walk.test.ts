import { describe, expect, it } from 'vitest'
import { emptyEdits, type VideoEdits } from '../../../services/help-video-edits.js'
import {
  buildWalkSteps,
  CLICK_LIMITS,
  normalizeClicks,
  normalizeLevels
} from '../../../services/help-video-walk.js'

const edits = (over: Partial<VideoEdits> = {}): VideoEdits => ({ ...emptyEdits(60_000), ...over })

const note = (start: number, end: number, txt: string, x = 0.5, type = 'callout') => ({
  id: `a${start}`,
  type: type as 'callout',
  start_ms: start,
  end_ms: end,
  rect: { x, y: 0.1, w: 0.1, h: 0.05 },
  to: null,
  text: txt,
  tone: 'accent' as const
})

describe('normalizeClicks', () => {
  it('keeps null as null and drops what is not a click', () => {
    expect(normalizeClicks(null)).toBeNull()
    expect(normalizeClicks('x')).toBeNull()
    expect(normalizeClicks([null, 3, { t_ms: 'a', x: 0, y: 0 }, { t_ms: -1, x: 0, y: 0 }])).toEqual(
      []
    )
  })

  it('clamps, sorts and checks every target field', () => {
    const out = normalizeClicks([
      { t_ms: 2000.4, x: 2, y: -1 },
      {
        t_ms: 1000,
        x: 0.123456,
        y: 0.5,
        label: `  Save   ${'x'.repeat(200)}`,
        role: 'button',
        hook: 'data-hv-pick=abc',
        page_key: 'records.forecasts',
        path: '/collections/workflows/12?search=secret#x',
        origin: 'https://efp.example.com'
      },
      {
        t_ms: 1500,
        x: 0,
        y: 0,
        role: 'Button<',
        hook: 'onclick=x',
        page_key: 'a b',
        path: '//evil',
        origin: 'javascript:alert(1)'
      }
    ]) as NonNullable<ReturnType<typeof normalizeClicks>>
    expect(out.map((c) => c.t_ms)).toEqual([1000, 1500, 2000])
    expect(out[0].x).toBe(0.1235)
    expect(out[0].label?.length).toBeLessThanOrEqual(CLICK_LIMITS.label)
    expect(out[0].label?.startsWith('Save x')).toBe(true)
    expect(out[0]).toMatchObject({
      role: 'button',
      hook: 'data-hv-pick=abc',
      page_key: 'records.forecasts',
      path: '/collections/workflows/12',
      origin: 'https://efp.example.com'
    })
    expect(out[1]).toEqual({ t_ms: 1500, x: 0, y: 0 })
    expect(out[2]).toMatchObject({ x: 1, y: 0 })
  })

  it('refuses a hook value carrying a quote and caps the count', () => {
    expect(normalizeClicks([{ t_ms: 0, x: 0, y: 0, hook: 'data-x="a"' }])?.[0].hook).toBeUndefined()
    const many = Array.from({ length: CLICK_LIMITS.clicks + 50 }, (_, i) => ({
      t_ms: i,
      x: 0,
      y: 0
    }))
    expect(normalizeClicks(many)?.length).toBe(CLICK_LIMITS.clicks)
  })
})

describe('normalizeLevels', () => {
  it('clamps to 0–1 with two decimals', () => {
    expect(normalizeLevels([0.123, 4, -1, 'x'])).toEqual([0.12, 1, 0, 0])
    expect(normalizeLevels(undefined)).toBeNull()
  })
})

describe('buildWalkSteps', () => {
  const clicks = [
    { t_ms: 1000, x: 0.5, y: 0.1, label: 'Open record', role: 'link', path: '/collections/a' },
    { t_ms: 1200, x: 0.5, y: 0.1 },
    { t_ms: 1400, x: 0.5, y: 0.1, label: 'Open record', role: 'link' },
    { t_ms: 20_000, x: 0.2, y: 0.2, label: 'Inside the cut', role: 'button' },
    { t_ms: 40_000, x: 0.8, y: 0.8, label: 'Approve', role: 'button', hook: 'data-approve' }
  ]

  it('keeps labelled clicks viewers see, in order, folding a quick repeat', () => {
    const e = edits({
      segments: [
        { start_ms: 0, end_ms: 10_000, speed: 1 },
        { start_ms: 30_000, end_ms: 60_000, speed: 2 }
      ]
    })
    const steps = buildWalkSteps(e, clicks)
    expect(steps.map((s) => s.label)).toEqual(['Open record', 'Approve'])
    expect(steps[0]).toMatchObject({ role: 'link', path: '/collections/a', edited_ms: 1000 })
    // 10 s kept, then (40 − 30) / 2 = 5 s into the 2× piece.
    expect(steps[1]).toMatchObject({ edited_ms: 15_000, hook: 'data-approve', text: null })
  })

  it('takes the nearest callout or box within two seconds as the step text', () => {
    const e = edits({
      annotations: [
        note(37_000, 37_500, 'Too early'),
        note(41_500, 43_000, 'Press Approve to send it on', 0.8, 'box'),
        note(39_000, 39_800, ''),
        { ...note(40_000, 40_500, 'An arrow'), type: 'arrow' }
      ]
    })
    const steps = buildWalkSteps(e, clicks)
    expect(steps.find((s) => s.label === 'Approve')?.text).toBe('Press Approve to send it on')
    expect(steps.find((s) => s.label === 'Open record')?.text).toBeNull()
  })

  it('prefers a callout showing at the click over a nearby one', () => {
    const e = edits({
      annotations: [note(1500, 2500, 'Next one'), note(500, 1100, 'Open the record first')]
    })
    expect(buildWalkSteps(e, clicks)[0].text).toBe('Open the record first')
  })

  it('gives a callout to one click only, the nearest', () => {
    const e = edits({ annotations: [note(38_000, 40_500, 'Approve sends it on', 0.8)] })
    const two = [
      { t_ms: 40_000, x: 0.8, y: 0.8, label: 'Approve', role: 'button' },
      { t_ms: 40_600, x: 0.2, y: 0.2, label: 'Close', role: 'button' }
    ]
    const steps = buildWalkSteps(e, two)
    expect(steps.map((s) => s.text)).toEqual(['Approve sends it on', null])
  })

  it('has no steps without labelled clicks', () => {
    expect(buildWalkSteps(edits(), null)).toEqual([])
    expect(buildWalkSteps(edits(), [{ t_ms: 1, x: 0, y: 0 }])).toEqual([])
  })
})
