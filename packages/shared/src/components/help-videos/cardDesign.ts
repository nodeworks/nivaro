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
    css: `width:${68 * u}px;height:${68 * u}px;border-radius:50%;border:${3 * u}px solid ${a};background:${accentAlpha(accent, 0.12)};display:flex;align-items:center;justify-content:center;margin:0 auto;box-sizing:border-box;`,
    children: [
      {
        tag: 'span',
        css: `width:${13 * u}px;height:${26 * u}px;border-right:${4 * u}px solid ${a};border-bottom:${4 * u}px solid ${a};transform:rotate(45deg);margin-top:${-6 * u}px;box-sizing:border-box;`
      }
    ]
  }
}

// ── the cards ────────────────────────────────────────────────────────────────

/** The intro card: brand at the top, the title block on the left, the
 *  chapters (when listed) in a column on the right. Opaque, full frame. */
export function introTree(c: IntroCardContent, brand: CardBrandShown, width: number): CardNode {
  const u = width > 0 ? width / 1280 : 1
  const accent = brand.color
  const withList = c.chapters.length > 0
  const titleBlock: CardNode = {
    tag: 'div',
    css: 'flex:1;min-width:0;',
    children: [
      {
        tag: 'div',
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
        text: c.title,
        css: `color:${CARD_INK.title};font-size:${(withList ? 54 : 62) * u}px;font-weight:700;line-height:1.1;letter-spacing:-0.02em;text-wrap:balance;${clamp(withList ? 3 : 2)}`
      },
      ...(c.subtitle
        ? [
            {
              tag: 'div' as const,
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
          text: 'In this video',
          css: `color:${CARD_INK.muted};font-size:${16 * u}px;font-weight:600;margin-bottom:${8 * u}px;`
        },
        ...c.chapters.map(
          (t, i): CardNode => ({
            tag: 'div',
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
                text: `and ${c.more} more`,
                css: `color:${CARD_INK.muted};font-size:${16 * u}px;padding-top:${8 * u}px;border-top:1px solid ${CARD_INK.hairline};`
              }
            ]
          : [])
      ]
    })
  }
  const top = lockup(brand, u, false)
  return {
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
}

/** The end card: a "done" mark, what was finished, the closing line, and the
 *  brand at the foot. Opaque, full frame. */
export function outroTree(c: OutroCardContent, brand: CardBrandShown, width: number): CardNode {
  const u = width > 0 ? width / 1280 : 1
  const accent = brand.color
  const body: CardNode[] = [doneMark(accent, u)]
  if (c.title) {
    body.push({
      tag: 'div',
      css: `color:${CARD_INK.muted};font-size:${20 * u}px;margin-top:${28 * u}px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;`,
      children: [
        { tag: 'span', text: 'You’ve finished ', css: '' },
        { tag: 'span', text: c.title, css: `color:${CARD_INK.item};font-weight:600;` }
      ]
    })
  }
  body.push({
    tag: 'div',
    text: c.text,
    css: `color:${CARD_INK.title};font-size:${46 * u}px;font-weight:700;line-height:1.2;letter-spacing:-0.015em;margin-top:${(c.title ? 14 : 30) * u}px;text-wrap:balance;${clamp(3)}`
  })
  const foot = lockup(brand, u, true)
  return {
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
}

/** A chapter banner: a lower third with the chapter's number on a tile in
 *  the brand colour. On a transparent frame. */
export function bannerTree(c: BannerContent, brand: CardBrandShown, width: number): CardNode {
  const u = width > 0 ? width / 1280 : 1
  // The tile sits on the dark panel: a dark brand colour is lifted first.
  const tile = accentOnDark(brand.color)
  return {
    tag: 'div',
    css: `position:absolute;left:${56 * u}px;bottom:${120 * u}px;max-width:${820 * u}px;display:flex;align-items:center;gap:${16 * u}px;background:${CARD_INK.panel};border-radius:${12 * u}px;padding:${10 * u}px ${26 * u}px ${10 * u}px ${10 * u}px;box-shadow:0 ${6 * u}px ${24 * u}px rgba(0,0,0,0.35);box-sizing:border-box;`,
    children: [
      {
        tag: 'span',
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
}
