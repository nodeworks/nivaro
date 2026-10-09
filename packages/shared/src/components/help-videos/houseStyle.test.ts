import { describe, expect, it } from 'vitest'
import { calloutTextOf, captionLookOf, setCalloutText, setCaptionLook } from './edits'
import {
  applyHouseStyle,
  HOUSE_STYLE_DEFAULTS,
  type HouseStyle,
  houseStyleChanges
} from './houseStyle'
import type { Annotation, VideoEdits } from './types'
import { captionPrefsAfter, captionStyleFrom } from './viewer/moments'

// #1551 — the editor's half of the house style: "Apply house style" on an
// existing video, and the two video-wide keys it added.

const ann = (id: string, type: Annotation['type'], tone: Annotation['tone']): Annotation => ({
  id,
  type,
  start_ms: 0,
  end_ms: 1000,
  rect: { x: 0.1, y: 0.1, w: 0.2, h: 0.1 },
  to: type === 'arrow' ? { x: 0.5, y: 0.5 } : null,
  text: '',
  tone
})
const video = (extra: Partial<VideoEdits> = {}): VideoEdits => ({
  v: 1,
  segments: [{ start_ms: 0, end_ms: 10_000, speed: 1 }],
  poster_ms: 0,
  chapters: [],
  annotations: [],
  zooms: [],
  blurs: [],
  captions: [],
  ...extra
})
const house = (patch: Partial<HouseStyle>): HouseStyle => ({ ...HOUSE_STYLE_DEFAULTS, ...patch })

describe('video-wide callout text and caption look', () => {
  it('stores nothing for the defaults', () => {
    const e = video()
    expect(setCalloutText(setCalloutText(e, 'large'), 'medium')).toEqual(e)
    expect(setCaptionLook(setCaptionLook(e, { size: 'xl' }), { size: 'm' })).toEqual(e)
  })
  it('keeps only the keys that differ', () => {
    const e = setCaptionLook(video(), { size: 'l', background: 'shaded', position: 'top' })
    expect(e.caption_style).toEqual({ size: 'l', position: 'top' })
    expect(captionLookOf(e)).toEqual({ size: 'l', background: 'shaded', position: 'top' })
    expect(calloutTextOf(setCalloutText(e, 'small'))).toBe('small')
  })
})

describe('applyHouseStyle', () => {
  it('changes nothing on a plain video when the house style is the defaults', () => {
    const e = video({ annotations: [ann('a', 'callout', 'accent')] })
    expect(applyHouseStyle(e, HOUSE_STYLE_DEFAULTS)).toEqual(e)
    expect(houseStyleChanges(e, HOUSE_STYLE_DEFAULTS)).toEqual([])
  })

  it("rewrites the video's own choices to the house values", () => {
    const e = video({
      annotations: [
        ann('a', 'callout', 'accent'),
        ann('b', 'step', 'warning'),
        ann('c', 'spotlight', 'accent')
      ],
      step_style: { shape: 'square', size: 'large' },
      audio: { improve: true },
      callout_text: 'small',
      caption_style: { position: 'top' }
    })
    const s = house({
      callout_tone: 'neutral',
      callout_text: 'large',
      caption_style: { size: 'xl', background: 'solid', position: 'bottom' },
      improve_audio: false
    })
    const out = applyHouseStyle(e, s)
    expect(out.annotations.map((a) => a.tone)).toEqual(['neutral', 'neutral', 'accent'])
    expect(out.step_style).toBeUndefined()
    expect(out.audio).toBeUndefined()
    expect(out.callout_text).toBe('large')
    expect(out.caption_style).toEqual({ size: 'xl', background: 'solid' })
    const lines = houseStyleChanges(e, s)
    expect(lines).toContain('2 callouts, steps, boxes and arrows turn dark')
    expect(lines).toContain('Callout text: large')
    expect(lines).toContain('Step badges: circle, medium')
    expect(lines).toContain('Improve audio turns off')
    expect(houseStyleChanges(out, s)).toEqual([])
  })

  it('turns on house cards keeping the card text the video has', () => {
    const e = video({
      intro: {
        enabled: true,
        duration_ms: 5000,
        show_chapters: false,
        title: 'Mine',
        subtitle: ''
      },
      outro: { enabled: true, duration_ms: 3000, text: 'My end' }
    })
    const s = house({
      intro: {
        ...HOUSE_STYLE_DEFAULTS.intro,
        enabled: true,
        duration_ms: 2000,
        show_chapters: true
      },
      outro: { ...HOUSE_STYLE_DEFAULTS.outro, enabled: true, text: 'House end', transition: 'cut' }
    })
    const out = applyHouseStyle(e, s)
    expect(out.intro).toEqual({
      enabled: true,
      duration_ms: 2000,
      show_chapters: true,
      title: 'Mine',
      subtitle: '',
      animation: 'subtle',
      transition: 'fade'
    })
    expect(out.outro?.text).toBe('My end')
    expect(out.outro?.transition).toBeUndefined()
  })

  it('gives a new end card the house text, and never removes a card the house leaves off', () => {
    const withIntro = video({
      intro: { enabled: true, duration_ms: 3000, show_chapters: false, title: '', subtitle: '' }
    })
    const s = house({ outro: { ...HOUSE_STYLE_DEFAULTS.outro, enabled: true, text: 'Ask us' } })
    const out = applyHouseStyle(withIntro, s)
    expect(out.intro).toEqual(withIntro.intro)
    expect(out.outro?.text).toBe('Ask us')
    expect(houseStyleChanges(withIntro, s)[0]).toMatch(/^End card turns on: 3 s.*“Ask us”$/)
  })
})

describe('caption look: the viewer over the video', () => {
  const base = { size: 'l', background: 'solid', position: 'top' } as const
  it("follows the video's look for keys the viewer never set", () => {
    expect(captionStyleFrom({ help_video_captions: { size: 's' } }, base)).toEqual({
      ...base,
      size: 's'
    })
    expect(captionStyleFrom(null, base)).toEqual(base)
  })
  it('stores a change the viewer makes even when it is the default', () => {
    const cur = captionStyleFrom(null, base)
    expect(captionPrefsAfter(null, cur, { ...cur, size: 'm' }, base)).toEqual({ size: 'm' })
  })
  it('keeps what the viewer set before', () => {
    const prefs = { help_video_captions: { background: 'none' } }
    const cur = captionStyleFrom(prefs, base)
    expect(captionPrefsAfter(prefs, cur, { ...cur, position: 'bottom' }, base)).toEqual({
      background: 'none',
      position: 'bottom'
    })
  })
  it('on a plain video, going back to the default stores nothing', () => {
    const prefs = { help_video_captions: { size: 'l' } }
    const cur = captionStyleFrom(prefs)
    expect(captionPrefsAfter(prefs, cur, { ...cur, size: 'm' })).toBeNull()
  })
})
