/**
 * Element inspector for a paused replay (#1372). The replay iframe takes no
 * pointer events, so while the player is paused a transparent overlay sits
 * over it: hovering outlines the element underneath, clicking picks it and
 * opens a panel with its selector (copyable), its data-* hooks and its
 * nearest data-field / data-cbv-* ancestor — and "Find in other recordings",
 * which asks the replay index (#1374) for recordings whose clicks or typing
 * touched the same selector. Nothing typed and no text is shown: rrweb masks
 * inputs and the panel reads attributes only.
 */
import { useQuery } from '@tanstack/react-query'
import { Copy, Crosshair, ExternalLink, Search, X } from 'lucide-react'
import { type MouseEvent, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { api } from '@/lib/api'
import { formatDate } from '@/lib/utils'
import {
  boxInOverlay,
  describeElement,
  type ElementInfo,
  frameScale,
  pointInFrame
} from './inspector-logic'

/** The bits of rrweb's Replayer the inspector reads. */
export interface InspectableReplayer {
  iframe: HTMLIFrameElement
  getMirror?: () => { getId(n: Node): number }
}

type Box = { left: number; top: number; width: number; height: number }

type OtherHit = { id: string; user_name: string | null; first_ms: number }

export function ReplayInspector({
  getReplayer,
  active,
  recordingId
}: {
  getReplayer: () => InspectableReplayer | null
  /** True while the replay is paused. */
  active: boolean
  recordingId: string
}) {
  const overlayRef = useRef<HTMLDivElement>(null)
  const [hover, setHover] = useState<Box | null>(null)
  const [picked, setPicked] = useState<{
    info: ElementInfo
    box: Box
    nodeId: number | null
  } | null>(null)

  useEffect(() => {
    if (active) return
    setHover(null)
    setPicked(null)
  }, [active])

  useEffect(() => {
    if (!picked) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPicked(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [picked])

  if (!active) return null

  function locate(e: MouseEvent): { el: Element; box: Box; nodeId: number | null } | null {
    const rep = getReplayer()
    const overlay = overlayRef.current
    const doc = rep?.iframe.contentDocument
    if (!rep || !overlay || !doc) return null
    const frameRect = rep.iframe.getBoundingClientRect()
    const scale = frameScale(frameRect, rep.iframe.offsetWidth)
    const pt = pointInFrame(e.clientX, e.clientY, frameRect, scale)
    if (!pt) return null
    const el = doc.elementFromPoint?.(pt.x, pt.y)
    if (!el || el === doc.documentElement) return null
    let nodeId: number | null = null
    try {
      const id = rep.getMirror?.().getId(el)
      nodeId = typeof id === 'number' && id > 0 ? id : null
    } catch {
      /* mirror is a nicety */
    }
    const box = boxInOverlay(
      el.getBoundingClientRect(),
      frameRect,
      overlay.getBoundingClientRect(),
      scale
    )
    return { el, box, nodeId }
  }

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: a pointer tool over the replay picture; Escape closes the panel
    // biome-ignore lint/a11y/noStaticElementInteractions: same — there is no keyboard equivalent of pointing at pixels
    <div
      ref={overlayRef}
      data-replay-inspector=''
      className='absolute inset-0 z-10 cursor-crosshair'
      onMouseMove={(e) => setHover(locate(e)?.box ?? null)}
      onMouseLeave={() => setHover(null)}
      onClick={(e) => {
        const hit = locate(e)
        setPicked(hit ? { info: describeElement(hit.el), box: hit.box, nodeId: hit.nodeId } : null)
      }}
    >
      {hover && (
        <div
          className='pointer-events-none absolute rounded-sm border border-sky-400 bg-sky-400/10'
          style={hover}
        />
      )}
      {picked && (
        <div
          className='pointer-events-none absolute rounded-sm border-2 border-[#00ceff] bg-[#00ceff]/10'
          style={picked.box}
        />
      )}
      {picked ? (
        <InspectorPanel
          info={picked.info}
          nodeId={picked.nodeId}
          recordingId={recordingId}
          onClose={() => setPicked(null)}
        />
      ) : (
        <span className='pointer-events-none absolute left-2 top-2 flex items-center gap-1 rounded bg-slate-900/70 px-2 py-0.5 text-[11px] text-white'>
          <Crosshair className='h-3 w-3' /> Paused — click an element to inspect it
        </span>
      )}
    </div>
  )
}

export function InspectorPanel({
  info,
  nodeId,
  recordingId,
  onClose
}: {
  info: ElementInfo
  nodeId: number | null
  recordingId: string
  onClose: () => void
}) {
  const [finding, setFinding] = useState(false)
  // A new element starts a new question.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset on the selector changing
  useEffect(() => setFinding(false), [info.selector])
  const { data: others, isFetching } = useQuery({
    queryKey: ['replay-search', `selector=${info.selector}`],
    queryFn: () =>
      api
        .get<{ data: OtherHit[] }>('/session-recordings/search', {
          params: { selector: info.selector }
        })
        .then((r) => r.data.data),
    enabled: finding && info.anchored
  })
  const elsewhere = (others ?? []).filter((h) => h.id !== recordingId)
  const searchHref = `/session-replays?tab=search&selector=${encodeURIComponent(info.selector)}`

  function copy() {
    void navigator.clipboard
      ?.writeText(info.selector)
      .then(() => toast.success('Selector copied'))
      .catch(() => toast.error('Could not copy'))
  }

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: only stops a click from re-picking under the panel
    <div
      role='dialog'
      aria-label='Element inspector'
      className='absolute right-2 top-2 w-80 cursor-default rounded-lg border border-slate-200 bg-white p-3 text-[12px] shadow-lg dark:border-border dark:bg-card'
      onClick={(e) => e.stopPropagation()}
      onMouseMove={(e) => e.stopPropagation()}
    >
      <div className='flex items-center gap-2'>
        <span className='font-mono text-[12px] font-semibold text-nvr-navy dark:text-nvr-cyan'>
          &lt;{info.tag}&gt;
        </span>
        {nodeId != null && <span className='text-[10.5px] text-slate-400'>node #{nodeId}</span>}
        <button
          type='button'
          aria-label='Close inspector'
          className='ml-auto p-0.5 text-slate-400 hover:text-slate-600'
          onClick={onClose}
        >
          <X className='h-3.5 w-3.5' />
        </button>
      </div>

      <div className='mt-2 flex items-start gap-1.5'>
        <code className='min-w-0 flex-1 break-all rounded bg-slate-50 px-1.5 py-1 font-mono text-[11px] text-slate-700 dark:bg-muted dark:text-slate-200'>
          {info.selector}
        </code>
        <Button
          size='sm'
          variant='outline'
          className='h-6 shrink-0 gap-1 px-1.5 text-[11px]'
          onClick={copy}
        >
          <Copy className='h-3 w-3' /> Copy
        </Button>
      </div>
      {!info.anchored && (
        <p className='mt-1 text-[11px] text-amber-600 dark:text-amber-400'>
          No stable hook (data-testid, data-field, data-cbv-*, a fixed id) on it or above it — it
          cannot be found in other recordings.
        </p>
      )}

      <dl className='mt-2 space-y-1 text-[11.5px]'>
        <div className='flex gap-2'>
          <dt className='w-20 shrink-0 text-slate-400'>data-field</dt>
          <dd className='min-w-0 truncate font-mono'>{info.field ? info.field.name : '—'}</dd>
        </div>
        <div className='flex gap-2'>
          <dt className='w-20 shrink-0 text-slate-400'>data-cbv</dt>
          <dd className='min-w-0 truncate font-mono' title={info.cbv?.selector}>
            {info.cbv ? `${info.cbv.attr}${info.cbv.value ? `="${info.cbv.value}"` : ''}` : '—'}
          </dd>
        </div>
        {info.dataAttrs.length > 0 && (
          <div className='flex gap-2'>
            <dt className='w-20 shrink-0 text-slate-400'>data-*</dt>
            <dd className='min-w-0 space-y-0.5 font-mono'>
              {info.dataAttrs.slice(0, 8).map(([k, v]) => (
                <div key={k} className='truncate' title={`${k}="${v}"`}>
                  {k}
                  {v ? `="${v}"` : ''}
                </div>
              ))}
            </dd>
          </div>
        )}
      </dl>

      <div className='mt-3 border-t border-slate-100 pt-2 dark:border-border/50'>
        {!finding ? (
          <Button
            size='sm'
            variant='outline'
            className='h-7 w-full gap-1.5 text-[12px]'
            disabled={!info.anchored}
            onClick={() => setFinding(true)}
          >
            <Search className='h-3 w-3' /> Find in other recordings
          </Button>
        ) : isFetching && !others ? (
          <p className='text-[11.5px] text-slate-400'>Searching…</p>
        ) : elsewhere.length === 0 ? (
          <p className='text-[11.5px] text-slate-400'>No other recording touched this element.</p>
        ) : (
          <>
            <p className='mb-1 text-[11px] font-medium text-slate-500'>
              {elsewhere.length} other recording{elsewhere.length === 1 ? '' : 's'}
            </p>
            <ul className='space-y-0.5 text-[11.5px]'>
              {elsewhere.slice(0, 6).map((h) => (
                <li key={h.id} className='flex gap-2'>
                  <span className='min-w-0 flex-1 truncate'>{h.user_name || 'Unknown'}</span>
                  <span className='shrink-0 text-slate-400'>
                    {formatDate(new Date(h.first_ms))}
                  </span>
                </li>
              ))}
            </ul>
            <a
              href={searchHref}
              target='_blank'
              rel='noreferrer'
              className='mt-1.5 inline-flex items-center gap-1 text-[11.5px] text-nvr-navy hover:underline dark:text-nvr-cyan'
            >
              Open in Search <ExternalLink className='h-3 w-3' />
            </a>
          </>
        )}
      </div>
    </div>
  )
}
