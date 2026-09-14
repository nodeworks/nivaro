import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Braces, RotateCcw } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useNivaroClient } from '../../context'
import { del, get, post, put } from '../../lib/commands'
import { cn } from '../../lib/utils'

/**
 * In-app notification templates (admin): pick an event, edit its Liquid
 * wording (first line = subject, rest = message), see it rendered against a
 * REAL recent sample from this database, save an override or revert to the
 * code's default. Backed by /notification-templates. Needs `<NivaroProvider>`.
 */

interface EventRow {
  key: string
  label: string
  description: string
  category: string
  tokens: Array<{ name: string; description: string }>
  overridden: boolean
  updated_at: string | null
}
interface EventDetail extends EventRow {
  default_template: string
  body: string
  sample: Record<string, unknown>
  sample_is_real: boolean
}

export interface NotificationTemplatesViewProps {
  onNotice?: (message: string) => void
  onError?: (message: string) => void
  className?: string
  /** Embedded inside another page (no page header). */
  embedded?: boolean
}

export function NotificationTemplatesView({
  onNotice,
  onError,
  className,
  embedded
}: NotificationTemplatesViewProps) {
  const client = useNivaroClient()
  const qc = useQueryClient()
  const [selected, setSelected] = useState<string | null>(null)
  const [body, setBody] = useState('')
  const [dataOpen, setDataOpen] = useState(false)
  const [dataText, setDataText] = useState('')
  const [preview, setPreview] = useState<{ subject: string; message: string } | null>(null)
  const [previewError, setPreviewError] = useState<string | null>(null)

  const { data: events = [] } = useQuery({
    queryKey: ['notification-templates'],
    queryFn: () =>
      client.request<{ data: EventRow[] }>(get('/notification-templates')).then((r) => r.data)
  })
  useEffect(() => {
    if (!selected && events.length > 0) setSelected(events[0].key)
  }, [events, selected])

  const { data: detail } = useQuery({
    queryKey: ['notification-template', selected],
    queryFn: () =>
      client
        .request<{ data: EventDetail }>(get(`/notification-templates/${selected}`))
        .then((r) => r.data),
    enabled: !!selected
  })
  useEffect(() => {
    if (detail) {
      setBody(detail.body)
      setDataText('')
      setPreview(null)
      setPreviewError(null)
    }
  }, [detail])

  const parsedData = (() => {
    const t = dataText.trim()
    if (!t) return { value: null as Record<string, unknown> | null, error: false }
    try {
      const v = JSON.parse(t)
      return v && typeof v === 'object' && !Array.isArray(v)
        ? { value: v as Record<string, unknown>, error: false }
        : { value: null, error: true }
    } catch {
      return { value: null, error: true }
    }
  })()

  const previewMut = useMutation({
    mutationFn: () =>
      client.request<{ data: { subject: string; message: string } }>(
        post(`/notification-templates/${selected}/preview`, {
          body,
          ...(parsedData.value ? { data: parsedData.value } : {})
        })
      ),
    onSuccess: (r) => {
      setPreview(r.data)
      setPreviewError(null)
    },
    onError: (e) => {
      setPreview(null)
      setPreviewError(
        (e as { response?: { error?: string } })?.response?.error ?? 'Template failed to render'
      )
    }
  })
  // Live preview: re-render 400ms after the last keystroke (dataText is a
  // real input: mutationFn reads the parsed override at call time).
  // biome-ignore lint/correctness/useExhaustiveDependencies: debounce keyed on the inputs, not the mutation object
  useEffect(() => {
    if (!selected || !body.trim()) return
    const t = setTimeout(() => previewMut.mutate(), 400)
    return () => clearTimeout(t)
  }, [body, dataText, selected])

  const saveMut = useMutation({
    mutationFn: () => client.request(put(`/notification-templates/${selected}`, { body })),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['notification-templates'] })
      void qc.invalidateQueries({ queryKey: ['notification-template', selected] })
      onNotice?.('Template saved — new notifications use this wording')
    },
    onError: (e) =>
      onError?.((e as { response?: { error?: string } })?.response?.error ?? 'Save failed')
  })
  const revertMut = useMutation({
    mutationFn: () => client.request(del(`/notification-templates/${selected}`)),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['notification-templates'] })
      void qc.invalidateQueries({ queryKey: ['notification-template', selected] })
      onNotice?.('Reverted to the default wording')
    },
    onError: () => onError?.('Revert failed')
  })

  const dirty = detail ? body !== detail.body : false

  return (
    <div className={cn('flex flex-1 min-h-0 flex-col', className)} data-nvr-notification-templates>
      {!embedded && (
        <header className='shrink-0 border-b border-slate-200 bg-white px-6 py-4 dark:border-border dark:bg-card'>
          <h1 className='text-[17px] font-semibold text-slate-900 dark:text-foreground'>
            Notification templates
          </h1>
          <p className='mt-0.5 text-[12.5px] text-slate-500 dark:text-muted-foreground'>
            The wording of every in-app notification, previewed against a real recent example. First
            line is the subject, the rest is the message.
          </p>
        </header>
      )}
      <div className='flex flex-1 min-h-0 overflow-hidden'>
        <aside className='w-[260px] shrink-0 overflow-y-auto border-r border-slate-200 bg-white py-2 dark:border-border dark:bg-card'>
          {events.map((e) => (
            <button
              key={e.key}
              type='button'
              onClick={() => setSelected(e.key)}
              className={cn(
                'flex w-full flex-col items-start gap-0.5 px-4 py-2 text-left',
                selected === e.key
                  ? 'bg-nvr-cyan/10 text-slate-900 dark:text-foreground'
                  : 'text-slate-600 hover:bg-slate-50 dark:text-muted-foreground dark:hover:bg-muted/50'
              )}
            >
              <span className='flex w-full items-center gap-2'>
                <span className='min-w-0 flex-1 truncate text-[12.5px] font-medium'>{e.label}</span>
                {e.overridden && (
                  <span className='shrink-0 rounded-full bg-amber-100 px-1.5 py-px text-[9.5px] font-semibold uppercase text-amber-700 dark:bg-amber-500/15 dark:text-amber-400'>
                    edited
                  </span>
                )}
              </span>
              <span className='font-mono text-[10.5px] text-slate-400'>{e.key}</span>
            </button>
          ))}
        </aside>
        <div className='flex flex-1 min-w-0 flex-col overflow-y-auto bg-slate-50 dark:bg-background'>
          {!detail ? (
            <p className='p-6 text-[13px] text-slate-400'>Pick an event.</p>
          ) : (
            <div className='grid flex-1 grid-cols-1 gap-4 p-5 xl:grid-cols-2'>
              <div className='space-y-3'>
                <div>
                  <p className='text-[13px] font-semibold text-slate-800 dark:text-foreground'>
                    {detail.label}
                  </p>
                  <p className='text-[12px] text-slate-500 dark:text-muted-foreground'>
                    {detail.description}
                  </p>
                </div>
                <div className='flex flex-wrap gap-1'>
                  {detail.tokens.map((t) => (
                    <button
                      key={t.name}
                      type='button'
                      title={t.description}
                      data-tip={t.description}
                      onClick={() => setBody((b) => `${b}{{ ${t.name} }}`)}
                      className='rounded border border-slate-200 bg-white px-1.5 py-0.5 font-mono text-[11px] text-slate-700 hover:border-nvr-cyan dark:border-border dark:bg-card dark:text-foreground'
                    >
                      {`{{ ${t.name} }}`}
                    </button>
                  ))}
                </div>
                <textarea
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                  spellCheck={false}
                  rows={10}
                  className='w-full resize-y rounded-md border border-slate-200 bg-white p-3 font-mono text-[12px] leading-relaxed focus:border-nvr-cyan focus:outline-none dark:border-border dark:bg-card'
                  data-nvr-template-body
                />
                <div className='flex flex-wrap items-center gap-2'>
                  <button
                    type='button'
                    disabled={!dirty || saveMut.isPending || !body.trim()}
                    onClick={() => saveMut.mutate()}
                    className='h-8 rounded-md bg-nvr-cyan px-3 text-[12px] font-semibold text-white disabled:opacity-40'
                  >
                    {saveMut.isPending ? 'Saving…' : 'Save override'}
                  </button>
                  {detail.overridden && (
                    <button
                      type='button'
                      disabled={revertMut.isPending}
                      onClick={() => revertMut.mutate()}
                      className='inline-flex h-8 items-center gap-1 rounded-md border border-slate-200 px-3 text-[12px] font-medium text-slate-700 hover:bg-slate-100 dark:border-border dark:text-foreground dark:hover:bg-muted'
                    >
                      <RotateCcw className='h-3.5 w-3.5' />
                      Revert to default
                    </button>
                  )}
                  {!detail.overridden && (
                    <span className='text-[11.5px] text-slate-400'>
                      Showing the default wording — edit and save to override.
                    </span>
                  )}
                  <span className='flex-1' />
                  <button
                    type='button'
                    onClick={() => setDataOpen((v) => !v)}
                    className='inline-flex items-center gap-1 text-[11.5px] text-slate-500 underline decoration-dotted underline-offset-2'
                  >
                    <Braces className='h-3 w-3' />
                    {dataOpen ? 'Hide' : 'Override'} sample data
                  </button>
                </div>
                {dataOpen && (
                  <div>
                    <textarea
                      value={dataText}
                      onChange={(e) => setDataText(e.target.value)}
                      placeholder={JSON.stringify(detail.sample, null, 2)}
                      spellCheck={false}
                      rows={6}
                      className={cn(
                        'w-full resize-y rounded-md border bg-white p-2 font-mono text-[11px] dark:bg-card',
                        parsedData.error ? 'border-red-400' : 'border-slate-200 dark:border-border'
                      )}
                    />
                    <p className='mt-1 text-[11px] text-slate-400'>
                      JSON merged over the sample below. Empty = the sample as-is.
                    </p>
                  </div>
                )}
              </div>
              <div className='space-y-3'>
                <div className='rounded-lg border border-slate-200 bg-white dark:border-border dark:bg-card'>
                  <header className='flex items-center gap-2 border-b border-slate-100 px-4 py-2.5 dark:border-border/60'>
                    <h3 className='text-[13px] font-semibold text-slate-800 dark:text-slate-100'>
                      Preview
                    </h3>
                    <span
                      className={cn(
                        'rounded-full px-1.5 py-px text-[9.5px] font-semibold uppercase',
                        detail.sample_is_real
                          ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400'
                          : 'bg-slate-500/10 text-slate-500'
                      )}
                    >
                      {detail.sample_is_real ? 'real sample' : 'placeholder sample'}
                    </span>
                  </header>
                  <div className='p-4'>
                    {previewError ? (
                      <p className='text-[12px] text-red-600 dark:text-red-400'>{previewError}</p>
                    ) : preview ? (
                      <div className='rounded-lg border border-slate-200 p-3 dark:border-border'>
                        <div className='flex items-start gap-2.5'>
                          <span className='mt-1.5 h-2 w-2 shrink-0 rounded-full bg-nvr-cyan' />
                          <div className='min-w-0'>
                            <p className='text-[12.5px] font-medium text-slate-900 dark:text-foreground'>
                              {preview.subject || <em className='text-red-500'>(empty subject)</em>}
                            </p>
                            {preview.message && (
                              <p className='mt-0.5 whitespace-pre-wrap text-[11.5px] leading-snug text-slate-500'>
                                {preview.message}
                              </p>
                            )}
                            <p className='mt-0.5 text-[10.5px] text-slate-400'>just now</p>
                          </div>
                        </div>
                      </div>
                    ) : (
                      <p className='text-[12px] text-slate-400'>Rendering…</p>
                    )}
                  </div>
                </div>
                <div className='rounded-lg border border-slate-200 bg-white dark:border-border dark:bg-card'>
                  <header className='border-b border-slate-100 px-4 py-2.5 dark:border-border/60'>
                    <h3 className='text-[13px] font-semibold text-slate-800 dark:text-slate-100'>
                      Sample context
                    </h3>
                    <p className='text-[11px] text-slate-400'>
                      {detail.sample_is_real
                        ? 'The newest matching event in this database.'
                        : 'No real event found yet — a representative placeholder.'}
                    </p>
                  </header>
                  <pre className='overflow-x-auto p-4 font-mono text-[11px] leading-relaxed text-slate-700 dark:text-foreground'>
                    {JSON.stringify(detail.sample, null, 2)}
                  </pre>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
