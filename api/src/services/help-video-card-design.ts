// The help-video intro card, end card and chapter banner, as trees of plain
// nodes with inline CSS. ONE layout for both places a card is drawn: the live
// player (CardLayer materialises the tree as React elements) and the render
// (api/src/services/help-video-card-design.ts is a byte-for-byte copy of this
// file, materialised inside Chromium and screenshotted). A unit test fails
// when the two copies differ, so edit this file and copy it over.
//
// No imports: the api compiles this file on its own. Sizes are canvas pixels
// at 1280 px wide (`u` scales them). Author strings only ever travel as
// `text` (a text node), never as markup or CSS.

export interface CardNode {
  tag: 'div' | 'span' | 'img'
  css: string
  text?: string
  /** img only: the logo (a data: URI in the render, a URL in the player). */
  src?: string
  children?: CardNode[]
  /** Which motion the node takes (set by the tree builders): 'pop' scales in,
   *  'text' rises in, 'row' slides in, 'veil' is the fade-through-black layer. */
  m?: 'pop' | 'text' | 'row' | 'veil'
}

/** The brand a card is drawn in, already resolved for this video. */
export interface CardBrandShown {
  /** Shown beside the logo, or alone when there is no logo. Null = none. */
  name: string | null
  /** #rrggbb brand accent. */
  color: string
  logo: string | null
}

export interface IntroCardContent {
  title: string
  subtitle: string
  chapters: string[]
  /** Chapters past the listed ones. */
  more: number
  /** The whole finished video's length (cards included). */
  duration_ms: number
}
export interface OutroCardContent {
  text: string
  /** The video's title: "You've finished …". Blank = left out. */
  title: string
}
export interface BannerContent {
  title: string
  /** 1-based position among the chapters viewers see, and how many there are. */
  index: number
  total: number
}

/** Font stack with a Helvetica-like face everywhere: Helvetica Neue / Arial
 *  in browsers, FreeSans in the render image. */
export const CARD_FONT =
  "'Helvetica Neue', Helvetica, Arial, FreeSans, 'Liberation Sans', sans-serif"

export const CARD_INK = {
  ground: '#0b1120',
  title: '#ffffff',
  body: '#cbd5e1',
  muted: '#94a3b8',
  item: '#e2e8f0',
  hairline: 'rgba(255, 255, 255, 0.09)',
  panel: 'rgba(11, 17, 32, 0.92)',
  dark: '#0b1120'
} as const

// ── colour helpers ───────────────────────────────────────────────────────────

function rgbOf(hex: string): [number, number, number] {
  const h = /^#[0-9a-f]{6}$/i.test(hex) ? hex.slice(1) : '00ceff'
  return [0, 2, 4].map((i) => Number.parseInt(h.slice(i, i + 2), 16)) as [number, number, number]
}
function luminance(hex: string): number {
  const [r, g, b] = rgbOf(hex).map((c) => {
    const s = c / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
/** The accent with an alpha, as rgba(). */
export function accentAlpha(hex: string, a: number): string {
  const [r, g, b] = rgbOf(hex)
  return `rgba(${r}, ${g}, ${b}, ${a})`
}
/** The accent as it reads on the dark ground: a dark brand colour (a navy,
 *  a deep red) is lifted toward white until it clears roughly 4.5:1. */
export function accentOnDark(hex: string): string {
  let [r, g, b] = rgbOf(hex)
  for (let i = 0; i < 12 && luminance(toHex(r, g, b)) < 0.24; i++) {
    r += (255 - r) * 0.18
    g += (255 - g) * 0.18
    b += (255 - b) * 0.18
  }
  return toHex(r, g, b)
}
function toHex(r: number, g: number, b: number): string {
  return `#${[r, g, b].map((c) => Math.round(c).toString(16).padStart(2, '0')).join('')}`
}
/** Dark or white ink, whichever reads on a tile filled with the accent. */
export function inkOnAccent(hex: string): string {
  return luminance(hex) > 0.28 ? CARD_INK.dark : '#ffffff'
}

/** "45 sec" / "4 min" — the intro's length line. */
export function cardDurationLabel(ms: number): string {
  const s = Math.max(1, Math.round(ms / 1000))
  return s < 60 ? `${s} sec` : `${Math.max(1, Math.round(s / 60))} min`
}

// ── building blocks ──────────────────────────────────────────────────────────

const clamp = (n: number) =>
  `display:-webkit-box;-webkit-line-clamp:${n};-webkit-box-orient:vertical;overflow:hidden;`

function ground(accent: string, glowAt: string, u: number): string {
  return (
    `background:radial-gradient(${980 * u}px ${720 * u}px at ${glowAt}, ${accentAlpha(accent, 0.22)}, ${accentAlpha(accent, 0)} 70%),` +
    `radial-gradient(${620 * u}px ${420 * u}px at 0% 0%, ${accentAlpha(accent, 0.06)}, ${accentAlpha(accent, 0)} 70%),` +
    `${CARD_INK.ground};`
  )
}

function lockup(brand: CardBrandShown, u: number, center: boolean): CardNode | null {
  const kids: CardNode[] = []
  if (brand.logo) {
    kids.push({
      tag: 'img',
      src: brand.logo,
      css: `height:${36 * u}px;max-width:${240 * u}px;object-fit:contain;display:block;`
    })
  }
  if (brand.name) {
    kids.push({
      tag: 'span',
      text: brand.name,
      css: `color:${CARD_INK.item};font-size:${20 * u}px;font-weight:600;letter-spacing:-0.005em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:${520 * u}px;`
    })
  }
  if (!kids.length) return null
  return {
    tag: 'div',
    m: 'pop',
    css: `display:flex;align-items:center;gap:${14 * u}px;min-height:${36 * u}px;${center ? 'justify-content:center;' : ''}`,
    children: kids
  }
}

function playMark(accent: string, u: number): CardNode {
  return {
    tag: 'span',
    css: `width:${30 * u}px;height:${30 * u}px;border-radius:50%;background:${accentAlpha(accent, 0.18)};display:flex;align-items:center;justify-content:center;flex-shrink:0;`,
    children: [
      {
        tag: 'span',
        css: `width:0;height:0;margin-left:${3 * u}px;border-left:${11 * u}px solid ${accentOnDark(accent)};border-top:${7 * u}px solid transparent;border-bottom:${7 * u}px solid transparent;`
      }
    ]
  }
}

function doneMark(accent: string, u: number): CardNode {
  const a = accentOnDark(accent)
  return {
    tag: 'div',
    m: 'pop',
    css: `width:${68 * u}px;height:${68 * u}px;border-radius:50%;border:${3 * u}px solid ${a};background:${accentAlpha(accent, 0.12)};display:flex;align-items:center;justify-content:center;margin:0 auto;box-sizing:border-box;`,
    children: [
      {
        tag: 'span',
        css: `width:${13 * u}px;height:${26 * u}px;border-right:${4 * u}px solid ${a};border-bottom:${4 * u}px solid ${a};transform:rotate(45deg);margin-top:${-6 * u}px;box-sizing:border-box;`
      }
    ]
  }
}

// ── motion ───────────────────────────────────────────────────────────────────
// Card motion is a pure function of time: the same tree at every moment, with
// opacity / transform / clip-path worked out for t_ms. The player feeds its
// card clock; the render screenshots it frame by frame.

export type CardAnimation = 'none' | 'subtle' | 'lively'
export type CardTransition = 'cut' | 'fade' | 'fade_black' | 'slide' | 'zoom' | 'wipe'
export interface CardMotion {
  /** Time since the card (or banner) appeared. */
  t_ms: number
  /** How long it is up. */
  duration_ms: number
  animation: CardAnimation
  /** Cards only: how the intro leaves / the end card arrives. */
  transition: CardTransition
  side: 'intro' | 'outro' | 'banner'
}
type Span = [number, number]

const ENTER_MS = { subtle: 900, lively: 1200 } as const
const ITEM_MS = { subtle: 450, lively: 600 } as const
const STAGGER_MAX_MS = { subtle: 90, lively: 120 } as const
const TRANSITION_MS = 600
const BANNER_IN_MS = { subtle: 300, lively: 420 } as const
const BANNER_OUT_MS = { subtle: 250, lively: 300 } as const

const clamp01 = (n: number) => (n < 0 ? 0 : n > 1 ? 1 : n)
const easeOut = (p: number) => 1 - (1 - p) ** 3
const easeIn = (p: number) => p ** 3
const easeInOut = (p: number) => (p < 0.5 ? 4 * p ** 3 : 1 - (-2 * p + 2) ** 3 / 2)
const easeBack = (p: number) => 1 + 2.70158 * (p - 1) ** 3 + 1.70158 * (p - 1) ** 2
const r4 = (n: number) => Math.round(n * 10000) / 10000
const progress = (t: number, s: Span) => (s[1] > s[0] ? clamp01((t - s[0]) / (s[1] - s[0])) : 1)

/** When things move: `enter` = the elements arriving, `move` = the card's
 *  transition (cards) or the banner leaving. */
export function motionWindows(m: CardMotion): { enter: Span | null; move: Span | null } {
  const d = Math.max(0, m.duration_ms)
  if (m.side === 'banner') {
    if (m.animation === 'none') return { enter: null, move: null }
    const i = Math.min(BANNER_IN_MS[m.animation], d * 0.3)
    const o = Math.min(BANNER_OUT_MS[m.animation], d * 0.3)
    return { enter: [0, i], move: [d - o, d] }
  }
  const x = m.transition === 'cut' ? 0 : Math.min(TRANSITION_MS, d * 0.25)
  const e = m.animation === 'none' ? 0 : Math.min(ENTER_MS[m.animation], d * 0.4)
  if (m.side === 'intro') return { enter: e ? [0, e] : null, move: x ? [d - x, d] : null }
  const s = x / 2
  return { enter: e ? [s, s + e] : null, move: x ? [0, x] : null }
}

/** When the card (or banner) is fully in place: 0 when nothing arrives. */
export function settledMs(m: CardMotion): number {
  const w = motionWindows(m)
  const enter = w.enter ? w.enter[1] : 0
  return m.side === 'outro' && w.move ? Math.max(enter, w.move[1]) : enter
}

/** True when nothing changes between a and b (inclusive of neither end
 *  falling inside a moving window). */
export function isStill(m: CardMotion, a: number, b: number): boolean {
  const w = motionWindows(m)
  return ![w.enter, w.move].some((s) => !!s && a < s[1] && b > s[0])
}

function itemCss(
  kind: 'pop' | 'text' | 'row',
  i: number,
  n: number,
  m: CardMotion,
  enter: Span,
  u: number
): string {
  if (m.animation === 'none') return ''
  const len = enter[1] - enter[0]
  const item = Math.min(ITEM_MS[m.animation], len)
  const stagger = n > 1 ? Math.min(STAGGER_MAX_MS[m.animation], (len - item) / (n - 1)) : 0
  const start = enter[0] + i * stagger
  const p = item > 0 ? clamp01((m.t_ms - start) / item) : 1
  const o = r4(easeOut(p))
  if (m.animation === 'subtle')
    return `opacity:${o};transform:translateY(${r4((1 - o) * 12 * u)}px);`
  if (kind === 'pop') return `opacity:${o};transform:scale(${r4(0.85 + 0.15 * easeBack(p))});`
  if (kind === 'row') return `opacity:${o};transform:translateX(${r4(-(1 - o) * 24 * u)}px);`
  return `opacity:${o};transform:translateY(${r4((1 - o) * 24 * u)}px);`
}

function transitionCss(m: CardMotion, move: Span | null): string {
  if (!move || m.side === 'banner') return ''
  const k = easeInOut(progress(m.t_ms, move))
  if (m.side === 'intro') {
    if (m.transition === 'fade') return `opacity:${r4(1 - k)};`
    if (m.transition === 'fade_black') return `opacity:${r4(k < 0.5 ? 1 : 1 - (k - 0.5) * 2)};`
    if (m.transition === 'slide') return `transform:translateX(${r4(-k * 100)}%);`
    if (m.transition === 'zoom') return `opacity:${r4(1 - k)};transform:scale(${r4(1 + 0.08 * k)});`
    return `clip-path:inset(0 0 0 ${r4(k * 100)}%);`
  }
  if (m.transition === 'fade') return `opacity:${r4(k)};`
  if (m.transition === 'fade_black') return `opacity:${r4(Math.min(1, k * 2))};`
  if (m.transition === 'slide') return `transform:translateX(${r4((1 - k) * 100)}%);`
  if (m.transition === 'zoom') return `opacity:${r4(k)};transform:scale(${r4(1.08 - 0.08 * k)});`
  return `clip-path:inset(0 ${r4((1 - k) * 100)}% 0 0);`
}

function veilCss(m: CardMotion, move: Span | null): string {
  if (!move) return 'opacity:0;'
  const k = easeInOut(progress(m.t_ms, move))
  const v = m.side === 'intro' ? Math.min(1, k * 2) : k < 0.5 ? 1 : 1 - (k - 0.5) * 2
  // At the very ends the veil is gone: before the intro's transition, after the outro's.
  const end = m.side === 'intro' ? m.t_ms >= move[1] : m.t_ms <= move[0]
  return `opacity:${end ? 0 : r4(v)};`
}

function bannerCss(m: CardMotion, w: { enter: Span | null; move: Span | null }, u: number): string {
  if (!w.enter || !w.move) return ''
  const v = r4(easeOut(progress(m.t_ms, w.enter)) * (1 - easeIn(progress(m.t_ms, w.move))))
  return m.animation === 'lively'
    ? `opacity:${v};transform:translateX(${r4(-(1 - v) * 48 * u)}px);`
    : `opacity:${v};transform:translateY(${r4((1 - v) * 16 * u)}px);`
}

/** The tree at one moment of `m`. Without motion (or none + cut) the tree is
 *  returned untouched, so old videos draw exactly as before. */
function applyMotion(tree: CardNode, m: CardMotion | undefined, width: number): CardNode {
  if (!m || (m.animation === 'none' && m.transition === 'cut')) return tree
  const u = width > 0 ? width / 1280 : 1
  const w = motionWindows(m)
  const root: CardNode =
    m.side !== 'banner' && m.transition === 'fade_black'
      ? {
          ...tree,
          children: [
            ...(tree.children ?? []),
            { tag: 'div', m: 'veil', css: 'position:absolute;inset:0;background:#000;' }
          ]
        }
      : tree
  const count = (n: CardNode): number =>
    (n.m && n.m !== 'veil' ? 1 : 0) + (n.children ?? []).reduce((s, c) => s + count(c), 0)
  const n = count(root)
  let i = 0
  const walk = (node: CardNode): CardNode => {
    let css = node.css
    if (node.m === 'veil') css += veilCss(m, w.move)
    else if (node.m) {
      const enter = w.enter ?? [0, 0]
      css += w.enter ? itemCss(node.m, i, n, m, enter, u) : ''
      i++
    }
    return node.children ? { ...node, css, children: node.children.map(walk) } : { ...node, css }
  }
  const out = walk(root)
  out.css += m.side === 'banner' ? bannerCss(m, w, u) : transitionCss(m, w.move)
  return out
}

// ── the cards ────────────────────────────────────────────────────────────────

/** The intro card: brand at the top, the title block on the left, the
 *  chapters (when listed) in a column on the right. Opaque, full frame. */
export function introTree(
  c: IntroCardContent,
  brand: CardBrandShown,
  width: number,
  motion?: CardMotion
): CardNode {
  const u = width > 0 ? width / 1280 : 1
  const accent = brand.color
  const withList = c.chapters.length > 0
  const titleBlock: CardNode = {
    tag: 'div',
    css: 'flex:1;min-width:0;',
    children: [
      {
        tag: 'div',
        m: 'text',
        css: `display:flex;align-items:center;gap:${12 * u}px;margin-bottom:${24 * u}px;`,
        children: [
          playMark(accent, u),
          {
            tag: 'span',
            text: cardDurationLabel(c.duration_ms),
            css: `color:${CARD_INK.muted};font-size:${18 * u}px;font-weight:500;`
          }
        ]
      },
      {
        tag: 'div',
        m: 'text',
        text: c.title,
        css: `color:${CARD_INK.title};font-size:${(withList ? 54 : 62) * u}px;font-weight:700;line-height:1.1;letter-spacing:-0.02em;text-wrap:balance;${clamp(withList ? 3 : 2)}`
      },
      ...(c.subtitle
        ? [
            {
              tag: 'div' as const,
              m: 'text' as const,
              text: c.subtitle,
              css: `color:${CARD_INK.body};font-size:${24 * u}px;line-height:1.45;margin-top:${22 * u}px;max-width:${780 * u}px;text-wrap:pretty;${clamp(2)}`
            }
          ]
        : [])
    ]
  }
  const middle: CardNode[] = [titleBlock]
  if (withList) {
    const accentText = accentOnDark(accent)
    middle.push({
      tag: 'div',
      css: `width:${400 * u}px;flex-shrink:0;padding-left:${40 * u}px;border-left:1px solid ${CARD_INK.hairline};box-sizing:border-box;`,
      children: [
        {
          tag: 'div',
          m: 'text',
          text: 'In this video',
          css: `color:${CARD_INK.muted};font-size:${16 * u}px;font-weight:600;margin-bottom:${8 * u}px;`
        },
        ...c.chapters.map(
          (t, i): CardNode => ({
            tag: 'div',
            m: 'row',
            css: `display:flex;align-items:baseline;gap:${14 * u}px;padding:${10 * u}px 0;${i ? `border-top:1px solid ${CARD_INK.hairline};` : ''}`,
            children: [
              {
                tag: 'span',
                text: String(i + 1),
                css: `color:${accentText};font-size:${19 * u}px;font-weight:700;width:${22 * u}px;flex-shrink:0;font-variant-numeric:tabular-nums;`
              },
              {
                tag: 'span',
                text: t,
                css: `color:${CARD_INK.item};font-size:${19 * u}px;line-height:1.35;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;`
              }
            ]
          })
        ),
        ...(c.more > 0
          ? [
              {
                tag: 'div' as const,
                m: 'row' as const,
                text: `and ${c.more} more`,
                css: `color:${CARD_INK.muted};font-size:${16 * u}px;padding-top:${8 * u}px;border-top:1px solid ${CARD_INK.hairline};`
              }
            ]
          : [])
      ]
    })
  }
  const top = lockup(brand, u, false)
  const tree: CardNode = {
    tag: 'div',
    css: `position:absolute;inset:0;${ground(accent, '100% 100%', u)}display:flex;flex-direction:column;padding:${60 * u}px ${88 * u}px;box-sizing:border-box;`,
    children: [
      top ?? { tag: 'div', css: `height:${36 * u}px;` },
      {
        tag: 'div',
        css: `flex:1;min-height:0;display:flex;align-items:center;gap:${64 * u}px;`,
        children: middle
      },
      { tag: 'div', css: `height:${36 * u}px;` }
    ]
  }
  return applyMotion(tree, motion, width)
}

/** The end card: a "done" mark, what was finished, the closing line, and the
 *  brand at the foot. Opaque, full frame. */
export function outroTree(
  c: OutroCardContent,
  brand: CardBrandShown,
  width: number,
  motion?: CardMotion
): CardNode {
  const u = width > 0 ? width / 1280 : 1
  const accent = brand.color
  const body: CardNode[] = [doneMark(accent, u)]
  if (c.title) {
    body.push({
      tag: 'div',
      m: 'text',
      css: `color:${CARD_INK.muted};font-size:${20 * u}px;margin-top:${28 * u}px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;`,
      children: [
        { tag: 'span', text: 'You’ve finished ', css: '' },
        { tag: 'span', text: c.title, css: `color:${CARD_INK.item};font-weight:600;` }
      ]
    })
  }
  body.push({
    tag: 'div',
    m: 'text',
    text: c.text,
    css: `color:${CARD_INK.title};font-size:${46 * u}px;font-weight:700;line-height:1.2;letter-spacing:-0.015em;margin-top:${(c.title ? 14 : 30) * u}px;text-wrap:balance;${clamp(3)}`
  })
  const foot = lockup(brand, u, true)
  const tree: CardNode = {
    tag: 'div',
    css: `position:absolute;inset:0;${ground(accent, '50% 120%', u)}display:flex;flex-direction:column;padding:${60 * u}px ${140 * u}px;box-sizing:border-box;text-align:center;`,
    children: [
      { tag: 'div', css: `height:${36 * u}px;` },
      {
        tag: 'div',
        css: 'flex:1;min-height:0;display:flex;flex-direction:column;justify-content:center;',
        children: body
      },
      foot ?? { tag: 'div', css: `height:${36 * u}px;` }
    ]
  }
  return applyMotion(tree, motion, width)
}

/** A chapter banner: a lower third with the chapter's number on a tile in
 *  the brand colour. On a transparent frame. */
export function bannerTree(
  c: BannerContent,
  brand: CardBrandShown,
  width: number,
  motion?: CardMotion
): CardNode {
  const u = width > 0 ? width / 1280 : 1
  // The tile sits on the dark panel: a dark brand colour is lifted first.
  const tile = accentOnDark(brand.color)
  const tree: CardNode = {
    tag: 'div',
    css: `position:absolute;left:${56 * u}px;bottom:${120 * u}px;max-width:${820 * u}px;display:flex;align-items:center;gap:${16 * u}px;background:${CARD_INK.panel};border-radius:${12 * u}px;padding:${10 * u}px ${26 * u}px ${10 * u}px ${10 * u}px;box-shadow:0 ${6 * u}px ${24 * u}px rgba(0,0,0,0.35);box-sizing:border-box;`,
    children: [
      {
        tag: 'span',
        m: 'pop',
        text: String(c.index),
        css: `width:${50 * u}px;height:${50 * u}px;border-radius:${9 * u}px;background:${tile};color:${inkOnAccent(tile)};font-size:${24 * u}px;font-weight:700;display:flex;align-items:center;justify-content:center;flex-shrink:0;font-variant-numeric:tabular-nums;`
      },
      {
        tag: 'span',
        css: 'display:flex;flex-direction:column;min-width:0;',
        children: [
          {
            tag: 'span',
            text: `Chapter ${c.index} of ${c.total}`,
            css: `color:${CARD_INK.muted};font-size:${15 * u}px;font-weight:500;line-height:1.3;`
          },
          {
            tag: 'span',
            text: c.title,
            css: `color:${CARD_INK.title};font-size:${26 * u}px;font-weight:700;line-height:1.25;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;`
          }
        ]
      }
    ]
  }
  return applyMotion(tree, motion, width)
}
