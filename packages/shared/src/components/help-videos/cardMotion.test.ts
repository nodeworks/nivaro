// packages/shared/src/components/help-videos/cardMotion.test.ts
import { describe, expect, it } from 'vitest'
import {
  bannerTree,
  type CardMotion,
  type CardNode,
  introTree,
  isStill,
  motionWindows,
  outroTree,
  settledMs
} from './cardDesign'

const brand = { name: 'Acme', color: '#00ceff', logo: 'data:image/png;base64,AA==' }
const intro = {
  title: 'Submit',
  subtitle: 'How',
  chapters: ['One', 'Two'],
  more: 0,
  duration_ms: 30_000
}
const outro = { text: 'Done', title: 'Submit' }
const banner = { title: 'One', index: 1, total: 2 }
const m = (over: Partial<CardMotion>): CardMotion => ({
  t_ms: 0,
  duration_ms: 3000,
  animation: 'subtle',
  transition: 'fade',
  side: 'intro',
  ...over
})
const shape = (n: CardNode): string =>
  `${n.tag}${n.m ?? ''}(${(n.children ?? []).map(shape).join(',')})`
const all = (n: CardNode): CardNode[] => [n, ...(n.children ?? []).flatMap(all)]
const num = (css: string, prop: string): number | null => {
  const r = new RegExp(`${prop}:([-0-9.e]+)`).exec(css)
  return r ? Number(r[1]) : null
}

describe('card motion', () => {
  it('leaves the trees unchanged without motion, or with none and cut', () => {
    const plain = introTree(intro, brand, 1280)
    expect(introTree(intro, brand, 1280, m({ animation: 'none', transition: 'cut' }))).toEqual(
      plain
    )
    expect(
      outroTree(outro, brand, 1280, m({ side: 'outro', animation: 'none', transition: 'cut' }))
    ).toEqual(outroTree(outro, brand, 1280))
    expect(
      bannerTree(banner, brand, 1280, m({ side: 'banner', animation: 'none', transition: 'cut' }))
    ).toEqual(bannerTree(banner, brand, 1280))
  })
  it('keeps the same nodes at every moment', () => {
    for (const anim of ['subtle', 'lively'] as const)
      for (const tr of ['fade', 'fade_black', 'slide', 'zoom', 'wipe'] as const) {
        const at = (t: number) =>
          shape(introTree(intro, brand, 1280, m({ t_ms: t, animation: anim, transition: tr })))
        expect(at(0)).toBe(at(1500))
        expect(at(1500)).toBe(at(2999))
      }
  })
  it('starts the intro items hidden and settles them', () => {
    const start = all(introTree(intro, brand, 1280, m({ t_ms: 0 }))).filter((n) => n.m === 'text')
    expect(start.every((n) => num(n.css, 'opacity') === 0)).toBe(true)
    const done = settledMs(m({}))
    const after = all(introTree(intro, brand, 1280, m({ t_ms: done }))).filter(
      (n) => n.m === 'text'
    )
    expect(after.every((n) => num(n.css, 'opacity') === 1)).toBe(true)
  })
  it('places the intro transition at the end and the outro transition at the start', () => {
    expect(motionWindows(m({}))).toEqual({ enter: [0, 900], move: [2400, 3000] })
    expect(motionWindows(m({ side: 'outro' }))).toEqual({ enter: [300, 1200], move: [0, 600] })
  })
  it('fits a 2 s lively wipe without overlap', () => {
    const w = motionWindows(m({ duration_ms: 2000, animation: 'lively', transition: 'wipe' }))
    expect(w.enter).toEqual([0, 800])
    expect(w.move).toEqual([1500, 2000])
    for (let t = 0; t <= 2000; t += 50) {
      const css = all(
        introTree(
          intro,
          brand,
          1280,
          m({ t_ms: t, duration_ms: 2000, animation: 'lively', transition: 'wipe' })
        )
      )
        .map((n) => n.css)
        .join('')
      expect(css).not.toMatch(/NaN|Infinity/)
    }
  })
  it('fits a 300 ms banner window', () => {
    const w = motionWindows(m({ side: 'banner', duration_ms: 300, transition: 'cut' }))
    expect(w.enter).toEqual([0, 90])
    expect(w.move).toEqual([210, 300])
  })
  it('fades through black with no veil at either end', () => {
    for (const side of ['intro', 'outro'] as const) {
      const tree = (t: number) => {
        const motion = m({ side, t_ms: t, transition: 'fade_black' })
        return side === 'intro'
          ? introTree(intro, brand, 1280, motion)
          : outroTree(outro, brand, 1280, motion)
      }
      const veil = (t: number) =>
        num(all(tree(t)).find((n) => n.m === 'veil')?.css ?? '', 'opacity')
      expect(veil(0)).toBe(0)
      expect(veil(3000)).toBe(0)
      const mid = side === 'intro' ? 2700 : 150
      expect(veil(mid)).toBe(1)
    }
  })
  it('knows when nothing moves', () => {
    expect(isStill(m({}), 950, 2000)).toBe(true)
    expect(isStill(m({}), 800, 1000)).toBe(false)
    expect(isStill(m({}), 2350, 2450)).toBe(false)
    expect(isStill(m({ animation: 'none', transition: 'cut' }), 0, 3000)).toBe(true)
  })
  it('slides the banner in and out', () => {
    const op = (t: number) =>
      num(
        bannerTree(
          banner,
          brand,
          1280,
          m({ side: 'banner', transition: 'cut', duration_ms: 2500, t_ms: t })
        ).css,
        'opacity'
      )
    expect(op(0)).toBe(0)
    expect(op(1000)).toBe(1)
    expect(op(2500)).toBe(0)
  })
})
