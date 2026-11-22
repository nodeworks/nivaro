import { ErrorNotice } from '@nivaro/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { KeyRound } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { cn } from '@/lib/utils'
import {
  type AppKeySaved,
  fetchAppKey,
  LOST_KEY_TEXT,
  moveError,
  moveKeys,
  putAppKey
} from './move-api'

/**
 * Nivaro Hub (phase 6) — the app's encryption key (its ENCRYPTION_KEY) on one environment. The
 * Hub needs it to place or move the app onto a shared deployment, where values the app sealed
 * are opened with it. Typed once: the field never shows a saved key again, only its mask and
 * fingerprint (the first 32 hex of an HMAC of the key — it reveals nothing about the key).
 */

const HEX64 = /^[0-9a-fA-F]{64}$/

const SOURCE_WORDS: Record<string, string> = {
  entry: 'Entered on the Hub',
  stack: "From the environment's stack settings"
}

const VERIFIED_WORDS: Record<string, string> = {
  'hub-link': 'Checked against the running app.',
  docker: "Checked against the stack's settings.",
  stack: "Checked against the stack's settings.",
  shared: 'Checked against the shared deployment.'
}

export function HubAppKeyField({
  envId,
  idPrefix,
  className
}: {
  envId: number
  /** Unique per mount (the table and the phone list can both hold one). */
  idPrefix: string
  className?: string
}) {
  const qc = useQueryClient()
  const info = useQuery({ queryKey: moveKeys.appKey(envId), queryFn: () => fetchAppKey(envId) })
  const [value, setValue] = useState('')
  const [refusal, setRefusal] = useState<{ code?: string; error: unknown } | null>(null)
  const trimmed = value.trim()
  const bad = trimmed.length > 0 && !HEX64.test(trimmed)

  const save = useMutation({
    mutationFn: () => putAppKey(envId, trimmed),
    onSuccess: (r: AppKeySaved) => {
      // Never kept: the typed key leaves the page as soon as the Hub has it.
      setValue('')
      setRefusal(null)
      void qc.invalidateQueries({ queryKey: moveKeys.appKey(envId) })
      void qc.invalidateQueries({ queryKey: ['hub', 'move-plan', envId] })
      if (!r.changed) toast.success('The Hub already holds this key')
      else if (r.verified)
        toast.success('Key saved', { description: VERIFIED_WORDS[r.verified] ?? undefined })
      else
        toast.success('Key saved', {
          description:
            'The Hub could not check it against the running app; it is checked again before a move.'
        })
    },
    onError: (err) => {
      setValue('')
      const code = (err as { response?: { data?: { code?: string } } })?.response?.data?.code
      setRefusal({ code, error: err })
    }
  })

  const id = `${idPrefix}-app-key`
  const d = info.data
  return (
    <div
      className={cn(
        'space-y-2 rounded-md border border-slate-200 bg-white p-3 dark:border-border dark:bg-card',
        className
      )}
    >
      <div className='flex items-center gap-2'>
        <KeyRound className='h-3.5 w-3.5 text-slate-500 dark:text-muted-foreground' aria-hidden />
        <Label htmlFor={id} className='text-[12px] font-medium text-slate-700 dark:text-foreground'>
          App encryption key
        </Label>
      </div>

      {info.isError ? (
        <ErrorNotice
          description={moveError(info.error, 'Could not read the app key')}
          onRetry={() => void info.refetch()}
        />
      ) : d ? (
        d.known ? (
          <dl className='m-0 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-[12px]'>
            <dt className='text-slate-500 dark:text-muted-foreground'>Key</dt>
            <dd className='m-0 font-mono text-slate-800 dark:text-foreground'>{d.key}</dd>
            <dt className='text-slate-500 dark:text-muted-foreground'>Fingerprint</dt>
            <dd
              className='m-0 break-all font-mono text-[11px] text-slate-700 dark:text-slate-300'
              data-tip='Identifies the key without revealing it'
            >
              {d.fp}
            </dd>
            {d.source && (
              <>
                <dt className='text-slate-500 dark:text-muted-foreground'>From</dt>
                <dd className='m-0 text-slate-700 dark:text-slate-300'>
                  {SOURCE_WORDS[d.source] ?? d.source}
                </dd>
              </>
            )}
          </dl>
        ) : (
          <p className='m-0 text-[12px] text-amber-800 dark:text-amber-300'>
            The Hub does not know this app's encryption key. Enter the app's ENCRYPTION_KEY to place
            or move it onto a shared deployment.
          </p>
        )
      ) : null}
      {d?.entry_unreadable && (
        <p role='status' className='m-0 text-[12px] text-amber-800 dark:text-amber-300'>
          The saved key can no longer be opened (the Hub's own ENCRYPTION_KEY changed, or the entry
          is damaged). Enter the app's key again.
        </p>
      )}

      <div className='flex flex-wrap items-start gap-2'>
        <div className='min-w-[220px] flex-1 space-y-1'>
          <Input
            id={id}
            type='password'
            autoComplete='new-password'
            spellCheck={false}
            value={value}
            onChange={(e) => {
              setValue(e.target.value)
              setRefusal(null)
            }}
            placeholder={d?.known ? 'Enter a key to replace it' : '64 hex characters'}
            aria-invalid={bad || undefined}
            aria-describedby={`${id}-hint`}
            className='h-8 font-mono text-[13px]'
          />
          <p
            id={`${id}-hint`}
            className={cn(
              'm-0 text-[11px]',
              bad ? 'text-red-600 dark:text-red-400' : 'text-slate-500 dark:text-muted-foreground'
            )}
          >
            The app's ENCRYPTION_KEY: 64 characters, 0–9 and a–f. It is never shown again.
          </p>
        </div>
        <Button
          size='sm'
          className='h-8 bg-nvr-cyan text-white hover:bg-nvr-cyan/90'
          disabled={!trimmed || bad || save.isPending}
          onClick={() => save.mutate()}
        >
          {save.isPending ? 'Saving…' : 'Save key'}
        </Button>
      </div>

      {refusal && <ErrorNotice description={moveError(refusal.error, 'Could not save the key')} />}
      {(refusal?.code === 'APP_KEY_IMMUTABLE' || d?.entry_unreadable) && (
        <p className='m-0 text-[12px] text-slate-600 dark:text-slate-300'>{LOST_KEY_TEXT}</p>
      )}
    </div>
  )
}
