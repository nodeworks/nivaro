import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Mail, RotateCcw, Send } from 'lucide-react'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'

/**
 * Mail template editor (#18): view/edit/preview the Liquid mail templates —
 * a DB override layer above the file defaults, with live preview and a test
 * send to yourself. Revert restores the file default.
 */

interface TemplateRow {
  name: string
  overridden: boolean
  updated_at: string | null
}

export default function MailTemplates() {
  const qc = useQueryClient()
  const [selected, setSelected] = useState<string | null>(null)
  const [body, setBody] = useState('')
  const [previewHtml, setPreviewHtml] = useState<string | null>(null)

  const { data: templates = [] } = useQuery<TemplateRow[]>({
    queryKey: ['mail-templates'],
    queryFn: () => api.get('/mail-templates').then((r) => r.data.data)
  })

  const { data: detail } = useQuery<{
    file_body: string
    override_body: string | null
    overridden: boolean
  }>({
    queryKey: ['mail-template', selected],
    queryFn: () => api.get(`/mail-templates/${selected}`).then((r) => r.data.data),
    enabled: !!selected
  })

  useEffect(() => {
    if (detail) {
      setBody(detail.override_body ?? detail.file_body)
      setPreviewHtml(null)
    }
  }, [detail])

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['mail-templates'] })
    void qc.invalidateQueries({ queryKey: ['mail-template', selected] })
  }
  const save = useMutation({
    mutationFn: () => api.put(`/mail-templates/${selected}`, { body }),
    onSuccess: () => {
      toast.success('Override saved — outgoing mail uses it immediately')
      invalidate()
    },
    onError: (e: { response?: { data?: { error?: string } } }) =>
      toast.error(e.response?.data?.error ?? 'Save failed')
  })
  const revert = useMutation({
    mutationFn: () => api.delete(`/mail-templates/${selected}`),
    onSuccess: () => {
      toast.success('Reverted to the file default')
      invalidate()
    }
  })
  const preview = useMutation({
    mutationFn: () =>
      api
        .post(`/mail-templates/${selected}/preview`, { body }, { responseType: 'text' })
        .then((r) => r.data as string),
    onSuccess: (html) => setPreviewHtml(html),
    onError: (e: { response?: { data?: { error?: string } } }) =>
      toast.error(e.response?.data?.error ?? 'Preview failed')
  })
  const testSend = useMutation({
    mutationFn: () => api.post(`/mail-templates/${selected}/test-send`),
    onSuccess: (r) => toast.success(`Test sent to ${r.data.data.to} (test mode still applies)`),
    onError: (e: { response?: { data?: { error?: string } } }) =>
      toast.error(e.response?.data?.error ?? 'Send failed')
  })

  const dirty = detail ? body !== (detail.override_body ?? detail.file_body) : false

  return (
    <div className='flex flex-1 min-h-0 flex-col'>
      <header className='shrink-0 border-b border-slate-200 bg-white px-6 py-4 dark:border-border dark:bg-card'>
        <div className='flex items-center gap-2.5'>
          <Mail className='h-5 w-5 text-muted-foreground' />
          <div>
            <h1 className='text-[17px] font-semibold text-slate-900 dark:text-foreground'>
              Mail Templates
            </h1>
            <p className='mt-0.5 text-[12.5px] text-slate-500 dark:text-muted-foreground'>
              Edit the Liquid emails this instance sends. Saving stores a database override — the
              file template stays the baseline you can always revert to.
            </p>
          </div>
        </div>
      </header>

      <div className='flex flex-1 min-h-0 overflow-hidden'>
        <aside className='w-[220px] shrink-0 overflow-y-auto border-r border-slate-200 bg-white py-2 dark:border-border dark:bg-card'>
          {templates.map((t) => (
            <button
              key={t.name}
              type='button'
              onClick={() => setSelected(t.name)}
              className={cn(
                'flex w-full items-center gap-2 px-4 py-2 text-left text-[12.5px]',
                selected === t.name
                  ? 'bg-nvr-cyan/10 font-medium text-slate-900 dark:text-foreground'
                  : 'text-slate-600 hover:bg-slate-50 dark:text-muted-foreground dark:hover:bg-muted/50'
              )}
            >
              <span className='min-w-0 flex-1 truncate font-mono'>{t.name}</span>
              {t.overridden && (
                <span className='shrink-0 rounded-full bg-amber-100 px-1.5 py-px text-[9.5px] font-semibold uppercase text-amber-700 dark:bg-amber-500/15 dark:text-amber-400'>
                  edited
                </span>
              )}
            </button>
          ))}
        </aside>

        <div className='flex min-w-0 flex-1 flex-col overflow-hidden bg-slate-50 dark:bg-background'>
          {!selected ? (
            <p className='px-6 py-10 text-center text-[13px] text-slate-400'>
              Pick a template to edit.
            </p>
          ) : (
            <>
              <div className='flex shrink-0 flex-wrap items-center gap-2 border-b border-slate-200 bg-white px-4 py-2.5 dark:border-border dark:bg-card'>
                <span className='font-mono text-[13px] font-semibold text-slate-800 dark:text-foreground'>
                  {selected}.liquid
                </span>
                {detail?.overridden && (
                  <span className='rounded-full bg-amber-100 px-2 py-px text-[10.5px] font-medium text-amber-700 dark:bg-amber-500/15 dark:text-amber-400'>
                    database override active
                  </span>
                )}
                <span className='flex-1' />
                <button
                  type='button'
                  onClick={() => preview.mutate()}
                  className='h-8 rounded-md border border-slate-200 px-3 text-[12.5px] font-medium text-slate-600 hover:bg-slate-50 dark:border-border dark:text-muted-foreground dark:hover:bg-muted'
                >
                  {preview.isPending ? 'Rendering…' : 'Preview'}
                </button>
                <button
                  type='button'
                  onClick={() => testSend.mutate()}
                  className='inline-flex h-8 items-center gap-1.5 rounded-md border border-slate-200 px-3 text-[12.5px] font-medium text-slate-600 hover:bg-slate-50 dark:border-border dark:text-muted-foreground dark:hover:bg-muted'
                >
                  <Send className='h-3.5 w-3.5' />
                  Test send
                </button>
                {detail?.overridden && (
                  <button
                    type='button'
                    onClick={() => {
                      if (window.confirm('Revert to the file default? The override is deleted.')) {
                        revert.mutate()
                      }
                    }}
                    className='inline-flex h-8 items-center gap-1.5 rounded-md border border-amber-200 px-3 text-[12.5px] font-medium text-amber-700 hover:bg-amber-50 dark:border-amber-500/40 dark:text-amber-400'
                  >
                    <RotateCcw className='h-3.5 w-3.5' />
                    Revert
                  </button>
                )}
                <button
                  type='button'
                  disabled={!dirty || save.isPending}
                  onClick={() => save.mutate()}
                  className='h-8 rounded-md bg-nvr-cyan px-4 text-[12.5px] font-semibold text-white disabled:opacity-50'
                >
                  {save.isPending ? 'Saving…' : 'Save override'}
                </button>
              </div>
              <div className='flex min-h-0 flex-1'>
                <textarea
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                  spellCheck={false}
                  className='min-h-0 w-1/2 resize-none border-r border-slate-200 bg-white p-4 font-mono text-[12px] leading-relaxed outline-none dark:border-border dark:bg-card'
                />
                <div className='min-h-0 w-1/2 overflow-auto bg-white dark:bg-card'>
                  {previewHtml ? (
                    <iframe
                      title='Template preview'
                      srcDoc={previewHtml}
                      sandbox=''
                      className='h-full w-full border-0 bg-white'
                    />
                  ) : (
                    <p className='px-6 py-10 text-center text-[12.5px] text-slate-400'>
                      Preview renders here with sample data.
                    </p>
                  )}
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
