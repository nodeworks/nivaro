import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Settings2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useNivaroClient } from '../../context'
import { get, patch } from '../../lib/commands'
import { toastError } from '../../lib/error-toast'
import { cn } from '../../lib/utils'
import { ErrorNotice } from '../ErrorNotice'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'
import { Switch } from '../ui/switch'
import type { OpsReportSettings } from './format'

type Field = keyof OpsReportSettings

const FIELDS: Field[] = [
  'enabled',
  'window_start_hour',
  'window_end_hour',
  'email',
  'notify',
  'model',
  'token_cap'
]

/** The API names every bad field in one sentence ("a …; b …"): hand each piece to its field. */
function messagesByField(err: unknown): {
  byField: Partial<Record<Field, string>>
  rest: string[]
} {
  const e = err as {
    message?: unknown
    response?: { message?: unknown; error?: unknown; fields?: unknown }
    body?: { message?: unknown; error?: unknown; fields?: unknown }
  }
  // The API names each bad setting: { error, fields: { <setting>: message } }.
  const fields = (e?.response?.fields ?? e?.body?.fields) as Record<string, unknown> | undefined
  if (fields && typeof fields === 'object') {
    const byField: Partial<Record<Field, string>> = {}
    const rest: string[] = []
    for (const [k, v] of Object.entries(fields)) {
      if ((FIELDS as string[]).includes(k)) byField[k as Field] = String(v)
      else rest.push(String(v))
    }
    return { byField, rest }
  }
  const candidates = [
    e?.response?.message,
    e?.body?.message,
    e?.response?.error,
    e?.body?.error,
    e?.message
  ]
  const text = candidates.find((c): c is string => typeof c === 'string' && c.includes(' ')) ?? ''
  const byField: Partial<Record<Field, string>> = {}
  const rest: string[] = []
  for (const piece of text
    .split(';')
    .map((p) => p.trim())
    .filter(Boolean)) {
    const f = FIELDS.find((k) => piece.startsWith(k) || piece.includes(`${k} `))
    if (f) byField[f] = piece.replace(f, labelOf(f))
    else if (/window/.test(piece)) byField.window_end_hour = piece
    else rest.push(piece)
  }
  return { byField, rest }
}

function labelOf(f: Field): string {
  return (
    {
      enabled: 'The nightly report',
      window_start_hour: 'Window start',
      window_end_hour: 'Window end',
      email: 'Email',
      notify: 'Notification',
      model: 'Model',
      token_cap: 'Token cap'
    } as Record<Field, string>
  )[f]
}

function Row({
  label,
  hint,
  error,
  children
}: {
  label: string
  hint?: string
  error?: string
  children: React.ReactNode
}) {
  return (
    <div className='space-y-1'>
      <div className='flex items-center justify-between gap-3'>
        <div className='min-w-0'>
          <div className='text-[12.5px] font-medium text-slate-800 dark:text-foreground'>
            {label}
          </div>
          {hint && (
            <div className='text-[11px] text-slate-500 dark:text-muted-foreground'>{hint}</div>
          )}
        </div>
        {children}
      </div>
      {error && (
        <p role='alert' className='text-[11.5px] text-red-600 dark:text-red-400'>
          {error}
        </p>
      )}
    </div>
  )
}

export function OpsSettingsPopover() {
  const client = useNivaroClient()
  const qc = useQueryClient()
  const [open, setOpen] = useState(false)
  const q = useQuery({
    queryKey: ['ops-report-settings'],
    enabled: open,
    queryFn: () =>
      client.request<{ data: OpsReportSettings }>(get('/ops-reports/settings')).then((r) => r.data)
  })
  const [form, setForm] = useState<OpsReportSettings | null>(null)
  const [tokenText, setTokenText] = useState('')
  const [errs, setErrs] = useState<ReturnType<typeof messagesByField>>({ byField: {}, rest: [] })
  const [saveError, setSaveError] = useState<unknown>(null)
  useEffect(() => {
    if (q.data) {
      setForm(q.data)
      setTokenText(String(q.data.token_cap))
    }
  }, [q.data])

  const save = useMutation({
    mutationFn: (body: Partial<OpsReportSettings>) =>
      client.request<{ data: OpsReportSettings }>(patch('/ops-reports/settings', body)),
    onSuccess: (r) => {
      setErrs({ byField: {}, rest: [] })
      setSaveError(null)
      qc.setQueryData(['ops-report-settings'], r.data)
      setOpen(false)
    },
    onError: (err) => {
      const m = messagesByField(err)
      setErrs(m)
      const status = (err as { status?: number }).status
      if (status === 400 && (Object.keys(m.byField).length || m.rest.length)) setSaveError(null)
      else {
        setSaveError(err)
        toastError(err, 'Could not save the settings')
      }
    }
  })

  const set = <K extends Field>(k: K, v: OpsReportSettings[K]) =>
    setForm((f) => (f ? { ...f, [k]: v } : f))

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant='outline'
          size='sm'
          className='h-8 gap-1.5 text-[12.5px]'
          data-ops-settings=''
          aria-label='Daily report settings'
        >
          <Settings2 className='h-3.5 w-3.5' aria-hidden />
          Settings
        </Button>
      </PopoverTrigger>
      <PopoverContent align='end' className='w-[340px] space-y-3 p-4'>
        {q.isLoading || !form ? (
          q.error ? (
            <ErrorNotice error={q.error} what='the settings' onRetry={() => void q.refetch()} />
          ) : (
            <p className='text-[12px] text-slate-500'>Loading…</p>
          )
        ) : (
          <>
            <Row label='Nightly report' hint='Run now always works.' error={errs.byField.enabled}>
              <Switch
                checked={form.enabled}
                onCheckedChange={(v) => set('enabled', v)}
                aria-label='Nightly report'
              />
            </Row>
            <Row
              label='Window starts (hour)'
              hint='0 to 23, instance time'
              error={errs.byField.window_start_hour}
            >
              <Input
                type='number'
                min={0}
                max={23}
                value={form.window_start_hour}
                onChange={(e) => set('window_start_hour', Number(e.target.value))}
                aria-label='Window start hour'
                className={cn(
                  'h-8 w-16 text-[12.5px]',
                  errs.byField.window_start_hour && 'border-red-400'
                )}
              />
            </Row>
            <Row
              label='Window ends (hour)'
              hint='1 to 24, after the start'
              error={errs.byField.window_end_hour}
            >
              <Input
                type='number'
                min={1}
                max={24}
                value={form.window_end_hour}
                onChange={(e) => set('window_end_hour', Number(e.target.value))}
                aria-label='Window end hour'
                className={cn(
                  'h-8 w-16 text-[12.5px]',
                  errs.byField.window_end_hour && 'border-red-400'
                )}
              />
            </Row>
            <Row label='Email administrators' error={errs.byField.email}>
              <Switch
                checked={form.email}
                onCheckedChange={(v) => set('email', v)}
                aria-label='Email administrators'
              />
            </Row>
            <Row
              label='Notify administrators'
              hint='Off = this page only'
              error={errs.byField.notify}
            >
              <Switch
                checked={form.notify}
                onCheckedChange={(v) => set('notify', v)}
                aria-label='Notify administrators'
              />
            </Row>
            <Row
              label='Model'
              hint='Blank = the AI settings’ chat model'
              error={errs.byField.model}
            >
              <Input
                value={form.model ?? ''}
                onChange={(e) => set('model', e.target.value || null)}
                aria-label='Model'
                placeholder='default'
                className={cn('h-8 w-36 text-[12.5px]', errs.byField.model && 'border-red-400')}
              />
            </Row>
            <Row
              label='Token cap'
              hint='20,000 to 5,000,000 per run'
              error={errs.byField.token_cap}
            >
              <Input
                inputMode='numeric'
                value={tokenText}
                onChange={(e) => {
                  setTokenText(e.target.value)
                  set('token_cap', Number(e.target.value.replace(/[^\d]/g, '')))
                }}
                aria-label='Token cap'
                className={cn(
                  'h-8 w-28 text-right text-[12.5px]',
                  errs.byField.token_cap && 'border-red-400'
                )}
              />
            </Row>
            {errs.rest.length > 0 && (
              <ul role='alert' className='space-y-0.5 text-[11.5px] text-red-600 dark:text-red-400'>
                {errs.rest.map((m) => (
                  <li key={m}>{m}</li>
                ))}
              </ul>
            )}
            {saveError != null && <ErrorNotice error={saveError} fallback='Could not save' />}
            <div className='flex justify-end gap-2 pt-1'>
              <Button variant='ghost' size='sm' className='h-8' onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button
                size='sm'
                className='h-8'
                disabled={save.isPending}
                onClick={() => {
                  // email_me rides the GET only (the caller's own opt-in); it is not a setting.
                  const { email_me: _mine, ...body } = form
                  save.mutate(body)
                }}
              >
                {save.isPending ? 'Saving…' : 'Save'}
              </Button>
            </div>
          </>
        )}
      </PopoverContent>
    </Popover>
  )
}
