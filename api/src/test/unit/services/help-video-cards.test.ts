import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { accentOnDark, inkOnAccent } from '../../../services/help-video-card-design.js'
import {
  bannerTree,
  type CardNode,
  cardAccent,
  cardText,
  firstLine,
  introTree,
  outroTree,
  planCardFrames,
  shownBrand
} from '../../../services/help-video-cards.js'
import {
  bodyDuration,
  captionsToVtt,
  cardPhaseAt,
  chapterBannerWindows,
  EDIT_LIMITS,
  editedDuration,
  editedSpanToSource,
  editedToSource,
  hashEdits,
  normalizeEdits,
  OUTRO_DEFAULT_TEXT,
  posterEditedMs,
  sourceToEdited
} from '../../../services/help-video-edits.js'
import { buildRenderArgs } from '../../../services/help-video-render-plan.js'
import { viewerMayPlaySource } from '../../../services/help-video-views.js'

const SRC = 20_000
const fc = (args: string[]) => args[args.indexOf('-filter_complex') + 1]
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

describe('cards in the stored edits', () => {
  it('adds no keys when the cards are absent (existing hashes stay the same)', () => {
    const stored = {
      v: 1,
      segments: [{ start_ms: 0, end_ms: SRC, speed: 1 }],
      poster_ms: 0,
      chapters: [],
      annotations: [],
      zooms: [],
      blurs: [],
      captions: []
    }
    const e = normalizeEdits(stored, SRC)
    expect(Object.keys(e).sort()).toEqual(Object.keys(stored).sort())
    expect(hashEdits(e)).toBe(hashEdits(normalizeEdits(stored, SRC)))
    expect('intro' in e || 'outro' in e || 'chapter_banners' in e).toBe(false)
  })
  it('drops cards that are switched off and banners that are false', () => {
    const e = normalizeEdits(
      {
        intro: { enabled: false, duration_ms: 4000 },
        outro: { duration_ms: 3000 },
        chapter_banners: false
      },
      SRC
    )
    expect('intro' in e || 'outro' in e || 'chapter_banners' in e).toBe(false)
  })
  it('clamps card lengths to 2–6 s and caps the text', () => {
    const e = normalizeEdits(
      {
        intro: {
          enabled: true,
          duration_ms: 99_000,
          show_chapters: 'yes',
          title: `  ${'T'.repeat(300)}  `,
          subtitle: 'line one\n  line two'
        },
        outro: { enabled: true, duration_ms: 10, text: '' },
        chapter_banners: true
      },
      SRC
    )
    expect(e.intro).toEqual({
      enabled: true,
      duration_ms: EDIT_LIMITS.cardMaxMs,
      show_chapters: false,
      title: 'T'.repeat(EDIT_LIMITS.introTitle),
      subtitle: 'line one line two'
    })
    expect(e.outro).toEqual({ enabled: true, duration_ms: EDIT_LIMITS.cardMinMs, text: '' })
    expect(e.chapter_banners).toBe(true)
    const d = normalizeEdits({ intro: { enabled: true } }, SRC)
    expect(d.intro?.duration_ms).toBe(EDIT_LIMITS.cardDefaultMs)
  })
  it('makes the original recording unplayable for viewers', () => {
    expect(viewerMayPlaySource(JSON.stringify({}), SRC)).toBe(true)
    for (const extra of [
      { intro: { enabled: true } },
      { outro: { enabled: true } },
      { chapter_banners: true }
    ]) {
      expect(viewerMayPlaySource(JSON.stringify(extra), SRC)).toBe(false)
    }
  })
})

describe('time mapping with cards', () => {
  // Kept: 0–4 s at 1x, then 10–18 s at 2x (4 s). Intro 3 s, outro 2 s.
  const e = normalizeEdits(
    {
      segments: [
        { start_ms: 0, end_ms: 4000, speed: 1 },
        { start_ms: 10_000, end_ms: 18_000, speed: 2 }
      ],
      intro: { enabled: true, duration_ms: 3000 },
      outro: { enabled: true, duration_ms: 2000 },
      chapters: [
        { id: 'a', at_ms: 0, title: 'Start' },
        { id: 'b', at_ms: 1000, title: 'Close by' },
        { id: 'c', at_ms: 6000, title: 'Cut away' },
        { id: 'd', at_ms: 16_000, title: 'Late' }
      ],
      captions: [{ id: 'x', start_ms: 1000, end_ms: 2000, text: 'Hello' }],
      chapter_banners: true
    },
    SRC
  )
  it('adds the card lengths to the edited duration', () => {
    expect(bodyDuration(e)).toBe(8000)
    expect(editedDuration(e)).toBe(13_000)
  })
  it('shifts source moments by the intro', () => {
    expect(sourceToEdited(e, 0)).toBe(3000)
    expect(sourceToEdited(e, 12_000)).toBe(8000)
    expect(sourceToEdited(e, 6000)).toBeNull()
  })
  it('pins the intro to the first kept frame and the outro to the last', () => {
    expect(editedToSource(e, 0)).toBe(0)
    expect(editedToSource(e, 2999)).toBe(0)
    expect(editedToSource(e, 3000)).toBe(0)
    expect(editedToSource(e, 8000)).toBe(12_000)
    expect(editedToSource(e, 12_000)).toBe(18_000)
  })
  it('names the part of the timeline', () => {
    expect(cardPhaseAt(e, 1000)).toEqual({ phase: 'intro', at: 1000 })
    expect(cardPhaseAt(e, 3000)).toEqual({ phase: 'body', at: 0 })
    expect(cardPhaseAt(e, 11_500)).toEqual({ phase: 'outro', at: 500 })
  })
  it('moves caption cues by the intro', () => {
    expect(captionsToVtt(e)).toContain('00:00:04.000 --> 00:00:05.000')
  })
  it('puts a banner at each visible chapter, ending at the next one or the recording end', () => {
    expect(chapterBannerWindows(e)).toEqual([
      { id: 'a', title: 'Start', start_ms: 3000, end_ms: 4000 },
      { id: 'b', title: 'Close by', start_ms: 4000, end_ms: 6500 },
      { id: 'd', title: 'Late', start_ms: 10_000, end_ms: 11_000 }
    ])
  })
  it('maps an edited window back through cuts and speed', () => {
    expect(editedSpanToSource(e, 6000, 8000)).toEqual([
      { start_ms: 3000, end_ms: 4000 },
      { start_ms: 10_000, end_ms: 12_000 }
    ])
    expect(editedSpanToSource(e, 0, 2000)).toEqual([])
  })
  it('has no banners while they are off', () => {
    expect(chapterBannerWindows({ ...e, chapter_banners: undefined })).toEqual([])
  })
})

describe('card text', () => {
  const e = normalizeEdits(
    {
      intro: { enabled: true, show_chapters: true },
      outro: { enabled: true },
      chapters: Array.from({ length: 8 }, (_, i) => ({
        id: `c${i}`,
        at_ms: i * 1000,
        title: `Step ${i + 1}`
      }))
    },
    SRC
  )
  it('falls back to the video title, the first description line and the default outro', () => {
    const t = cardText(e, { title: 'Approve a request', description: '\n  Who signs off.\nMore.' })
    expect(t.intro).toEqual({
      title: 'Approve a request',
      subtitle: 'Who signs off.',
      chapters: ['Step 1', 'Step 2', 'Step 3', 'Step 4', 'Step 5', 'Step 6'],
      more: 2,
      duration_ms: editedDuration(e)
    })
    expect(t.outro).toEqual({ text: OUTRO_DEFAULT_TEXT, title: 'Approve a request' })
    expect(t.banners).toEqual([])
  })
  it('prefers the card’s own words', () => {
    const own = normalizeEdits(
      {
        intro: { enabled: true, title: 'Own', subtitle: 'Sub' },
        outro: { enabled: true, text: 'Bye' }
      },
      SRC
    )
    const t = cardText(own, { title: 'Video', description: 'Desc' })
    expect(t.intro?.title).toBe('Own')
    expect(t.intro?.subtitle).toBe('Sub')
    expect(t.intro?.chapters).toEqual([])
    expect(t.outro?.text).toBe('Bye')
  })
  it('keeps the accent a #rrggbb colour and reads the first line', () => {
    expect(cardAccent('#AB12CD')).toBe('#ab12cd')
    expect(cardAccent('ab12cd')).toBe('#ab12cd')
    expect(cardAccent('red; background:url(x)')).toBe('#00ceff')
    expect(firstLine(null)).toBe('')
  })
})

describe('card trees', () => {
  const brand = { name: 'Acme', color: '#123456', logo: null }
  const texts = (n: CardNode): string[] => [
    ...(n.text !== undefined ? [n.text] : []),
    ...(n.children ?? []).flatMap(texts)
  ]
  it('carries author text only as text, never markup', () => {
    const t = introTree(
      {
        title: '<img src=x onerror=1>',
        subtitle: 's',
        chapters: ['<b>c</b>'],
        more: 1,
        duration_ms: 125_000
      },
      brand,
      1280
    )
    expect(texts(t)).toEqual([
      'Acme',
      '2 min',
      '<img src=x onerror=1>',
      's',
      'In this video',
      '1',
      '<b>c</b>',
      'and 1 more'
    ])
    const all = JSON.stringify(t)
    expect(all).not.toContain('"tag":"img"')
  })
  it('shows the logo with the name, and scales with the frame', () => {
    const t = outroTree(
      { text: 'Bye', title: 'Approve' },
      { ...brand, logo: 'data:image/png;base64,AAAA' },
      1920
    )
    const foot = t.children?.[2]
    expect(foot?.children?.[0]).toMatchObject({ tag: 'img', src: 'data:image/png;base64,AAAA' })
    expect(foot?.children?.[1]).toMatchObject({ text: 'Acme' })
    expect(JSON.stringify(t)).toContain('font-size:69px')
    const b = bannerTree({ title: 'Chapter', index: 2, total: 5 }, brand, 640)
    expect(b.css).toContain('left:28px')
    expect(texts(b)).toEqual(['2', 'Chapter 2 of 5', 'Chapter'])
  })
  it('uses the video’s own name over the instance name', () => {
    const e = normalizeEdits({ card_brand: '  Field Ops  ' }, SRC)
    expect(e.card_brand).toBe('Field Ops')
    expect(shownBrand(brand, e).name).toBe('Field Ops')
    expect(shownBrand(brand, normalizeEdits({ card_brand: '  ' }, SRC)).name).toBe('Acme')
    expect('card_brand' in normalizeEdits({ card_brand: '' }, SRC)).toBe(false)
  })
  it('keeps a dark brand colour readable on the card ground', () => {
    expect(accentOnDark('#00ceff')).toBe('#00ceff')
    expect(accentOnDark('#172940')).not.toBe('#172940')
    expect(inkOnAccent('#00ceff')).toBe('#0b1120')
    expect(inkOnAccent('#172940')).toBe('#ffffff')
  })
  it('draws from the same layout file as the player', () => {
    const here = dirname(fileURLToPath(import.meta.url))
    const api = readFileSync(resolve(here, '../../../services/help-video-card-design.ts'), 'utf8')
    const shared = readFileSync(
      resolve(here, '../../../../../packages/shared/src/components/help-videos/cardDesign.ts'),
      'utf8'
    )
    expect(api).toBe(shared)
  })
})

describe('render plan with cards', () => {
  const e = normalizeEdits(
    {
      segments: [
        { start_ms: 0, end_ms: 4000, speed: 1 },
        { start_ms: 6000, end_ms: 9000, speed: 1 }
      ],
      zooms: [{ start_ms: 0, end_ms: 3000, rect: { x: 0, y: 0, w: 0.5, h: 0.5 } }]
    },
    10_000
  )
  const still = (path: string) => ({ path, sequence: false, frames: 1 })
  const seq = (path: string, frames: number) => ({ path, sequence: true, frames })
  const cards = {
    overlays: [{ path: 'annot-1.png', start_ms: 0, end_ms: 1000 }],
    banners: [{ ...still('card-banner-1.png'), start_ms: 4000, end_ms: 6500 }],
    intro: { ...still('card-intro.png'), duration_ms: 3000, over_frame: false },
    outro: { ...still('card-outro.png'), duration_ms: 2000, over_frame: false }
  }
  it('orders the inputs annotations, banners, intro, outro', () => {
    const args = buildRenderArgs({ ...base, ...cards, edits: e })
    expect(args.filter((_, i) => args[i - 1] === '-i')).toEqual([
      'in.webm',
      'annot-1.png',
      'card-banner-1.png',
      'card-intro.png',
      'card-outro.png'
    ])
  })
  it('keeps today’s card graph for still cards without a transition', () => {
    const g = fc(buildRenderArgs({ ...base, ...cards, edits: e }))
    expect(g).toContain('[3:v]scale=1280:720,format=yuv420p,setsar=1,loop=loop=89:size=1:start=0')
    expect(g).toContain('[4:v]scale=1280:720,format=yuv420p,setsar=1,loop=loop=59:size=1:start=0')
    expect(g).not.toContain('trim=end_frame=1')
  })
  it('lays banners over the finished picture in edited time', () => {
    const g = fc(buildRenderArgs({ ...base, ...cards, edits: e }))
    expect(g.indexOf('[2:v]')).toBeGreaterThan(g.indexOf('concat=n=3'))
    expect(g).toContain("overlay=0:0:eof_action=pass:enable='between(t,4.000,6.500)'")
  })
  it('reads a moving card as an image sequence over the recording’s first frame', () => {
    const args = buildRenderArgs({
      ...base,
      ...cards,
      edits: e,
      intro: { ...seq('d/card-intro/f%05d.png', 90), duration_ms: 3000, over_frame: true }
    })
    const flat = args.join(' ')
    expect(flat).toContain('-f image2 -framerate 30 -start_number 1 -i d/card-intro/f%05d.png')
    const g = fc(args)
    expect(g).toContain('trim=end_frame=1')
    expect(g).toContain('loop=loop=89:size=1:start=0')
    expect(g).toMatch(/\[cibg\]\[cifr\]overlay=0:0/)
  })
  it('keeps one graph while a sequence switches between opaque and transparent frames', () => {
    // Chromium writes opaque frames as rgb24 and see-through ones as rgba; a
    // rebuilt graph restarts every frame counter and the timeline jumps back.
    const args = buildRenderArgs({
      ...base,
      ...cards,
      edits: e,
      banners: [{ ...seq('d/card-banner-1/f%05d.png', 75), start_ms: 4000, end_ms: 6500 }],
      intro: { ...seq('d/card-intro/f%05d.png', 90), duration_ms: 3000, over_frame: true },
      outro: { ...seq('d/card-outro/f%05d.png', 60), duration_ms: 2000, over_frame: true }
    })
    const flat = args.join(' ')
    for (const d of ['card-banner-1', 'card-intro', 'card-outro']) {
      expect(flat).toContain(
        `-reinit_filter 0 -protocol_whitelist file -f image2 -framerate 30 -start_number 1 -i d/${d}/f%05d.png`
      )
    }
    expect(flat).not.toMatch(/-reinit_filter 0 -protocol_whitelist file -f (mov|png_pipe)/)
  })
  it('puts a moving end card over the recording’s last frame', () => {
    const g = fc(
      buildRenderArgs({
        ...base,
        ...cards,
        edits: e,
        outro: { ...seq('d/card-outro/f%05d.png', 60), duration_ms: 2000, over_frame: true }
      })
    )
    expect(g).toMatch(/trim=start=6\.950[^;]*,trim=end_frame=1/)
    expect(g).toMatch(/\[cobg\]\[cofr\]overlay=0:0/)
  })
  it('holds the last frame on when the picture ends before the edit does', () => {
    // A narrated recording's audio can run past its last video frame, so a
    // pick 50 ms before the end may find nothing: the last frame is cloned on
    // (at the card rate) before it is picked, and the end card never vanishes.
    const g = fc(
      buildRenderArgs({
        ...base,
        ...cards,
        edits: e,
        outro: { ...seq('d/card-outro/f%05d.png', 60), duration_ms: 2000, over_frame: true }
      })
    )
    expect(g).toMatch(
      /\[cosrc\]fps=30,tpad=stop_mode=clone:stop_duration=7\.000,trim=start=6\.950,trim=end_frame=1/
    )
  })
  it('reads a moving banner as a sequence offset to its edited start', () => {
    const g = fc(
      buildRenderArgs({
        ...base,
        ...cards,
        edits: e,
        banners: [{ ...seq('d/card-banner-1/f%05d.png', 75), start_ms: 4000, end_ms: 6500 }]
      })
    )
    expect(g).toContain('[2:v]format=rgba,setpts=PTS-STARTPTS+4.000/TB')
  })
  it('works without sound and with only an outro', () => {
    const args = buildRenderArgs({
      ...base,
      hasAudio: false,
      overlays: [],
      outro: { ...still('card-outro.png'), duration_ms: 2000, over_frame: false },
      edits: normalizeEdits({}, 10_000)
    })
    const g = fc(args)
    expect(g).toContain('[vbody][cov]concat=n=2:v=1:a=0[vout]')
    expect(g).not.toContain('anullsrc')
    expect(args.join(' ')).not.toContain('[aout]')
  })
  it('leaves the graph unchanged when there are no cards', () => {
    const g = fc(buildRenderArgs({ ...base, edits: normalizeEdits({}, 10_000) }))
    expect(g).toContain('setpts=PTS-STARTPTS[vout]')
    expect(g).not.toContain('vbody')
  })
})

describe('poster on a card', () => {
  const on = {
    intro: { enabled: true, duration_ms: 2000 },
    outro: { enabled: true, duration_ms: 3000 }
  }
  it('keeps a card poster only while that card is on', () => {
    expect(normalizeEdits({ ...on, poster_card: 'intro' }, SRC).poster_card).toBe('intro')
    expect('poster_card' in normalizeEdits({ poster_card: 'intro' }, SRC)).toBe(false)
    expect('poster_card' in normalizeEdits({ ...on, poster_card: 'bogus' }, SRC)).toBe(false)
  })
  it('takes the poster from the chosen card, else the frame after the intro', () => {
    const intro = normalizeEdits({ ...on, poster_card: 'intro', poster_ms: 5000 }, SRC)
    expect(posterEditedMs(intro)).toBe(100)
    const outro = normalizeEdits({ ...on, poster_card: 'outro' }, SRC)
    expect(posterEditedMs(outro)).toBe(2000 + SRC + 100)
    expect(posterEditedMs(normalizeEdits({ ...on, poster_ms: 0 }, SRC))).toBe(2000)
  })
  it('takes an animated card poster once the card has settled', () => {
    const animated = normalizeEdits(
      {
        intro: { enabled: true, duration_ms: 3000, animation: 'subtle', transition: 'fade' },
        poster_card: 'intro'
      },
      SRC
    )
    expect(posterEditedMs(animated)).toBe(900)
    const end = normalizeEdits(
      {
        outro: { enabled: true, duration_ms: 3000, animation: 'subtle', transition: 'fade' },
        poster_card: 'outro'
      },
      SRC
    )
    expect(posterEditedMs(end)).toBe(SRC + 1200)
  })
})

describe('card frame plan', () => {
  const still = undefined
  it('captures one image for a still card', () => {
    expect(planCardFrames(90, still)).toEqual([true, ...Array(89).fill(false)])
  })
  it('captures only the moving frames', () => {
    const m = {
      t_ms: 0,
      duration_ms: 3000,
      animation: 'subtle' as const,
      transition: 'fade' as const,
      side: 'intro' as const
    }
    const plan = planCardFrames(90, m)
    // 0–900 ms arriving (frames 0..27), 2400–3000 ms leaving (frames 73..89).
    expect(plan.slice(0, 28).every(Boolean)).toBe(true)
    expect(plan.slice(28, 73).some(Boolean)).toBe(false)
    expect(plan.slice(73).every(Boolean)).toBe(true)
  })
})
