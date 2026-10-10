import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Camera, Loader2, MessageSquareWarning } from 'lucide-react'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useNivaroClient } from '../../context'
import { post } from '../../lib/commands'
import {
  type PreparedReplayClip,
  prepareReplayClip,
  type ReplayLink
} from '../../lib/replay-capture'
import { installReplayTail } from '../../lib/replay-tail'
import { captureMaskedScreenshot } from '../../lib/screenshot'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../ui/dialog'
import { collectSupportContext } from './support-context'
import type { SupportTicket } from './types'

/**
 * Report a problem (#1390) — the shared control a portal shell mounts
 * (exported from @nivaro/react), built on the admin's bug reporter.
 *
 * The person writes one sentence. With it go: a screenshot of the page taken
 * BEFORE the dialog covers it, every typed value masked (html2canvas, an
 * optional peer); the replay of the last minute when error replay is on (or
 * the live recording's moment); the console tail and the last twenty
 * requests; and the route. POST /support/report-problem files an ISSUE
 * (source client, raised by the person) and a support request linked to it,
 * which they follow under My requests. They can leave the screenshot and the
 * "what I was doing" context out.
 */

export interface ReportProblemPayload {
  sentence: string
  route: string
  app?: string
  screenshot: string | null
  context: string | null
  attachments: string[]
  replay?: ReplayLink
}

/** The POST /support/report-problem body (exported for tests). */
export function buildReportPayload(input: {
  sentence: string
  route: string
  app?: string | null
  screenshot: string | null
  includeShot: boolean
  context: { text: string; fileId: string | null; replay: ReplayLink | null } | null
}): ReportProblemPayload {
  return {
    sentence: input.sentence.trim().slice(0, 2000),
    route: input.route.split('#')[0].slice(0, 300),
    ...(input.app ? { app: input.app.slice(0, 50) } : {}),
    screenshot: input.includeShot ? input.screenshot : null,
    context: input.context?.text ?? null,
    attachments: input.context?.fileId ? [input.context.fileId] : [],
    ...(input.context?.replay ? { replay: input.context.replay } : {})
  }
}

export function ReportProblemButton({
  app,
  floating = true,
  className,
  children,
  onReported
}: {
  /** Your front end's label ('efp'), stored with the report. */
  app?: string
  /** Pin a round button to the bottom-right corner (default) or render inline. */
  floating?: boolean
  className?: string
  /** Inline trigger content (when `floating` is false). */
  children?: ReactNode
  onReported?: (r: { ticket: SupportTicket; issue_id: number }) => void
}) {
  const client = useNivaroClient()
  const qc = useQueryClient()
  const [open, setOpen] = useState(false)
  const [capturing, setCapturing] = useState(false)
  const [sentence, setSentence] = useState('')
  const [shot, setShot] = useState<string | null>(null)
  const [includeShot, setIncludeShot] = useState(true)
  const [withContext, setWithContext] = useState(true)
  const [done, setDone] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const moment = useRef<{ clip: PreparedReplayClip; route: string } | null>(null)

  useEffect(() => {
    installReplayTail()
  }, [])

  async function openReporter() {
    // The moment and the picture are taken BEFORE the dialog covers the page.
    moment.current = {
      clip: prepareReplayClip('support'),
      route: window.location.pathname + window.location.search
    }
    setCapturing(true)
    setShot(await captureMaskedScreenshot({ ignoreAttr: 'data-report-problem' }))
    setCapturing(false)
    setDone(null)
    setError(null)
    setOpen(true)
  }

  function reset() {
    setSentence('')
    setShot(null)
    setIncludeShot(true)
    setWithContext(true)
    setError(null)
    moment.current = null
  }

  const send = useMutation({
    mutationFn: async () => {
      const m = moment.current
      const route = m?.route ?? window.location.pathname
      const context = withContext
        ? await collectSupportContext({
            clip: m?.clip ?? null,
            route,
            upload: (file) => client.upload(file, { title: 'What they saw' }),
            userAgent: navigator.userAgent
          })
        : null
      const body = buildReportPayload({
        sentence,
        route,
        app,
        screenshot: shot,
        includeShot,
        context
      })
      return client.request<{ data: { ticket: SupportTicket; issue_id: number } }>(
        post('/support/report-problem', body)
      )
    },
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ['support-tickets'] })
      void qc.invalidateQueries({ queryKey: ['support-summary'] })
      onReported?.(r.data)
      setDone(r.data.ticket.id)
      reset()
    },
    onError: (e) => setError((e as Error).message || 'Could not send the report')
  })

  const trigger = floating ? (
    <button
      type='button'
      data-report-problem
      data-nvr-recording-hide
      onClick={() => void openReporter()}
      title='Report a problem'
      aria-label='Report a problem'
      className={
        className ??
        'fixed bottom-4 right-4 z-40 flex h-9 w-9 items-center justify-center rounded-full border border-slate-200 bg-white text-slate-500 shadow-sm transition-colors hover:border-amber-300 hover:text-amber-600 dark:border-border dark:bg-card'
      }
    >
      {capturing ? (
        <Loader2 className='h-4 w-4 animate-spin' />
      ) : (
        <MessageSquareWarning className='h-4 w-4' />
      )}
    </button>
  ) : (
    <button
      type='button'
      data-report-problem
      onClick={() => void openReporter()}
      className={className}
    >
      {capturing ? <Loader2 className='h-4 w-4 animate-spin' /> : (children ?? 'Report a problem')}
    </button>
  )

  return (
    <>
      {floating && typeof document !== 'undefined' ? createPortal(trigger, document.body) : trigger}
      <Dialog
        open={open}
        onOpenChange={(o) => {
          if (!o) reset()
          setOpen(o)
        }}
      >
        <DialogContent className='max-w-lg dark:bg-card' data-report-problem>
          <DialogHeader className='px-6 pt-5'>
            <DialogTitle className='flex items-center gap-2 text-[15px] font-semibold text-slate-900 dark:text-slate-100'>
              <MessageSquareWarning className='h-4 w-4 text-amber-500' /> Report a problem
            </DialogTitle>
            <DialogDescription className='text-[12.5px] text-slate-500 dark:text-muted-foreground'>
              Tell us what went wrong. You can follow it under My requests.
            </DialogDescription>
          </DialogHeader>
          {done != null ? (
            <div className='space-y-3 px-6 pb-5 pt-2' data-report-problem-done={done}>
              <p className='text-[13px] text-slate-700 dark:text-slate-200'>
                Thanks — request #{done} is with the team. You can follow it under My requests.
              </p>
              <div className='flex justify-end'>
                <button
                  type='button'
                  onClick={() => setOpen(false)}
                  className='h-8 rounded-md border border-slate-200 px-3 text-[12.5px] text-slate-700 hover:bg-slate-50 dark:border-border dark:text-slate-200 dark:hover:bg-white/5'
                >
                  Close
                </button>
              </div>
            </div>
          ) : (
            <form
              className='space-y-3 px-6 pb-5 pt-2'
              onSubmit={(e) => {
                e.preventDefault()
                if (sentence.trim() && !send.isPending) send.mutate()
              }}
            >
              <label className='block'>
                <span className='mb-1 block text-[12px] font-medium text-slate-700 dark:text-slate-200'>
                  What went wrong?
                </span>
                <textarea
                  data-report-problem-sentence
                  value={sentence}
                  onChange={(e) => setSentence(e.target.value)}
                  rows={3}
                  maxLength={2000}
                  placeholder='e.g. The upload spins forever after I pick a file'
                  className='w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-[13px] text-slate-900 outline-none focus:border-nvr-cyan dark:border-border dark:bg-background dark:text-slate-100'
                />
              </label>
              {shot && (
                <div className='space-y-1.5'>
                  <label className='flex items-center gap-2 text-[12px] text-slate-600 dark:text-slate-300'>
                    <input
                      type='checkbox'
                      checked={includeShot}
                      onChange={(e) => setIncludeShot(e.target.checked)}
                      className='accent-[#00ceff]'
                    />
                    <Camera className='h-3.5 w-3.5' /> Attach a screenshot (typed values hidden)
                  </label>
                  {includeShot && (
                    <img
                      src={shot}
                      alt='The page as it was'
                      className='max-h-36 w-full rounded-md border border-slate-200 object-cover object-top dark:border-border'
                    />
                  )}
                </div>
              )}
              <label className='flex items-start gap-2 text-[12px] text-slate-600 dark:text-slate-300'>
                <input
                  type='checkbox'
                  checked={withContext}
                  onChange={(e) => setWithContext(e.target.checked)}
                  className='mt-0.5 accent-[#00ceff]'
                />
                <span>
                  Include what I was doing
                  <span className='block text-[11px] text-slate-400'>
                    The page, recent errors and requests, and (when replay is on) the last minute of
                    this screen with every typed value hidden.
                  </span>
                </span>
              </label>
              {error && (
                <p className='text-[12px] text-red-600 dark:text-red-400' role='alert'>
                  {error}
                </p>
              )}
              <div className='flex justify-end gap-2 pt-1'>
                <button
                  type='button'
                  onClick={() => setOpen(false)}
                  className='h-8 rounded-md border border-slate-200 px-3 text-[12.5px] text-slate-700 hover:bg-slate-50 dark:border-border dark:text-slate-200 dark:hover:bg-white/5'
                >
                  Cancel
                </button>
                <button
                  type='submit'
                  data-report-problem-send
                  disabled={!sentence.trim() || send.isPending}
                  className='inline-flex h-8 items-center gap-1.5 rounded-md border border-nvr-cyan/60 bg-nvr-cyan/10 px-3 text-[12.5px] font-medium text-nvr-navy hover:bg-nvr-cyan/15 disabled:opacity-50 dark:text-nvr-cyan'
                >
                  {send.isPending && <Loader2 className='h-3.5 w-3.5 animate-spin' />}
                  Send
                </button>
              </div>
            </form>
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}
