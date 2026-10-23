/**
 * #1375 — export a recording: a self-contained HTML replay (downloaded now)
 * or a WebM video (made in the background; a notification brings the file).
 * An optional window (m:ss to m:ss) cuts the export; empty means the whole
 * recording. Events go out exactly as stored, so masked inputs stay masked.
 *
 * #1393 — or a Playwright spec: the server turns the window's clicks, typing
 * and page changes into the golden-path recorder's steps, which load into the
 * E2E recorder page for editing and saving.
 */
import { useMutation } from '@tanstack/react-query'
import { Download } from 'lucide-react'
import { useId, useState } from 'react'
import { useNavigate } from 'react-router'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { api } from '@/lib/api'
import { loadRecordedSteps, type RecordedStep } from '@/lib/e2e-recorder'
import { cn } from '@/lib/utils'

/** "1:23" / "1:02:03" / "83" → ms; '' → null; anything else → NaN. */
export function parseClock(raw: string): number | null {
  const s = raw.trim()
  if (!s) return null
  if (!/^\d+(:\d{1,2}){0,2}$/.test(s)) return Number.NaN
  const parts = s.split(':').map(Number)
  let secs = 0
  for (const p of parts) secs = secs * 60 + p
  return secs * 1000
}

type Format = 'html' | 'webm' | 'spec'

interface SpecResponse {
  recording_id: string
  from_ms: number | null
  to_ms: number | null
  name: string
  title: string
  steps: RecordedStep[]
  viewport: { width: number; height: number } | null
  placeholders: number
  unresolved: number
}

async function saveBlob(data: Blob, name: string) {
  const url = URL.createObjectURL(data)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  URL.revokeObjectURL(url)
}

/** The server's error from a blob response (axios hands the JSON back as a Blob). */
async function blobError(err: unknown): Promise<string | null> {
  const data = (err as { response?: { data?: unknown } })?.response?.data
  if (data instanceof Blob) {
    try {
      return (JSON.parse(await data.text()) as { error?: string }).error ?? null
    } catch {
      return null
    }
  }
  return (data as { error?: string } | undefined)?.error ?? null
}

export function RecordingExport({
  recordingId,
  className
}: {
  recordingId: string
  className?: string
}) {
  const uid = useId()
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const [format, setFormat] = useState<Format>('html')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const fromMs = parseClock(from)
  const toMs = parseClock(to)
  const badWindow =
    Number.isNaN(fromMs) ||
    Number.isNaN(toMs) ||
    (fromMs != null && toMs != null && (toMs as number) <= (fromMs as number))

  const run = useMutation({
    mutationFn: async () => {
      const body = { format, from_ms: fromMs ?? undefined, to_ms: toMs ?? undefined }
      if (format === 'spec') {
        const res = await api.post<{ data: SpecResponse }>(
          `/session-recordings/${recordingId}/spec`,
          { from_ms: body.from_ms, to_ms: body.to_ms }
        )
        const d = res.data.data
        if (d.steps.length === 0) throw new Error('Nothing to make a spec from in that window')
        loadRecordedSteps(d.steps, {
          viewport: d.viewport,
          source: {
            recordingId: d.recording_id,
            fromMs: d.from_ms,
            toMs: d.to_ms,
            name: d.name,
            title: d.title,
            placeholders: d.placeholders,
            unresolved: d.unresolved
          }
        })
        return 'spec' as const
      }
      if (format === 'html') {
        const res = await api.post(`/session-recordings/${recordingId}/export`, body, {
          responseType: 'blob'
        })
        await saveBlob(res.data as Blob, `replay-${recordingId.slice(0, 8).toLowerCase()}.html`)
        return 'html' as const
      }
      await api.post(`/session-recordings/${recordingId}/export`, body)
      return 'webm' as const
    },
    onSuccess: (kind) => {
      setOpen(false)
      if (kind === 'spec') {
        toast.success('Spec ready in the E2E recorder', {
          description: 'Fill in the masked values, then save it into an extension or download it.'
        })
        navigate('/dev-tools')
      } else if (kind === 'html') toast.success('Replay exported — open the file in any browser')
      else
        toast.success('WebM export started', {
          description: 'You will get a notification with the file when the video is ready.'
        })
    },
    onError: async (err) =>
      toast.error(
        (await blobError(err)) ?? (err instanceof Error ? err.message : null) ?? 'The export failed'
      )
  })

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          size='sm'
          variant='outline'
          className={cn('h-7 gap-1.5 text-[12px]', className)}
          data-replay-export=''
        >
          <Download className='h-3.5 w-3.5' /> Export
        </Button>
      </PopoverTrigger>
      <PopoverContent align='end' className='w-80 space-y-3 p-3'>
        <div className='flex rounded-md border border-slate-200 p-0.5 dark:border-border'>
          {(
            [
              ['html', 'HTML'],
              ['webm', 'WebM'],
              ['spec', 'Playwright spec']
            ] as const
          ).map(([v, label]) => (
            <button
              key={v}
              type='button'
              onClick={() => setFormat(v)}
              className={cn(
                'flex-1 rounded px-2 py-1 text-[12px]',
                format === v
                  ? 'bg-accent font-medium text-nvr-navy dark:text-nvr-cyan'
                  : 'text-slate-500'
              )}
            >
              {label}
            </button>
          ))}
        </div>
        <p className='text-[11.5px] text-slate-500'>
          {format === 'html'
            ? 'One file with the player and the events inside — opens offline in any browser. Inputs stay masked.'
            : format === 'webm'
              ? 'Played in a headless browser on the server and captured in real time (up to 30 minutes). You will be notified when the file is ready.'
              : 'The clicks, typing and page changes in the window as a Playwright spec, opened in the E2E recorder to edit. Typed values were masked, so each becomes a placeholder to fill in.'}
        </p>
        <div className='flex items-end gap-2'>
          <label htmlFor={`${uid}-from`} className='flex-1 text-[11px] text-slate-500'>
            From
            <Input
              id={`${uid}-from`}
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              placeholder='start'
              className='mt-0.5 h-7 font-mono text-[12px]'
            />
          </label>
          <label htmlFor={`${uid}-to`} className='flex-1 text-[11px] text-slate-500'>
            To
            <Input
              id={`${uid}-to`}
              value={to}
              onChange={(e) => setTo(e.target.value)}
              placeholder='end'
              className='mt-0.5 h-7 font-mono text-[12px]'
            />
          </label>
        </div>
        {badWindow && <p className='text-[11px] text-red-500'>Use m:ss, with From before To.</p>}
        <Button
          size='sm'
          className='h-7 w-full text-[12px]'
          disabled={badWindow || run.isPending}
          onClick={() => run.mutate()}
        >
          {run.isPending
            ? 'Working…'
            : format === 'html'
              ? 'Download HTML'
              : format === 'webm'
                ? 'Make the video'
                : 'Open in the E2E recorder'}
        </Button>
      </PopoverContent>
    </Popover>
  )
}
