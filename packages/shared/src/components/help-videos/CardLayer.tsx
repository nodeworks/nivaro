import { type CSSProperties, useState } from 'react'
import {
  bannerAt,
  CARD_COLORS,
  CARD_FONT,
  type CardBrand,
  cardUnit,
  introContent,
  outroContent
} from './cards'
import { cardPhaseAt } from './edits'
import { renderSize } from './playerMath'
import type { VideoEdits } from './types'

const clampLines = (n: number): CSSProperties => ({
  display: '-webkit-box',
  WebkitLineClamp: n,
  WebkitBoxOrient: 'vertical',
  overflow: 'hidden'
})

/**
 * The intro card, outro card and chapter banner for one moment of EDITED
 * time, laid out on a canvas the size of the rendered file and scaled to the
 * frame (the same way OverlayLayer does), so the live player and the render
 * look alike. The render draws the same cards (api/src/services/
 * help-video-cards.ts). Every author string is a React text node.
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
  const { phase } = cardPhaseAt(edits, editedMs)
  const banner = phase === 'body' && showBanner ? bannerAt(edits, editedMs) : null
  if (phase === 'body' && !banner) return null
  const canvas = source?.width && source?.height ? renderSize(source.width, source.height) : frame
  const kx = canvas.width ? frame.width / canvas.width : 1
  const ky = canvas.height ? frame.height / canvas.height : 1
  const u = cardUnit(canvas.width)
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
      data-hv-card={banner ? 'banner' : phase}
    >
      {phase === 'intro' && <IntroCard edits={edits} video={video} brand={brand} u={u} />}
      {phase === 'outro' && <OutroCard edits={edits} brand={brand} u={u} />}
      {banner && <Banner title={banner.title} brand={brand} u={u} />}
    </div>
  )
}

function BrandMark({ brand, u, center }: { brand: CardBrand; u: number; center?: boolean }) {
  const [broken, setBroken] = useState(false)
  if (brand.logo && !broken) {
    return (
      <img
        src={brand.logo}
        alt=''
        onError={() => setBroken(true)}
        style={{
          height: 56 * u,
          maxWidth: 360 * u,
          objectFit: 'contain',
          objectPosition: center ? 'center' : 'left center',
          display: 'block',
          margin: center ? '0 auto' : undefined
        }}
      />
    )
  }
  if (!brand.name) return null
  return (
    <div
      style={{
        color: CARD_COLORS.label,
        fontSize: 20 * u,
        fontWeight: 700,
        letterSpacing: 2 * u,
        textTransform: 'uppercase'
      }}
    >
      {brand.name}
    </div>
  )
}

function Rule({ brand, u, center }: { brand: CardBrand; u: number; center?: boolean }) {
  return (
    <div
      style={{
        width: 72 * u,
        height: 6 * u,
        borderRadius: 3 * u,
        background: brand.color,
        margin: center ? `${28 * u}px auto` : `${28 * u}px 0`
      }}
    />
  )
}

function IntroCard({
  edits,
  video,
  brand,
  u
}: {
  edits: VideoEdits
  video: { title: string | null | undefined; description: string | null | undefined }
  brand: CardBrand
  u: number
}) {
  const c = introContent(edits, video)
  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        background: CARD_COLORS.ground,
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'center',
        padding: `0 ${110 * u}px`
      }}
      data-hv-intro
    >
      <BrandMark brand={brand} u={u} />
      <Rule brand={brand} u={u} />
      <div
        style={{
          color: CARD_COLORS.title,
          fontSize: 54 * u,
          fontWeight: 700,
          lineHeight: 1.15,
          ...clampLines(2)
        }}
      >
        {c.title}
      </div>
      {c.subtitle && (
        <div
          style={{
            color: CARD_COLORS.body,
            fontSize: 26 * u,
            lineHeight: 1.35,
            marginTop: 16 * u,
            ...clampLines(2)
          }}
        >
          {c.subtitle}
        </div>
      )}
      {c.chapters.length > 0 && (
        <div style={{ marginTop: 34 * u }} data-hv-intro-chapters>
          <div
            style={{
              color: CARD_COLORS.label,
              fontSize: 16 * u,
              fontWeight: 700,
              letterSpacing: 1.5 * u,
              textTransform: 'uppercase',
              marginBottom: 10 * u
            }}
          >
            In this video
          </div>
          {c.chapters.map((t, i) => (
            <div
              // biome-ignore lint/suspicious/noArrayIndexKey: chapter titles can repeat; order is the identity
              key={i}
              style={{
                color: CARD_COLORS.item,
                fontSize: 21 * u,
                lineHeight: 1.5,
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis'
              }}
            >
              <span style={{ color: brand.color, fontWeight: 700, marginRight: 12 * u }}>
                {i + 1}
              </span>
              {t}
            </div>
          ))}
          {c.more > 0 && (
            <div style={{ color: CARD_COLORS.label, fontSize: 18 * u, marginTop: 4 * u }}>
              and {c.more} more
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function OutroCard({ edits, brand, u }: { edits: VideoEdits; brand: CardBrand; u: number }) {
  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        background: CARD_COLORS.ground,
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'center',
        textAlign: 'center',
        padding: `0 ${140 * u}px`
      }}
      data-hv-outro
    >
      <BrandMark brand={brand} u={u} center />
      <Rule brand={brand} u={u} center />
      <div
        style={{
          color: CARD_COLORS.title,
          fontSize: 42 * u,
          fontWeight: 700,
          lineHeight: 1.25,
          ...clampLines(3)
        }}
      >
        {outroContent(edits)}
      </div>
    </div>
  )
}

function Banner({ title, brand, u }: { title: string; brand: CardBrand; u: number }) {
  return (
    <div
      style={{
        position: 'absolute',
        left: 52 * u,
        bottom: 130 * u,
        maxWidth: 760 * u,
        display: 'flex',
        alignItems: 'center',
        gap: 14 * u,
        background: CARD_COLORS.banner,
        borderRadius: 10 * u,
        padding: `${14 * u}px ${24 * u}px`,
        boxShadow: `0 ${4 * u}px ${18 * u}px rgba(0,0,0,0.35)`
      }}
      data-hv-banner
    >
      <span
        style={{
          width: 12 * u,
          height: 12 * u,
          borderRadius: '50%',
          background: brand.color,
          flexShrink: 0
        }}
      />
      <span
        style={{
          color: CARD_COLORS.title,
          fontSize: 28 * u,
          fontWeight: 700,
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis'
        }}
      >
        {title}
      </span>
    </div>
  )
}
