import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Camera, Film, Loader2, MapPin, TerminalSquare } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useNivaroClient } from '../../context'
import { post } from '../../lib/commands'
import {
  captureProblemScreenshot,
  PROBLEM_REPORT_EXCLUDE_ATTR,
  problemConsoleTail,
  startProblemConsoleTail
} from '../../lib/problem-report'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../ui/dialog'
import type { SupportTicket } from './types'

/** The replay link a host's recorder hands back (`captureErrorClip` in @nivaro/react). */
export interface ProblemReplayLink {
  recording_id: string
  offset_ms: number | null
}

export interface ProblemReportResult {
  ticket: SupportTicket
  issue_id: number
  replay: boolean
}

interface Captured {
  screenshot: string | null
  clip: ProblemReplayLink | null
  console: string[]
  route: string
}

/**
 * "Report a problem" (#1390). One sentence from the person; the browser adds
 * what it saw — a screenshot with typed values masked, the replay of the last
 * minute when the instance records, the console tail and the page. The server
 * files an issue AND a support request that links to it, so the person can
 * follow it under My requests.
 *
 * Everything is captured the moment the dialog is asked for, before it covers
 * the page (and before the person spends a minute typing, which would roll the
 * replay window past the problem). Pass the host recorder's clip capture as
 * `captureClip`; without it the report simply carries no replay.
 */
export function ReportProblemDialog({
  open,
  onOpenChange,
  captureClip,
  app,
  onCreated
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  captureClip?: () => Promise<ProblemReplayLink | null>
  /** Which frontend this is ("efp") — shown to the desk. */
  app?: string
  onCreated?: (result: ProblemReportResult) => void
}) {
  const client = useNivaroClient()
  const qc = useQueryClient()
  const [captured, setCaptured] = useState<Captured | null>(null)
  const [capturing, setCapturing] = useState(false)
  const [description, setDescription] = useState('')
  const [includeShot, setIncludeShot] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const captureRef = useRef(captureClip)
  captureRef.current = captureClip

  // The console tail covers what happened before the dialog was opened.
  useEffect(() => {
    startProblemConsoleTail()
  }, [])

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setCapturing(true)
    setCaptured(null)
    setError(null)
    const route = window.location.pathname + window.location.search
    // Let the menu that opened us unmount before the picture is taken.
    const t = setTimeout(() => {
      void Promise.all([
        captureProblemScreenshot(),
        (captureRef.current?.() ?? Promise.resolve(null)).catch(() => null)
      ]).then(([screenshot, clip]) => {
        if (cancelled) return
        setCaptured({ screenshot, clip, console: problemConsoleTail(), route })
        setCapturing(false)
      })
    }, 60)
    return () => {
      cancelled = true
      clearTimeout(t)
    }
  }, [open])

  const reset = () => {
    setDescription('')
    setIncludeShot(true)
    setCaptured(null)
    setError(null)
  }

  const send = useMutation({
    mutationFn: () =>
      client.request<{ data: ProblemReportResult }>(
        post('/support/problem-reports', {
          description: description.trim(),
          screenshot: includeShot ? (captured?.screenshot ?? null) : null,
          console: captured?.console ?? [],
          route: captured?.route,
          app: app ?? null,
          user_agent: navigator.userAgent,
          viewport: `${window.innerWidth}×${window.innerHeight}`,
          recording_id: captured?.clip?.recording_id ?? null,
          recording_offset_ms: captured?.clip?.offset_ms ?? null
        })
      ),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ['support-tickets'] })
      void qc.invalidateQueries({ queryKey: ['support-summary'] })
      onCreated?.(r.data)
      reset()
      onOpenChange(false)
    },
    onError: (e) => setError((e as Error).message || 'Could not send the report')
  })

  const close = () => {
    reset()
    onOpenChange(false)
  }
  const canSend = description.trim().length > 0 && !send.isPending

  if (open && capturing) {
    // Left out of the screenshot it is waiting on.
    const pill = (
      <div
        {...{ [PROBLEM_REPORT_EXCLUDE_ATTR]: '' }}
        data-report-problem-capturing
        role='status'
        className='fixed bottom-4 left-1/2 z-[130] flex -translate-x-1/2 items-center gap-2 rounded-full bg-[#0f172a] px-3 py-1.5 text-[12px] text-white shadow-lg'
      >
        <Loader2 className='h-3.5 w-3.5 animate-spin' />
        Capturing the page…
      </div>
    )
    return typeof document === 'undefined' ? null : createPortal(pill, document.body)
  }

  const facts = captured
    ? [
        {
          key: 'route',
          icon: MapPin,
          label: 'The page you are on',
          detail: captured.route
        },
        captured.clip
          ? {
              key: 'replay',
              icon: Film,
              label: 'A replay of the last minute',
              detail: 'What you clicked and saw, typed values hidden'
            }
          : null,
        {
          key: 'console',
          icon: TerminalSquare,
          label:
            captured.console.length === 0
              ? 'No warnings or errors from the page'
              : captured.console.length === 1
                ? '1 warning or error from the page'
                : `${captured.console.length} warnings or errors from the page`,
          detail: null
        }
      ].filter((f): f is NonNullable<typeof f> => f !== null)
    : []

  return (
    <Dialog
      open={open && !capturing}
      onOpenChange={(o) => {
        if (!o) close()
      }}
    >
      <DialogContent
        className='max-w-xl dark:bg-card'
        data-report-problem
        {...{ [PROBLEM_REPORT_EXCLUDE_ATTR]: '' }}
      >
        <DialogHeader className='px-6 pt-5'>
          <DialogTitle className='text-[15px] font-semibold text-slate-900 dark:text-slate-100'>
            Report a problem
          </DialogTitle>
          <DialogDescription className='text-[12.5px] text-slate-500 dark:text-muted-foreground'>
            Say what went wrong in a sentence. What your screen showed goes with it, so nobody has
            to ask. You can follow the report under My requests.
          </DialogDescription>
        </DialogHeader>
        <form
          className='space-y-4 px-6 pb-5 pt-3'
          onSubmit={(e) => {
            e.preventDefault()
            if (canSend) send.mutate()
          }}
        >
          <label className='block'>
            <span className='mb-1 block text-[12px] font-medium text-slate-700 dark:text-slate-200'>
              What went wrong?
            </span>
            <textarea
              data-report-problem-description
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              maxLength={4000}
              autoFocus
              placeholder='e.g. Saving the workflow spun forever and nothing changed'
              className='w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-[13px] text-slate-900 outline-none focus:border-nvr-cyan dark:border-border dark:bg-background dark:text-slate-100'
            />
          </label>

          <div>
            <p className='mb-1.5 text-[12px] font-medium text-slate-700 dark:text-slate-200'>
              Sent with your report
            </p>
            {captured?.screenshot ? (
              <div className='mb-2 space-y-1.5' data-report-problem-shot>
                <label className='flex items-center gap-2 text-[12px] text-slate-600 dark:text-slate-300'>
                  <input
                    type='checkbox'
                    checked={includeShot}
                    onChange={(e) => setIncludeShot(e.target.checked)}
                    data-report-problem-shot-toggle
                    className='accent-[#00ceff]'
                  />
                  <Camera className='h-3.5 w-3.5' />A screenshot, typed values hidden
                </label>
                {includeShot && (
                  <img
                    src={captured.screenshot}
                    alt='Your screen when you opened this'
                    className='max-h-40 w-full rounded-md border border-slate-200 object-cover object-top dark:border-border'
                  />
                )}
              </div>
            ) : (
              <p className='mb-2 flex items-center gap-2 text-[12px] text-slate-500 dark:text-muted-foreground'>
                <Camera className='h-3.5 w-3.5' />
                No screenshot — this browser could not take one.
              </p>
            )}
            <ul className='space-y-1' data-report-problem-facts>
              {facts.map((f) => (
                <li
                  key={f.key}
                  data-report-problem-fact={f.key}
                  className='flex items-start gap-2 text-[12px] text-slate-600 dark:text-slate-300'
                >
                  <f.icon className='mt-0.5 h-3.5 w-3.5 shrink-0' />
                  <span className='min-w-0'>
                    {f.label}
                    {f.detail && (
                      <span className='block truncate text-[11.5px] text-slate-500 dark:text-muted-foreground'>
                        {f.detail}
                      </span>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          </div>

          {error && (
            <p className='text-[12px] text-red-600 dark:text-red-400' role='alert'>
              {error}
            </p>
          )}
          <div className='flex justify-end gap-2 pt-1'>
            <button
              type='button'
              onClick={close}
              className='h-8 rounded-md border border-slate-200 px-3 text-[12.5px] text-slate-700 hover:bg-slate-50 dark:border-border dark:text-slate-200 dark:hover:bg-white/5'
            >
              Cancel
            </button>
            <button
              type='submit'
              data-report-problem-send
              disabled={!canSend}
              className='inline-flex h-8 items-center gap-1.5 rounded-md border border-nvr-cyan/60 bg-nvr-cyan/10 px-3 text-[12.5px] font-medium text-nvr-navy hover:bg-nvr-cyan/15 disabled:opacity-50 dark:text-nvr-cyan'
            >
              {send.isPending && <Loader2 className='h-3.5 w-3.5 animate-spin' />}
              Send report
            </button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}
