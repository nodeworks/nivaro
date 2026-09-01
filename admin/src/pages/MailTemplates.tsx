import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Braces, Mail, RotateCcw, Send } from 'lucide-react'
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
  // Test-data simulation: JSON merged over the server's sample data for both
  // Preview and Test send — see exactly the email a real payload produces.
  const [dataOpen, setDataOpen] = useState(false)
  const [dataText, setDataText] = useState('')
  const [sendTo, setSendTo] = useState('')

  const { data: sampleData = {} } = useQuery<Record<string, unknown>>({
    queryKey: ['mail-template-sample-data'],
    queryFn: () => api.get('/mail-templates/sample-data').then((r) => r.data.data),
    staleTime: 600_000
  })

  const parsedData: { value: Record<string, unknown> | null; error: boolean } = (() => {
    const t = dataText.trim()
    if (!t) return { value: null, error: false }
    try {
      const v = JSON.parse(t)
      return v && typeof v === 'object' && !Array.isArray(v)
        ? { value: v as Record<string, unknown>, error: false }
        : { value: null, error: true }
    } catch {
      return { value: null, error: true }
    }
  })()

  /** Seed the panel from the variables THIS template actually references,
   *  filled with the sample values so edits start from something real. */
  const seedFromTemplate = () => {
    const vars = new Set<string>()
    for (const m of body.matchAll(/\{\{-?\s*([a-zA-Z_][a-zA-Z0-9_]*)/g)) vars.add(m[1])
    for (const m of body.matchAll(/\{%-?\s*(?:for|if|unless|assign)\s+[^%]*?\bin\s+([a-zA-Z_][a-zA-Z0-9_]*)/g))
      vars.add(m[1])
    const skeleton: Record<string, unknown> = {}
    for (const v of vars) {
      if (v === 'forloop' || v === 'block') continue
      skeleton[v] = v in sampleData ? sampleData[v] : ''
    }
    setDataText(JSON.stringify(skeleton, null, 2))
    setDataOpen(true)
  }

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
        .post(
          `/mail-templates/${selected}/preview`,
          { body, data: parsedData.value ?? undefined },
          { responseType: 'text' }
        )
        .then((r) => r.data as string),
    onSuccess: (html) => setPreviewHtml(html),
    onError: (e: { response?: { data?: { error?: string } } }) =>
      toast.error(e.response?.data?.error ?? 'Preview failed')
  })
  const testSend = useMutation({
    mutationFn: () =>
      api.post(`/mail-templates/${selected}/test-send`, {
        body,
        data: parsedData.value ?? undefined,
        to: sendTo.trim() || undefined
      }),
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
                  onClick={() => (dataOpen ? setDataOpen(false) : dataText ? setDataOpen(true) : seedFromTemplate())}
                  className={cn(
                    'inline-flex h-8 items-center gap-1.5 rounded-md border px-3 text-[12.5px] font-medium',
                    dataOpen || dataText
                      ? 'border-nvr-cyan/40 bg-nvr-cyan/5 text-nvr-navy dark:text-nvr-cyan'
                      : 'border-slate-200 text-slate-600 hover:bg-slate-50 dark:border-border dark:text-muted-foreground dark:hover:bg-muted'
                  )}
                >
                  <Braces className='h-3.5 w-3.5' />
                  Test data
                </button>
                <button
                  type='button'
                  onClick={() => preview.mutate()}
                  disabled={parsedData.error}
                  className='h-8 rounded-md border border-slate-200 px-3 text-[12.5px] font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-50 dark:border-border dark:text-muted-foreground dark:hover:bg-muted'
                >
                  {preview.isPending ? 'Rendering…' : 'Preview'}
                </button>
                <button
                  type='button'
                  onClick={() => testSend.mutate()}
                  disabled={parsedData.error || testSend.isPending}
                  className='inline-flex h-8 items-center gap-1.5 rounded-md border border-slate-200 px-3 text-[12.5px] font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-50 dark:border-border dark:text-muted-foreground dark:hover:bg-muted'
                >
                  <Send className='h-3.5 w-3.5' />
                  {testSend.isPending ? 'Sending…' : 'Test send'}
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
              {dataOpen && (
                <div className='shrink-0 border-b border-slate-200 bg-white px-4 py-3 dark:border-border dark:bg-card'>
                  <div className='mb-1.5 flex flex-wrap items-center gap-2'>
                    <p className='text-[12px] font-semibold text-slate-700 dark:text-slate-200'>
                      Test data
                    </p>
                    <p className='text-[11px] text-slate-400'>
                      JSON merged over the built-in sample — Preview and Test send both use it.
                    </p>
                    <span className='flex-1' />
                    <button
                      type='button'
                      onClick={seedFromTemplate}
                      className='text-[11.5px] text-nvr-cyan underline decoration-dotted underline-offset-2'
                    >
                      Seed from this template's variables
                    </button>
                    <button
                      type='button'
                      onClick={() => setDataText(JSON.stringify(sampleData, null, 2))}
                      className='text-[11.5px] text-slate-400 underline decoration-dotted underline-offset-2 hover:text-slate-600'
                    >
                      Full sample
                    </button>
                    <button
                      type='button'
                      onClick={() => {
                        setDataText('')
                        setDataOpen(false)
                      }}
                      className='text-[11.5px] text-slate-400 underline decoration-dotted underline-offset-2 hover:text-slate-600'
                    >
                      Clear
                    </button>
                  </div>
                  <textarea
                    value={dataText}
                    onChange={(e) => setDataText(e.target.value)}
                    spellCheck={false}
                    rows={7}
                    placeholder='{ "recipient_name": "Beth", "item": "CR26-76773", ... }'
                    className={cn(
                      'w-full resize-y rounded-md border bg-white p-2.5 font-mono text-[11.5px] leading-relaxed outline-none dark:bg-background',
                      parsedData.error
                        ? 'border-red-400 focus:border-red-500'
                        : 'border-slate-200 focus:border-nvr-cyan dark:border-border'
                    )}
                    data-mail-test-data
                  />
                  <div className='mt-1.5 flex items-center gap-3'>
                    {parsedData.error && (
                      <p className='text-[11.5px] text-red-500'>
                        Not valid JSON — fix it before previewing or sending.
                      </p>
                    )}
                    <span className='flex-1' />
                    <label className='flex items-center gap-1.5 text-[11.5px] text-slate-500'>
                      Send test to
                      <input
                        value={sendTo}
                        onChange={(e) => setSendTo(e.target.value)}
                        placeholder='yourself'
                        className='h-7 w-[240px] rounded-md border border-slate-200 bg-white px-2 text-[12px] outline-none focus:border-nvr-cyan dark:border-border dark:bg-background'
                        data-mail-test-to
                      />
                    </label>
                  </div>
                </div>
              )}
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
