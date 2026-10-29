import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Compass, X } from 'lucide-react'
import {
  type RefObject,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from 'react'
import { createPortal } from 'react-dom'
import { useNivaroClient } from '../../context'
import { get, patch } from '../../lib/commands'
import { cn } from '../../lib/utils'

/**
 * First-use form tour (#3192). A form whose layout turns the tour on
 * (entry_config.tour) walks a person through its sections the first time they
 * open it: one step per section on screen, in page order, with the section's
 * name and its help text (or, without help text, the fields it holds). Finishing
 * or dismissing it stores the layout id in the person's preferences
 * (form_tours_done, PATCH /users/me/preferences {form_tour_done}) so it never
 * starts on its own again, on any device; the Tour button replays it.
 *
 * Steps follow the DOM, not the layout list: a section in another tab, a step
 * not reached yet or a section hidden by its rules is simply not on the tour.
 */

export interface TourGroup {
  key: string
  label: string
  type: string
  content?: string | null
  content_tone?: string | null
}

export interface TourField {
  field: string
  label?: string | null
  required?: unknown
  hidden?: unknown
}

export interface TourStep {
  key: string
  title: string
  body: string
  required: number
}

const BODY_MAX = 280
const NAMES_SHOWN = 4

function listWords(names: string[]): string {
  if (names.length <= 1) return names[0] ?? ''
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}

/** The tour's text for every section that can hold fields, keyed by section key. */
export function buildTourSteps(
  groups: TourGroup[],
  fieldsByGroup: Record<string, TourField[]>
): Map<string, TourStep> {
  const out = new Map<string, TourStep>()
  for (const g of groups) {
    if (g.type !== 'section' && g.type !== 'tab' && g.type !== 'metadata') continue
    const fields = (fieldsByGroup[g.key] ?? []).filter((f) => !f.hidden)
    const names = fields.map((f) => (f.label || f.field).trim()).filter(Boolean)
    const required = fields.filter((f) => f.required).length
    const help = g.content_tone === 'divider' ? '' : (g.content ?? '').trim()
    let body: string
    if (help) body = help.length > BODY_MAX ? `${help.slice(0, BODY_MAX - 1).trimEnd()}…` : help
    else if (g.type === 'metadata') body = 'Facts about the record itself: who made it and when.'
    else if (names.length === 0) body = 'Nothing to fill in here yet.'
    else {
      const shown = names.slice(0, NAMES_SHOWN)
      const more = names.length - shown.length
      body =
        names.length === 1
          ? `One field: ${shown[0]}.`
          : `${names.length} fields: ${more > 0 ? `${shown.join(', ')} and ${more} more` : listWords(shown)}.`
    }
    out.set(g.key, { key: g.key, title: g.label || 'Section', body, required })
  }
  return out
}

/** Section keys on screen inside `root`, in page order (edit form and summary view). */
export function sectionKeysOnScreen(root: ParentNode | null): string[] {
  if (!root) return []
  const keys: string[] = []
  for (const el of root.querySelectorAll<HTMLElement>('[data-section-key], [data-read-section]')) {
    if (el.hidden || el.closest('[hidden]') || el.classList.contains('hidden')) continue
    const key = el.getAttribute('data-section-key') ?? el.getAttribute('data-read-section')
    if (key && !keys.includes(key)) keys.push(key)
  }
  return keys
}

function sectionEl(root: ParentNode | null, key: string): HTMLElement | null {
  if (!root) return null
  const k =
    typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(key) : key.replace(/["\\]/g, '\\$&')
  return root.querySelector<HTMLElement>(`[data-section-key="${k}"], [data-read-section="${k}"]`)
}

const LOCAL = (userId: string, layoutId: number) => `nvr:form-tour:${userId}:${layoutId}`

function readLocal(key: string): boolean {
  try {
    return localStorage.getItem(key) === '1'
  } catch {
    return false
  }
}

const reducedMotion = () => {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches
  } catch {
    return false
  }
}

/** Has this person toured this form yet, and the switch to say they have. */
export function useFormTourSeen(args: {
  layoutId: number | null
  userId: string
  enabled: boolean
}) {
  const { layoutId, userId, enabled } = args
  const client = useNivaroClient()
  const qc = useQueryClient()
  const local = layoutId != null ? LOCAL(userId, layoutId) : ''
  const [localSeen, setLocalSeen] = useState(() => (local ? readLocal(local) : false))
  useEffect(() => setLocalSeen(local ? readLocal(local) : false), [local])
  const { data: done, isSuccess } = useQuery<number[]>({
    queryKey: ['form-tours-done', userId],
    queryFn: () =>
      client
        .request<{ data?: { preferences?: { form_tours_done?: unknown } | null } }>(get('/auth/me'))
        .then((r) => {
          const v = r?.data?.preferences?.form_tours_done
          return Array.isArray(v) ? v.filter((n): n is number => Number.isInteger(n)) : []
        }),
    enabled: enabled && layoutId != null && !localSeen,
    staleTime: 5 * 60_000
  })
  const seen = localSeen || (layoutId != null && !!done?.includes(layoutId))
  const markSeen = useCallback(() => {
    if (layoutId == null) return
    setLocalSeen(true)
    try {
      localStorage.setItem(LOCAL(userId, layoutId), '1')
    } catch {
      // storage blocked: the server copy below still holds it
    }
    qc.setQueryData<number[]>(['form-tours-done', userId], (cur) =>
      cur?.includes(layoutId) ? cur : [...(cur ?? []), layoutId]
    )
    client
      .request(patch('/users/me/preferences', { form_tour_done: layoutId }))
      .catch(() => undefined)
  }, [client, qc, layoutId, userId])
  return { seen, known: localSeen || isSuccess, markSeen }
}

/** The quiet "Tour" button that replays the tour. */
export function FormTourButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type='button'
      data-form-tour-button=''
      data-tip='A short walk through this form'
      onClick={onClick}
      className='inline-flex h-6 items-center gap-1 rounded px-2 text-[11.5px] font-medium text-slate-500 transition-colors hover:bg-muted hover:text-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-600 dark:text-muted-foreground dark:hover:text-foreground dark:focus-visible:ring-sky-300'
    >
      <Compass className='h-3.5 w-3.5' aria-hidden='true' />
      Tour
    </button>
  )
}

type Box = { top: number; left: number; width: number; height: number }

const CARD_W = 320
const GAP = 10

/**
 * The tour itself: a card beside the current section (a sheet at the bottom on a
 * phone) and a ring around the section. Portaled to body: the page outlet's
 * entrance transform would otherwise become its containing block.
 */
export function FormTour({
  rootRef,
  steps,
  formName,
  onClose
}: {
  rootRef: RefObject<HTMLElement | null>
  steps: Map<string, TourStep>
  formName: string
  /** `finished` = the last step's Done; otherwise skipped / closed. */
  onClose: (finished: boolean) => void
}) {
  const titleId = useId()
  const cardRef = useRef<HTMLDivElement>(null)
  // Read once the form is on screen (the ref is set by then); fixed for the whole tour.
  const [found, setFound] = useState<string[] | null>(null)
  // biome-ignore lint/correctness/useExhaustiveDependencies: the steps are fixed when the tour opens
  useEffect(() => {
    setFound(sectionKeysOnScreen(rootRef.current).filter((k) => steps.has(k)))
  }, [])
  const keys = found ?? []
  const [at, setAt] = useState(0)
  const [box, setBox] = useState<Box | null>(null)
  const [narrow, setNarrow] = useState(
    () => typeof window !== 'undefined' && window.innerWidth < 640
  )
  const key = keys[at]
  const step = key ? steps.get(key) : undefined

  // Nothing on screen to tour: close at once (counts as seen; nothing would ever show).
  useEffect(() => {
    if (found && found.length === 0) onClose(false)
  }, [found, onClose])

  // Bring the section into view, then follow it while the page scrolls or resizes.
  useLayoutEffect(() => {
    if (!key) return
    const el = sectionEl(rootRef.current, key)
    if (!el) return
    // A tall section scrolls to its heading; a short one to the middle of the screen.
    const tall = el.getBoundingClientRect().height > window.innerHeight * 0.6
    el.scrollIntoView({
      block: tall ? 'start' : 'center',
      behavior: reducedMotion() ? 'auto' : 'smooth'
    })
    let raf = 0
    const measure = () => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => {
        const r = el.getBoundingClientRect()
        setBox({ top: r.top, left: r.left, width: r.width, height: r.height })
        setNarrow(window.innerWidth < 640)
      })
    }
    measure()
    window.addEventListener('scroll', measure, true)
    window.addEventListener('resize', measure)
    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('scroll', measure, true)
      window.removeEventListener('resize', measure)
    }
  }, [key, rootRef])

  // Focus moves into the card once it shows, and back to where it was when the tour ends.
  const shown = !!step
  useEffect(() => {
    if (!shown) return
    const before = document.activeElement as HTMLElement | null
    cardRef.current?.focus({ preventScroll: true })
    return () => before?.focus?.({ preventScroll: true })
  }, [shown])

  const last = at >= keys.length - 1
  const next = useCallback(() => {
    if (last) onClose(true)
    else setAt((i) => i + 1)
  }, [last, onClose])
  const back = useCallback(() => setAt((i) => Math.max(0, i - 1)), [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Only while the card (or nothing) has focus: typing in a field keeps its arrows.
      const focus = document.activeElement
      if (focus && focus !== document.body && !cardRef.current?.contains(focus)) return
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose(false)
      } else if (e.key === 'ArrowRight' && !e.altKey && !e.metaKey && !e.ctrlKey) next()
      else if (e.key === 'ArrowLeft' && !e.altKey && !e.metaKey && !e.ctrlKey) back()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [next, back, onClose])

  const place = useMemo(() => {
    if (!box || narrow || typeof window === 'undefined') return null
    const vw = window.innerWidth
    const vh = window.innerHeight
    const left = Math.min(Math.max(12, box.left + 16), vw - CARD_W - 12)
    // Below the section's heading when it fits, else above the section, else pinned.
    const below = box.top + Math.min(box.height, 52) + GAP
    if (below + 200 < vh) return { top: Math.max(12, below), left }
    if (box.top - GAP - 200 > 0) return { bottom: vh - box.top + GAP, left }
    return { top: 12, left }
  }, [box, narrow])

  if (!step || typeof document === 'undefined') return null

  return createPortal(
    <>
      {box && (
        <div
          aria-hidden='true'
          data-form-tour-ring=''
          className='pointer-events-none fixed z-[70] rounded-xl ring-2 ring-nvr-cyan ring-offset-2 ring-offset-white transition-[top,left,width,height] duration-200 motion-reduce:transition-none dark:ring-offset-background'
          style={{
            top: box.top,
            left: box.left,
            width: box.width,
            height: Math.min(box.height, window.innerHeight - Math.max(0, box.top) + 8)
          }}
        />
      )}
      <div
        ref={cardRef}
        role='dialog'
        aria-modal='false'
        aria-labelledby={titleId}
        tabIndex={-1}
        data-form-tour=''
        data-form-tour-step={step.key}
        className={cn(
          'fixed z-[71] rounded-xl border border-slate-200 bg-white p-4 shadow-lg outline-none dark:border-border dark:bg-card',
          narrow ? 'inset-x-3 bottom-3' : 'w-[320px]'
        )}
        style={narrow || !place ? undefined : place}
      >
        <div className='flex items-start gap-2'>
          <div className='min-w-0 flex-1'>
            <p className='text-[11px] font-medium text-slate-500 dark:text-muted-foreground'>
              {at === 0 && formName ? `${formName} · ` : ''}
              {at + 1} of {keys.length}
            </p>
            <h2
              id={titleId}
              className='mt-0.5 text-[14px] font-semibold text-slate-900 dark:text-foreground'
            >
              {step.title}
            </h2>
          </div>
          <button
            type='button'
            aria-label='Close the tour'
            data-form-tour-close=''
            onClick={() => onClose(false)}
            className='-mr-1 -mt-1 rounded p-1 text-slate-400 transition-colors hover:bg-muted hover:text-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-600 dark:hover:text-foreground dark:focus-visible:ring-sky-300'
          >
            <X className='h-4 w-4' />
          </button>
        </div>
        <p className='mt-2 whitespace-pre-wrap text-[12.5px] leading-relaxed text-slate-600 dark:text-muted-foreground'>
          {step.body}
        </p>
        {step.required > 0 && (
          <p className='mt-1.5 text-[12px] text-slate-500 dark:text-muted-foreground'>
            {step.required === 1 ? 'One field here is' : `${step.required} fields here are`}{' '}
            required <span className='text-destructive'>*</span>
          </p>
        )}
        <div className='mt-3 flex items-center gap-2'>
          {at === 0 ? (
            <button
              type='button'
              data-form-tour-skip=''
              onClick={() => onClose(false)}
              className='h-8 rounded-md px-2.5 text-[12.5px] font-medium text-slate-500 transition-colors hover:bg-muted hover:text-slate-800 dark:text-muted-foreground dark:hover:text-foreground'
            >
              Skip tour
            </button>
          ) : (
            <button
              type='button'
              data-form-tour-back=''
              onClick={back}
              className='h-8 rounded-md px-2.5 text-[12.5px] font-medium text-slate-600 transition-colors hover:bg-muted hover:text-slate-900 dark:text-muted-foreground dark:hover:text-foreground'
            >
              Back
            </button>
          )}
          <span className='flex-1' />
          <button
            type='button'
            data-form-tour-next=''
            onClick={next}
            className='h-8 rounded-md bg-nvr-cyan px-3 text-[12.5px] font-medium text-white transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-600 focus-visible:ring-offset-2 dark:focus-visible:ring-sky-300 dark:focus-visible:ring-offset-card'
          >
            {last ? 'Done' : 'Next'}
          </button>
        </div>
      </div>
    </>,
    document.body
  )
}
