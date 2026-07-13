import { useMutation } from '@tanstack/react-query'
import { Bug, Camera, Loader2 } from 'lucide-react'
import { useState } from 'react'
import { useLocation } from 'react-router'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'

/**
 * Built-in bug reporter — floating widget that files straight into the issue
 * log. Captures a downscaled screenshot (html2canvas, lazy-loaded), the last
 * console errors/warnings (module-level ring buffer installed on import), the
 * current route and user agent.
 */

// ── Console ring buffer — patched once on module import ──────────────────────
const consoleTail: string[] = []
const MAX_TAIL = 30

function patch(kind: 'error' | 'warn') {
  const original = console[kind].bind(console)
  console[kind] = (...args: unknown[]) => {
    try {
      const line = args
        .map((a) =>
          typeof a === 'string' ? a : a instanceof Error ? a.message : JSON.stringify(a)
        )
        .join(' ')
        .slice(0, 300)
      consoleTail.push(`[${kind}] ${line}`)
      if (consoleTail.length > MAX_TAIL) consoleTail.shift()
    } catch {
      /* never break console */
    }
    original(...args)
  }
}
patch('error')
patch('warn')

const SEVERITIES = ['low', 'medium', 'high', 'critical'] as const

async function captureScreenshot(): Promise<string | null> {
  try {
    const { default: html2canvas } = await import('html2canvas')
    const canvas = await html2canvas(document.body, {
      logging: false,
      scale: Math.min(1, 1280 / window.innerWidth),
      ignoreElements: (el) => el.hasAttribute('data-bug-reporter')
    })
    return canvas.toDataURL('image/jpeg', 0.7)
  } catch (err) {
    console.warn('screenshot capture failed', err)
    return null
  }
}

export function BugReporter() {
  const location = useLocation()
  const [open, setOpen] = useState(false)
  const [description, setDescription] = useState('')
  const [severity, setSeverity] = useState<(typeof SEVERITIES)[number]>('medium')
  const [includeShot, setIncludeShot] = useState(true)
  const [shot, setShot] = useState<string | null>(null)
  const [capturing, setCapturing] = useState(false)

  async function openReporter() {
    // capture BEFORE the dialog covers the page
    setCapturing(true)
    const s = await captureScreenshot()
    setShot(s)
    setCapturing(false)
    setOpen(true)
  }

  const submit = useMutation({
    mutationFn: () => {
      const title = description.trim().split('\n')[0].slice(0, 140) || 'Bug report'
      const details = [
        description.trim(),
        '',
        `Route: ${location.pathname}`,
        `User agent: ${navigator.userAgent}`,
        `Viewport: ${window.innerWidth}×${window.innerHeight}`,
        '',
        consoleTail.length > 0 ? `Console tail:\n${consoleTail.join('\n')}` : 'Console tail: empty'
      ].join('\n')
      return api.post('/issues/', {
        title,
        severity,
        details,
        screenshot: includeShot ? shot : null
      })
    },
    onSuccess: () => {
      toast.success('Bug report filed — thank you')
      setOpen(false)
      setDescription('')
      setShot(null)
    },
    onError: (err: { response?: { data?: { error?: string } } }) =>
      toast.error(err.response?.data?.error ?? 'Could not file the report')
  })

  return (
    <>
      <button
        type='button'
        data-bug-reporter
        onClick={openReporter}
        title='Report a bug'
        className='fixed bottom-4 right-4 z-40 flex h-9 w-9 items-center justify-center rounded-full border border-slate-200 bg-white text-slate-400 shadow-sm transition-colors hover:border-red-200 hover:text-red-500 dark:border-border dark:bg-card'
      >
        {capturing ? <Loader2 className='h-4 w-4 animate-spin' /> : <Bug className='h-4 w-4' />}
      </button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className='max-w-lg' data-bug-reporter>
          <DialogHeader>
            <DialogTitle className='flex items-center gap-2'>
              <Bug className='h-4 w-4 text-red-500' /> Report a bug
            </DialogTitle>
            <DialogDescription>
              Files into the issue log with a screenshot, your route and recent console output.
            </DialogDescription>
          </DialogHeader>

          <div className='space-y-3'>
            <div className='space-y-1.5'>
              <Label htmlFor='bug-description'>What happened?</Label>
              <Textarea
                id='bug-description'
                rows={4}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder='What did you do, what did you expect, what happened instead…'
              />
            </div>

            <div className='flex items-center gap-1.5'>
              {SEVERITIES.map((s) => (
                <button
                  key={s}
                  type='button'
                  onClick={() => setSeverity(s)}
                  className={cn(
                    'rounded-full border px-2.5 py-0.5 text-[11.5px] capitalize',
                    severity === s
                      ? s === 'critical' || s === 'high'
                        ? 'border-red-300 bg-red-50 text-red-600 dark:bg-red-500/10'
                        : 'border-nvr-cyan bg-accent text-nvr-navy dark:text-nvr-cyan'
                      : 'border-slate-200 text-slate-400 dark:border-border'
                  )}
                >
                  {s}
                </button>
              ))}
            </div>

            {shot && (
              <div className='space-y-1.5'>
                <label className='flex items-center gap-2 text-[12px] text-slate-600 dark:text-slate-300'>
                  <input
                    type='checkbox'
                    checked={includeShot}
                    onChange={(e) => setIncludeShot(e.target.checked)}
                    className='accent-[#00ceff]'
                  />
                  <Camera className='h-3.5 w-3.5' /> Attach screenshot
                </label>
                {includeShot && (
                  <img
                    src={shot}
                    alt='Captured page'
                    className='max-h-40 w-full rounded-md border border-slate-200 object-cover object-top dark:border-border'
                  />
                )}
              </div>
            )}
          </div>

          <DialogFooter>
            <Button variant='outline' size='sm' onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              size='sm'
              disabled={!description.trim() || submit.isPending}
              onClick={() => submit.mutate()}
            >
              {submit.isPending && <Loader2 className='mr-1.5 h-3.5 w-3.5 animate-spin' />}
              File report
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
