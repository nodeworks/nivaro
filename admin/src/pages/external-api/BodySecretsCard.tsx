import { useMutation, useQueries, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, KeyRound, Plus } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useLocation } from 'react-router'
import { toast } from 'sonner'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import {
  draftOf,
  errorMessage,
  fetchTemplate,
  payloadKeys,
  publishedOf,
  secretsUsedBy,
  useTemplates
} from '../payload-templates/api'

/** What the server sends for a stored secret, and keeps the stored value for when sent back. */
const MASK = '••••••'
const NAME_RE = /^[A-Za-z0-9_.-]{1,60}$/

type AuthConfig = Record<string, unknown> | null | undefined

function secretsOf(cfg: AuthConfig): Record<string, string> {
  const bs = cfg?.body_secrets
  if (!bs || typeof bs !== 'object' || Array.isArray(bs)) return {}
  return Object.fromEntries(Object.entries(bs).map(([k, v]) => [k, v == null ? '' : String(v)]))
}

/**
 * External API page → Body secrets: values a partner wants inside the request
 * body (MWF's token). Templates reference them by name and render the
 * placeholder; the real value is swapped in only when the request is sent, so
 * it never shows in previews, stored payloads or call logs.
 *
 * Each change PATCHes `auth_config.body_secrets` alone: the other auth fields
 * go back exactly as the server sent them (masked values are kept), a
 * secret left masked keeps its stored value, and a name left out is removed.
 */
export function BodySecretsCard({
  apiId,
  apiName,
  authConfig,
  instanceOverrides
}: {
  apiId: number
  apiName: string
  authConfig: AuthConfig
  instanceOverrides?: Record<string, { auth_config?: Record<string, unknown> }> | null
}) {
  const qc = useQueryClient()
  const location = useLocation()
  const cardRef = useRef<HTMLDivElement>(null)
  const secrets = useMemo(() => secretsOf(authConfig), [authConfig])
  const names = Object.keys(secrets)

  const [adding, setAdding] = useState(false)
  const [newName, setNewName] = useState('')
  const [newValue, setNewValue] = useState('')
  const [replacing, setReplacing] = useState<string | null>(null)
  const [replaceValue, setReplaceValue] = useState('')
  const [removing, setRemoving] = useState<string | null>(null)

  // A missing-secret problem in the payload editor links here.
  useEffect(() => {
    if (location.hash === '#body-secrets')
      cardRef.current?.scrollIntoView({ block: 'start', behavior: 'smooth' })
  }, [location.hash])

  // Which payloads read each secret (their draft or live body).
  const listQ = useTemplates(apiName)
  const keys = (listQ.data?.data ?? []).map((t) => t.key)
  const details = useQueries({
    queries: keys.map((key) => ({
      queryKey: payloadKeys.detail(key),
      queryFn: () => fetchTemplate(key),
      staleTime: 60_000,
      refetchOnWindowFocus: false
    }))
  })
  // Live = the published body reads it (pushes depend on it now); draft = only the unpublished draft.
  const { usedLive, usedDraft } = useMemo(() => {
    const live: Record<string, string[]> = {}
    const draft: Record<string, string[]> = {}
    for (const d of details) {
      const t = d.data?.data
      if (!t) continue
      const liveNames = new Set(secretsUsedBy(publishedOf(t)))
      for (const n of liveNames) {
        live[n] = live[n] ?? []
        live[n].push(t.label)
      }
      for (const n of secretsUsedBy(draftOf(t))) {
        if (liveNames.has(n)) continue
        draft[n] = draft[n] ?? []
        draft[n].push(t.label)
      }
    }
    return { usedLive: live, usedDraft: draft }
  }, [details])
  const missing = [...new Set([...Object.keys(usedLive), ...Object.keys(usedDraft)])].filter(
    (n) => !(n in secrets)
  )
  /** What depends on secret `n`, in words. */
  const impact = (n: string): string => {
    const parts: string[] = []
    if (usedLive[n]?.length)
      parts.push(
        `${usedLive[n].join(', ')} ${usedLive[n].length === 1 ? 'uses' : 'use'} it — their pushes are refused until it is set`
      )
    if (usedDraft[n]?.length)
      parts.push(
        `the draft of ${usedDraft[n].join(', ')} uses it — publishing ${usedDraft[n].length === 1 ? 'it' : 'them'} will fail until the secret is set`
      )
    return parts.join('; ')
  }

  const overridden = useMemo(() => {
    const out: Record<string, string[]> = {}
    for (const [inst, o] of Object.entries(instanceOverrides ?? {})) {
      for (const n of Object.keys(secretsOf(o?.auth_config))) {
        out[n] = out[n] ?? []
        out[n].push(inst)
      }
    }
    return out
  }, [instanceOverrides])

  const save = useMutation({
    mutationFn: (next: Record<string, string>) =>
      api.patch(`/external-apis/${apiId}`, {
        auth_config: { ...(authConfig ?? {}), body_secrets: next }
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['external-api', String(apiId)] })
      void qc.invalidateQueries({ queryKey: ['external-apis'] })
    },
    onError: (e) => toast.error(errorMessage(e, 'Body secrets were not saved'))
  })

  /** Every stored secret stays masked (kept as stored) unless `changes` says otherwise. */
  const commit = (changes: Record<string, string | null>, done: () => void, msg: string) => {
    const next: Record<string, string> = {}
    for (const n of names) next[n] = MASK
    for (const [n, v] of Object.entries(changes)) {
      if (v === null) delete next[n]
      else next[n] = v
    }
    save.mutate(next, {
      onSuccess: () => {
        done()
        toast.success(msg)
      }
    })
  }

  const nameError = !newName
    ? null
    : !NAME_RE.test(newName)
      ? 'Letters, numbers, dot, dash and underscore only'
      : newName in secrets
        ? `“${newName}” already exists — replace it instead`
        : null
  const canAdd = !!newName && !nameError && !!newValue && !save.isPending

  const startAdd = (name = '') => {
    setAdding(true)
    setNewName(name)
    setNewValue('')
  }

  return (
    <Card ref={cardRef} className='mt-5 scroll-mt-4 p-6' id='body-secrets' data-body-secrets-card>
      <div className='flex items-start justify-between gap-4'>
        <div>
          <Label>Body secrets</Label>
          <p className='text-[12px] text-slate-500 dark:text-muted-foreground'>
            Values the partner wants inside the request body, like an API token. Payloads use them
            by name; the value is filled in only when a request is sent, so it never appears in
            previews, stored pushes or logs.
          </p>
        </div>
        {!adding && (
          <button
            type='button'
            onClick={() => startAdd()}
            className='inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-slate-200 px-3 text-[12.5px] font-medium text-slate-700 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan dark:border-border dark:text-slate-200 dark:hover:bg-muted'
            data-body-secret-add
          >
            <Plus className='h-3.5 w-3.5' />
            Add secret
          </button>
        )}
      </div>

      {listQ.data?.warning && (
        <div className='mt-3 flex items-start gap-2 rounded-md bg-amber-50 px-3 py-2 text-[12.5px] text-amber-900 dark:bg-amber-500/10 dark:text-amber-200'>
          <AlertTriangle className='mt-0.5 h-3.5 w-3.5 shrink-0' />
          <p>{listQ.data.warning}</p>
        </div>
      )}

      {missing.length > 0 && (
        <div className='mt-3 space-y-1' data-body-secrets-missing>
          {missing.map((n) => (
            <p
              key={n}
              className='flex flex-wrap items-center gap-x-2 rounded-md bg-red-50 px-3 py-2 text-[12.5px] text-red-800 dark:bg-red-500/10 dark:text-red-200'
            >
              <span>
                <span className='font-mono'>{n}</span> is not set: {impact(n)}.
              </span>
              <button
                type='button'
                onClick={() => startAdd(n)}
                className='font-medium underline underline-offset-2'
              >
                Add it
              </button>
            </p>
          ))}
        </div>
      )}

      <div className='mt-3'>
        {names.length === 0 && !adding ? (
          <p className='text-[13px] text-slate-500 dark:text-muted-foreground'>No body secrets.</p>
        ) : names.length > 0 ? (
          <ul className='divide-y divide-slate-100 rounded-md border border-slate-200 dark:divide-border dark:border-border'>
            {names.map((n) => (
              <li key={n} className='px-3 py-2.5' data-body-secret={n}>
                <div className='flex flex-wrap items-center gap-x-3 gap-y-1'>
                  <KeyRound className='h-3.5 w-3.5 shrink-0 text-slate-400' />
                  <span className='font-mono text-[12.5px] text-slate-900 dark:text-foreground'>
                    {n}
                  </span>
                  <span className='font-mono text-[12px] text-slate-500 dark:text-muted-foreground'>
                    {secrets[n] ? MASK : 'empty'}
                  </span>
                  <span className='min-w-0 flex-1 truncate text-[12px] text-slate-500 dark:text-muted-foreground'>
                    {usedLive[n]?.length
                      ? `Used by ${usedLive[n].join(', ')}`
                      : usedDraft[n]?.length
                        ? `Used by the draft of ${usedDraft[n].join(', ')}`
                        : 'Not used by a payload'}
                    {overridden[n] ? ` · overridden on ${overridden[n].join(', ')}` : ''}
                  </span>
                  {replacing !== n && removing !== n && (
                    <span className='flex shrink-0 items-center gap-1'>
                      <button
                        type='button'
                        onClick={() => {
                          setReplacing(n)
                          setReplaceValue('')
                          setRemoving(null)
                        }}
                        className='rounded px-2 py-1 text-[12px] font-medium text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-muted'
                      >
                        Replace
                      </button>
                      <button
                        type='button'
                        onClick={() => {
                          setRemoving(n)
                          setReplacing(null)
                        }}
                        className='rounded px-2 py-1 text-[12px] font-medium text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-500/10'
                      >
                        Remove
                      </button>
                    </span>
                  )}
                </div>
                {replacing === n && (
                  <form
                    className='mt-2 flex flex-wrap items-center gap-2 pl-6'
                    onSubmit={(e) => {
                      e.preventDefault()
                      if (!replaceValue || save.isPending) return
                      commit({ [n]: replaceValue }, () => setReplacing(null), `${n} replaced`)
                    }}
                  >
                    <Input
                      type='password'
                      autoComplete='new-password'
                      autoFocus
                      value={replaceValue}
                      onChange={(e) => setReplaceValue(e.target.value)}
                      placeholder={`New value for ${n}`}
                      className='h-8 w-[280px] font-mono text-[12.5px]'
                      aria-label={`New value for ${n}`}
                    />
                    <button
                      type='submit'
                      disabled={!replaceValue || save.isPending}
                      className='h-8 rounded-md bg-nvr-cyan px-3 text-[12.5px] font-semibold text-white hover:bg-nvr-cyan/90 disabled:cursor-not-allowed disabled:opacity-40'
                    >
                      {save.isPending ? 'Saving…' : 'Save'}
                    </button>
                    <button
                      type='button'
                      onClick={() => setReplacing(null)}
                      className='h-8 rounded-md px-2.5 text-[12.5px] text-slate-600 hover:bg-slate-100 dark:text-muted-foreground dark:hover:bg-muted'
                    >
                      Cancel
                    </button>
                  </form>
                )}
                {removing === n && (
                  <div className='mt-2 flex flex-wrap items-center gap-2 pl-6 text-[12.5px]'>
                    <span className='text-slate-700 dark:text-slate-200'>
                      {impact(n) ? `Remove ${n}? ${impact(n)}.` : `Remove ${n}?`}
                    </span>
                    <button
                      type='button'
                      disabled={save.isPending}
                      onClick={() => commit({ [n]: null }, () => setRemoving(null), `${n} removed`)}
                      className='h-7 rounded-md bg-red-600 px-2.5 font-medium text-white hover:bg-red-700 disabled:opacity-40'
                    >
                      Remove
                    </button>
                    <button
                      type='button'
                      onClick={() => setRemoving(null)}
                      className='h-7 rounded-md px-2.5 text-slate-600 hover:bg-slate-100 dark:text-muted-foreground dark:hover:bg-muted'
                    >
                      Cancel
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        ) : null}
      </div>

      {adding && (
        <form
          className={cn('flex flex-wrap items-start gap-2', names.length > 0 && 'mt-3')}
          onSubmit={(e) => {
            e.preventDefault()
            if (!canAdd) return
            commit(
              { [newName]: newValue },
              () => {
                setAdding(false)
                setNewName('')
                setNewValue('')
              },
              `${newName} added`
            )
          }}
          data-body-secret-form
        >
          <div className='space-y-1'>
            <Input
              autoFocus={!newName}
              value={newName}
              onChange={(e) => setNewName(e.target.value.trim())}
              placeholder='Name, e.g. token'
              className={cn('h-8 w-[180px] font-mono text-[12.5px]', nameError && 'border-red-400')}
              aria-label='Secret name'
              aria-invalid={!!nameError}
            />
            {nameError && <p className='text-[12px] text-red-600 dark:text-red-400'>{nameError}</p>}
          </div>
          <Input
            type='password'
            autoComplete='new-password'
            autoFocus={!!newName}
            value={newValue}
            onChange={(e) => setNewValue(e.target.value)}
            placeholder='Value'
            className='h-8 w-[280px] font-mono text-[12.5px]'
            aria-label='Secret value'
          />
          <button
            type='submit'
            disabled={!canAdd}
            className='h-8 rounded-md bg-nvr-cyan px-3 text-[12.5px] font-semibold text-white hover:bg-nvr-cyan/90 disabled:cursor-not-allowed disabled:opacity-40'
          >
            {save.isPending ? 'Saving…' : 'Add'}
          </button>
          <button
            type='button'
            onClick={() => setAdding(false)}
            className='h-8 rounded-md px-2.5 text-[12.5px] text-slate-600 hover:bg-slate-100 dark:text-muted-foreground dark:hover:bg-muted'
          >
            Cancel
          </button>
        </form>
      )}
    </Card>
  )
}
