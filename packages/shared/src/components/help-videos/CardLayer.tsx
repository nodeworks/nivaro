import { createElement, type ReactNode, useCallback } from 'react'
import { bannerTree, type CardNode, introTree, outroTree } from './cardDesign'
import {
  bannerAt,
  bannerMotionAt,
  CARD_FONT,
  type CardBrand,
  cardMotionAt,
  introContent,
  outroContent,
  shownBrand
} from './cards'
import { cardPhaseAt } from './edits'
import { renderSizes } from './playerMath'
import type { VideoEdits } from './types'

/**
 * The intro card, end card and chapter banner for one moment of EDITED time.
 * The cards are cardDesign.ts trees — the very layout the render screenshots
 * — laid out on a canvas the size of the rendered file and scaled to the
 * frame (the same way OverlayLayer does), so the live player and the render
 * look alike. Every author string is a React text node.
 */
export function CardLayer({
  edits,
  editedMs,
  frame,
  source,
  video,
  brand,
  showBanner = true
}: {
  edits: VideoEdits
  editedMs: number
  frame: { width: number; height: number }
  source?: { width: number; height: number } | null
  video: { title: string | null | undefined; description: string | null | undefined }
  brand: CardBrand
  /** Off where the banner is already in the picture (the rendered file). */
  showBanner?: boolean
}) {
  const { phase, at } = cardPhaseAt(edits, editedMs)
  const banner = phase === 'body' && showBanner ? bannerAt(edits, editedMs) : null
  if (phase === 'body' && !banner) return null
  // The finished file's size: the cropped picture (cards are full frames of it).
  const canvas =
    source?.width && source?.height
      ? renderSizes(source.width, source.height, edits.crop).out
      : frame
  const kx = canvas.width ? frame.width / canvas.width : 1
  const ky = canvas.height ? frame.height / canvas.height : 1
  const shown = shownBrand(brand, edits)
  const tree =
    phase === 'intro'
      ? introTree(introContent(edits, video), shown, canvas.width, cardMotionAt(edits, 'intro', at))
      : phase === 'outro'
        ? outroTree(
            outroContent(edits, video),
            shown,
            canvas.width,
            cardMotionAt(edits, 'outro', at)
          )
        : banner
          ? bannerTree(banner, shown, canvas.width, bannerMotionAt(edits, banner, editedMs))
          : null
  if (!tree) return null
  const kind = banner ? 'banner' : phase
  return (
    <div
      className='pointer-events-none absolute left-0 top-0'
      style={{
        width: canvas.width,
        height: canvas.height,
        transform: `scale(${kx}, ${ky})`,
        transformOrigin: '0 0',
        fontFamily: CARD_FONT
      }}
      data-hv-card={kind}
    >
      <CardNodeView node={tree} data={`data-hv-${kind}`} />
    </div>
  )
}

/** One card node as an element: its CSS is the tree's own string (set as
 *  cssText, exactly as the render does), its text a React text node. A logo
 *  that fails to load hides itself. */
function CardNodeView({ node, data }: { node: CardNode; data?: string }): ReactNode {
  const css = node.css
  const ref = useCallback(
    (el: HTMLElement | null) => {
      if (el) el.style.cssText = css
    },
    [css]
  )
  const props: Record<string, unknown> = { ref }
  if (data) props[data] = ''
  if (node.tag === 'img') {
    return createElement('img', {
      ...props,
      src: node.src,
      alt: '',
      onError: (e: { currentTarget: HTMLImageElement }) => {
        e.currentTarget.style.display = 'none'
      }
    })
  }
  return createElement(
    node.tag,
    props,
    node.text,
    // biome-ignore lint/suspicious/noArrayIndexKey: the tree is rebuilt whole each frame; position is the identity
    ...(node.children ?? []).map((child, i) => <CardNodeView key={i} node={child} />)
  )
}
