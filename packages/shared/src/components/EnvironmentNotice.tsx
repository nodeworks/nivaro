import { ArrowUpRight, FlaskConical } from 'lucide-react'
import { useEffect, useState } from 'react'

/**
 * "This is not production" (Rob 2026-11-13: people signed in to staging thinking it was the
 * real portal). Each environment configures its own notice in Settings → This Instance; the
 * instance hands it out on the public GET /api/app-info (`environment_notice`), before anyone
 * signs in. No notice, an unknown answer or a failed read show nothing.
 *
 * Hazard-tape yellow and ink, the same in light and dark: no app theme uses that pairing, so it
 * never reads as brand colour (EFP's light accent is amber).
 */

export interface EnvironmentInfo {
  /** The big word ("Staging"). */
  label: string
  /** The sentence beside it. */
  message: string
  /** "Go to production" target (https), or null. */
  productionUrl: string | null
  /** Also mark the signed-in admin app. */
  inAdminApp: boolean
}

const cache = new Map<string, Promise<EnvironmentInfo | null>>()

/** The instance's configured notice, or null (none / unknown / failure). Exported for tests. */
export function readEnvironment(apiBase: string): Promise<EnvironmentInfo | null> {
  let p = cache.get(apiBase)
  if (!p) {
    p = fetch(`${apiBase}/api/app-info`, { credentials: 'omit' })
      .then((r) => (r.ok ? r.json() : null))
      .then((info: Record<string, unknown> | null): EnvironmentInfo | null => {
        const n = info?.environment_notice as Record<string, unknown> | null | undefined
        if (!n || typeof n !== 'object') return null
        const label = typeof n.label === 'string' ? n.label.trim().slice(0, 40) : ''
        if (!label) return null
        const message = typeof n.message === 'string' ? n.message.trim().slice(0, 200) : ''
        const url = typeof n.production_url === 'string' ? n.production_url : null
        return {
          label,
          message,
          productionUrl: url && /^https:\/\//.test(url) ? url : null,
          inAdminApp: n.in_admin_app !== false
        }
      })
      .catch(() => null)
    cache.set(apiBase, p)
  }
  return p
}

/** Tests only. */
export function _resetEnvironmentCache(): void {
  cache.clear()
}

export function useInstanceEnvironment(apiBase = ''): EnvironmentInfo | null {
  const [info, setInfo] = useState<EnvironmentInfo | null>(null)
  useEffect(() => {
    let live = true
    void readEnvironment(apiBase).then((v) => {
      if (live) setInfo(v)
    })
    return () => {
      live = false
    }
  }, [apiBase])
  return info
}

/** Puts "Staging · " in front of the tab title while mounted (and keeps it there). */
function useTitlePrefix(label: string | null) {
  useEffect(() => {
    if (!label || typeof document === 'undefined') return
    const prefix = `${label} · `
    const apply = () => {
      if (!document.title.startsWith(prefix)) document.title = prefix + document.title
    }
    apply()
    const titleEl = document.querySelector('title')
    const obs = titleEl ? new MutationObserver(apply) : null
    if (titleEl && obs)
      obs.observe(titleEl, { childList: true, characterData: true, subtree: true })
    return () => {
      obs?.disconnect()
      if (document.title.startsWith(prefix)) document.title = document.title.slice(prefix.length)
    }
  }, [label])
}

const TAPE =
  'repeating-linear-gradient(-45deg, #111827 0 9px, #facc15 9px 18px)' /* ink / yellow-400 */

/**
 * The sign-in page band: full width across the top, impossible to miss. Says what this is,
 * that nothing here reaches production, and (when the server knows it) where production is.
 */
export function EnvironmentLoginBanner({ apiBase = '' }: { apiBase?: string }) {
  const info = useInstanceEnvironment(apiBase)
  useTitlePrefix(info ? info.label : null)
  if (!info) return null
  return (
    <>
      <EnvironmentBand
        label={info.label}
        message={info.message}
        productionUrl={info.productionUrl}
      />
      {/* Tape around the whole page: the band can scroll away, the frame cannot. */}
      <div
        aria-hidden
        data-environment-frame
        className='pointer-events-none fixed inset-0 z-40'
        style={{ border: '6px solid transparent', borderImage: `${TAPE} 6` }}
      />
    </>
  )
}

/** The band itself (also the live preview in Settings → This Instance). */
export function EnvironmentBand({
  label,
  message,
  productionUrl,
  preview = false
}: {
  label: string
  message: string
  productionUrl: string | null
  /** A preview (Settings): no alert role, the link does not navigate. */
  preview?: boolean
}) {
  return (
    <div
      role={preview ? undefined : 'alert'}
      data-environment-banner
      className='relative z-30 flex min-h-[84px] w-full shrink-0 items-stretch bg-[#facc15] text-[#111827] shadow-[0_3px_16px_rgba(17,24,39,0.4)]'
    >
      <div aria-hidden className='w-8 shrink-0 sm:w-28' style={{ backgroundImage: TAPE }} />
      <div className='flex min-w-0 flex-1 flex-wrap items-center justify-center gap-x-6 gap-y-1.5 px-5 py-3 text-center'>
        <span className='inline-flex items-center gap-2.5 text-[22px] font-black uppercase leading-none tracking-[0.16em] sm:text-[28px]'>
          <FlaskConical className='h-6 w-6 sm:h-7 sm:w-7' strokeWidth={2.6} />
          {label}
        </span>
        {message && (
          <span className='max-w-[52ch] text-[14px] font-semibold leading-snug sm:text-[15.5px]'>
            {message}
          </span>
        )}
        {productionUrl && (
          <a
            href={productionUrl}
            onClick={preview ? (e) => e.preventDefault() : undefined}
            className='inline-flex items-center gap-1.5 rounded-md bg-[#111827] px-3.5 py-2 text-[13.5px] font-bold text-[#facc15] transition-colors hover:bg-[#1f2937] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#111827] focus-visible:ring-offset-2 focus-visible:ring-offset-[#facc15]'
          >
            Go to production
            <ArrowUpRight className='h-3.5 w-3.5' strokeWidth={2.4} />
          </a>
        )}
      </div>
      <div aria-hidden className='w-8 shrink-0 sm:w-28' style={{ backgroundImage: TAPE }} />
    </div>
  )
}

/**
 * Inside the signed-in admin app (when the notice says so): a tape edge along the very top of the window plus a small tag,
 * and the tab title starts with the environment. Takes no layout space and no clicks.
 */
export function EnvironmentEdge({ apiBase = '' }: { apiBase?: string }) {
  const info = useInstanceEnvironment(apiBase)
  const shown = info?.inAdminApp ? info : null
  useTitlePrefix(shown ? shown.label : null)
  if (!shown) return null
  return (
    <div
      aria-hidden
      data-environment-edge
      className='pointer-events-none fixed inset-x-0 top-0 z-[60] flex justify-center'
    >
      <div className='absolute inset-x-0 top-0 h-[4px]' style={{ backgroundImage: TAPE }} />
      <span className='relative mt-[4px] rounded-b-md bg-[#facc15] px-2.5 pb-[3px] pt-[1px] text-[10.5px] font-extrabold uppercase leading-[14px] tracking-[0.14em] text-[#111827] shadow-[0_2px_6px_rgba(17,24,39,0.3)]'>
        {shown.label}
      </span>
    </div>
  )
}
