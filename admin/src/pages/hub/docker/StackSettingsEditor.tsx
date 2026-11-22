import { ErrorNotice, useUnsavedWork } from '@nivaro/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Plus, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { SimpleSelect } from '@/components/ui/simple-select'
import { Skeleton } from '@/components/ui/skeleton'
import {
  BLOCKER_COPY,
  fetchComponents,
  HUB_MASK,
  type HubEnvironment,
  hubError,
  hubKeys
} from '../hub-api'
import { Field, ghostButton } from '../hub-parts'
import { dockerKeys, fetchAgentHealth } from './docker-api'
import {
  fetchStackSettings,
  GENERATED_SECRETS,
  putStackSettings,
  refusalOf,
  type StackSettings,
  stackKeys
} from './stack-api'

/**
 * Nivaro Hub (phase 4) — the stack settings editor (Hub admins): size, Redis, publish port,
 * plain settings, secrets (masks only; Replace never pre-fills) and extension pins. The server
 * refuses a key it does not accept (SETTING_INVALID naming the key); that lands on its row.
 */

interface KvRow {
  id: number
  key: string
  value: string
}
interface SecretRow {
  id: number
  key: string
  /** Stored on the server (shown as the mask). */
  stored: boolean
  /** A typed replacement or a new value; '' = not replacing. */
  value: string
  replacing: boolean
  cleared: boolean
}

interface Draft {
  size: string
  redis: string
  port: string
  settings: KvRow[]
  secrets: SecretRow[]
  pins: KvRow[]
}

let nextId = 1
const rid = () => nextId++

function draftOf(s: StackSettings): Draft {
  return {
    size: s.size,
    redis: s.redis,
    port: s.publish_port == null ? '' : String(s.publish_port),
    settings: Object.entries(s.settings).map(([key, value]) => ({ id: rid(), key, value })),
    secrets: Object.keys(s.secrets).map((key) => ({
      id: rid(),
      key,
      stored: true,
      value: '',
      replacing: false,
      cleared: false
    })),
    pins: Object.entries(s.extension_pins ?? {}).map(([key, value]) => ({ id: rid(), key, value }))
  }
}

/** The body a save sends; unchanged secrets go back as the mask so the server keeps them. */
export function settingsBody(d: Draft, withPort: boolean, pinsKnown: boolean) {
  const secrets: Record<string, string | null> = {}
  const rotate: string[] = []
  for (const r of d.secrets) {
    const key = r.key.trim()
    if (!key) continue
    if (r.cleared) secrets[key] = null
    else if (r.value !== '' && (r.replacing || !r.stored)) {
      secrets[key] = r.value
      if (r.stored && GENERATED_SECRETS.includes(key)) rotate.push(key)
    } else if (r.stored) secrets[key] = HUB_MASK
  }
  const pairs = (rows: KvRow[]) =>
    Object.fromEntries(rows.filter((r) => r.key.trim()).map((r) => [r.key.trim(), r.value.trim()]))
  // SQLite is one process: the form shows (and sends) size small whatever was picked before.
  const sqlite = d.settings.some((r) => r.key.trim() === 'DB_CLIENT' && r.value === 'sqlite')
  return {
    size: sqlite ? 'small' : d.size,
    redis: d.redis,
    ...(withPort ? { publish_port: d.port.trim() === '' ? null : Number(d.port) } : {}),
    settings: Object.fromEntries(
      d.settings.filter((r) => r.key.trim()).map((r) => [r.key.trim(), r.value])
    ),
    secrets,
    ...(rotate.length ? { rotate } : {}),
    ...(pinsKnown ? { extension_pins: pairs(d.pins) } : {})
  }
}

/** A row's refusal in plain words, by code — never the server's own message text. */
function rowText(code: string | null): string {
  const c = code ? BLOCKER_COPY[code] : undefined
  if (!c) return 'This value is not accepted.'
  return c.hint ? `${c.title}. ${c.hint}` : c.title
}

const keyIn = (message: string, key: string) =>
  key !== '' &&
  new RegExp(`(^|[^A-Za-z0-9_])${key.replace(/\W/g, '\\$&')}($|[^A-Za-z0-9_])`).test(message)

export function StackSettingsEditor({
  env,
  appId,
  idPrefix = ''
}: {
  env: HubEnvironment
  appId: number
  /** Unique per mount (the table and the phone list can both hold an editor). */
  idPrefix?: string
}) {
  const qc = useQueryClient()
  const q = useQuery({
    queryKey: stackKeys.settings(env.id),
    queryFn: () => fetchStackSettings(env.id),
    retry: false,
    refetchOnWindowFocus: false
  })
  // The agent's edge decides whether a publish port applies: read it through the stack component.
  const comps = useQuery({
    queryKey: hubKeys.components(env.placement_id ?? 0),
    queryFn: () => fetchComponents(env.placement_id as number),
    enabled: env.placement_id != null,
    retry: false
  })
  const driverId = comps.data?.find((c) => c.kind === 'stack')?.driver_id ?? null
  const agent = useQuery({
    queryKey: dockerKeys.agent(driverId ?? 0),
    queryFn: () => fetchAgentHealth(driverId as number),
    enabled: driverId != null,
    retry: false
  })
  const [draft, setDraft] = useState<Draft | null>(null)
  const [base, setBase] = useState('')
  const [fieldError, setFieldError] = useState<{ kind: string; id: number; text: string } | null>(
    null
  )
  const [notice, setNotice] = useState<unknown>(null)
  const seeded = useRef<unknown>(null)

  const seed = (data: StackSettings) => {
    seeded.current = data
    const d = draftOf(data)
    setDraft(d)
    setBase(JSON.stringify(settingsBody(d, true, true)))
  }
  const isDirty = (d: Draft | null) => !!d && JSON.stringify(settingsBody(d, true, true)) !== base

  // A fresh read never lands over unsaved edits.
  // biome-ignore lint/correctness/useExhaustiveDependencies: seeds on new data only
  useEffect(() => {
    if (q.data && seeded.current !== q.data && !isDirty(draft)) seed(q.data)
  }, [q.data])

  const showPort = agent.data?.edge === 'publish' || (q.data?.publish_port ?? null) !== null
  const pinsKnown = q.data?.extension_pins != null
  const dirty = useMemo(
    () => !!draft && JSON.stringify(settingsBody(draft, true, true)) !== base,
    [draft, base]
  )
  useUnsavedWork(dirty, `Stack settings (${env.key})`)

  const save = useMutation({
    mutationFn: () => putStackSettings(env.id, settingsBody(draft as Draft, showPort, pinsKnown)),
    onSuccess: (s) => {
      seed(s)
      qc.setQueryData(stackKeys.settings(env.id), s)
      setFieldError(null)
      setNotice(null)
      void qc.invalidateQueries({ queryKey: hubKeys.app(appId) })
    },
    onError: (err) => {
      const { code, message } = refusalOf(err)
      const d = draft as Draft
      const onRow = (kind: string, id: number) => {
        setNotice(null)
        setFieldError({ kind, id, text: rowText(code) })
      }
      if (message) {
        const s = d.settings.find((r) => keyIn(message, r.key.trim()))
        if (s) return onRow('setting', s.id)
        const sec = d.secrets.find((r) => keyIn(message, r.key.trim()))
        if (sec) return onRow('secret', sec.id)
        const p = d.pins.find((r) => keyIn(message, r.key.trim()))
        if (p) return onRow('pin', p.id)
      }
      setFieldError(null)
      setNotice(err)
    }
  })

  if (q.isPending) return <Skeleton className='h-24 w-full' />
  if (q.isError)
    return (
      <ErrorNotice
        description={hubError(q.error, 'Could not load the stack settings')}
        onRetry={() => void q.refetch()}
      />
    )
  if (!draft) return null
  const set = (patch: Partial<Draft>) => setDraft({ ...draft, ...patch })
  const sqlite = draft.settings.some((r) => r.key.trim() === 'DB_CLIENT' && r.value === 'sqlite')
  const size = sqlite ? 'small' : draft.size
  const rowErr = (kind: string, id: number) =>
    fieldError && fieldError.kind === kind && fieldError.id === id ? fieldError.text : null
  const idp = `hub-stack-${env.id}${idPrefix}`

  const kvRows = (
    kind: 'setting' | 'pin',
    rows: KvRow[],
    put: (rows: KvRow[]) => void,
    ph: { key: string; value: string }
  ) =>
    rows.map((r) => (
      <li key={r.id} className='space-y-1'>
        <div className='flex items-center gap-2'>
          <Input
            aria-label={`${kind === 'pin' ? 'Extension id' : 'Setting name'}`}
            value={r.key}
            onChange={(e) =>
              put(
                rows.map((x) =>
                  x.id === r.id
                    ? {
                        ...x,
                        key: kind === 'setting' ? e.target.value.toUpperCase() : e.target.value
                      }
                    : x
                )
              )
            }
            placeholder={ph.key}
            spellCheck={false}
            className='h-8 w-40 shrink-0 font-mono text-[12px] sm:w-56'
          />
          <Input
            aria-label={kind === 'pin' ? 'Pinned image' : 'Setting value'}
            value={r.value}
            onChange={(e) =>
              put(rows.map((x) => (x.id === r.id ? { ...x, value: e.target.value } : x)))
            }
            placeholder={ph.value}
            spellCheck={false}
            className='h-8 min-w-0 flex-1 font-mono text-[12px]'
          />
          <button
            type='button'
            aria-label='Remove row'
            data-tip='Remove'
            className={ghostButton}
            onClick={() => put(rows.filter((x) => x.id !== r.id))}
          >
            <X className='h-3.5 w-3.5' aria-hidden />
          </button>
        </div>
        {rowErr(kind, r.id) && (
          <p role='alert' className='m-0 text-[11px] text-red-600 dark:text-red-400'>
            {rowErr(kind, r.id)}
          </p>
        )}
      </li>
    ))

  const updSecret = (id: number, patch: Partial<SecretRow>) =>
    set({ secrets: draft.secrets.map((x) => (x.id === id ? { ...x, ...patch } : x)) })

  return (
    <div className='space-y-4'>
      {q.data?.secrets_error && (
        <p className='m-0 text-[11px] text-amber-700 dark:text-amber-400'>
          The stored secrets cannot be read with this Hub's encryption key, so their names are
          unknown. Saving leaves them as they are.
        </p>
      )}
      <div className='grid grid-cols-1 gap-3 sm:grid-cols-3'>
        <Field
          id={`${idp}-size`}
          label='Size'
          hint={
            sqlite
              ? 'SQLite is one file one process can write, so the size stays small.'
              : undefined
          }
        >
          <SimpleSelect
            value={size}
            onChange={(v) => set({ size: v })}
            disabled={sqlite}
            ariaLabel='Size'
            className='h-8 text-[13px]'
            triggerProps={{ id: `${idp}-size` }}
            options={[
              { value: 'small', label: 'Small' },
              { value: 'medium', label: 'Medium' },
              { value: 'large', label: 'Large' }
            ]}
          />
        </Field>
        <Field id={`${idp}-redis`} label='Redis'>
          <SimpleSelect
            value={draft.redis}
            onChange={(v) => set({ redis: v })}
            ariaLabel='Redis'
            className='h-8 text-[13px]'
            triggerProps={{ id: `${idp}-redis` }}
            options={[
              { value: 'bundled', label: 'Bundled with the stack' },
              { value: 'external', label: 'External (REDIS_URL secret)' }
            ]}
          />
        </Field>
        {showPort && (
          <Field id={`${idp}-port`} label='Publish port' hint='The host port the agent publishes.'>
            <Input
              id={`${idp}-port`}
              inputMode='numeric'
              value={draft.port}
              onChange={(e) => set({ port: e.target.value.replace(/\D/g, '') })}
              className='h-8 font-mono text-[13px]'
            />
          </Field>
        )}
      </div>

      <section aria-label='Settings' className='space-y-1.5'>
        <h5 className='m-0 text-[12px] font-semibold text-slate-800 dark:text-foreground'>
          Settings
        </h5>
        <ul className='m-0 list-none space-y-1.5 p-0'>
          {kvRows('setting', draft.settings, (settings) => set({ settings }), {
            key: 'NAME',
            value: 'value'
          })}
        </ul>
        <button
          type='button'
          className={ghostButton}
          onClick={() => set({ settings: [...draft.settings, { id: rid(), key: '', value: '' }] })}
        >
          <Plus className='h-3.5 w-3.5' aria-hidden /> Add setting
        </button>
      </section>

      <section aria-label='Secrets' className='space-y-1.5'>
        <h5 className='m-0 text-[12px] font-semibold text-slate-800 dark:text-foreground'>
          Secrets
        </h5>
        <ul className='m-0 list-none space-y-1.5 p-0'>
          {draft.secrets.map((r) => {
            const generated = GENERATED_SECRETS.includes(r.key)
            return (
              <li key={r.id} className='space-y-1'>
                <div className='flex flex-wrap items-center gap-2'>
                  {r.stored ? (
                    <span className='w-40 shrink-0 truncate font-mono text-[12px] sm:w-56'>
                      {r.key}
                    </span>
                  ) : (
                    <Input
                      aria-label='Secret name'
                      value={r.key}
                      onChange={(e) => updSecret(r.id, { key: e.target.value.toUpperCase() })}
                      placeholder='NAME'
                      spellCheck={false}
                      className='h-8 w-40 shrink-0 font-mono text-[12px] sm:w-56'
                    />
                  )}
                  {generated && (
                    <span className='rounded-full border border-slate-200 px-1.5 text-[10px] text-slate-500 dark:border-border dark:text-muted-foreground'>
                      generated
                    </span>
                  )}
                  {r.cleared ? (
                    <>
                      <span className='text-[12px] text-slate-500 dark:text-muted-foreground'>
                        Will be removed
                      </span>
                      <button
                        type='button'
                        className={ghostButton}
                        onClick={() => updSecret(r.id, { cleared: false })}
                      >
                        Undo
                      </button>
                    </>
                  ) : r.stored && !r.replacing ? (
                    <>
                      <span className='font-mono text-[12px] text-slate-500 dark:text-muted-foreground'>
                        {HUB_MASK}
                      </span>
                      <button
                        type='button'
                        className={ghostButton}
                        onClick={() => updSecret(r.id, { replacing: true })}
                      >
                        Replace
                      </button>
                      {!generated && (
                        <button
                          type='button'
                          className={ghostButton}
                          onClick={() => updSecret(r.id, { cleared: true })}
                        >
                          Clear
                        </button>
                      )}
                    </>
                  ) : (
                    <>
                      <Input
                        type='password'
                        autoComplete='new-password'
                        spellCheck={false}
                        aria-label={r.stored ? `New value for ${r.key}` : 'Secret value'}
                        value={r.value}
                        onChange={(e) => updSecret(r.id, { value: e.target.value })}
                        className='h-8 min-w-0 flex-1 font-mono text-[12px]'
                      />
                      <button
                        type='button'
                        className={ghostButton}
                        onClick={() =>
                          r.stored
                            ? updSecret(r.id, { replacing: false, value: '' })
                            : set({ secrets: draft.secrets.filter((x) => x.id !== r.id) })
                        }
                      >
                        Cancel
                      </button>
                    </>
                  )}
                </div>
                {r.replacing && r.key === 'ENCRYPTION_KEY' && (
                  <p className='m-0 text-[11px] text-amber-700 dark:text-amber-400'>
                    Data encrypted with the old key becomes unreadable.
                  </p>
                )}
                {rowErr('secret', r.id) && (
                  <p role='alert' className='m-0 text-[11px] text-red-600 dark:text-red-400'>
                    {rowErr('secret', r.id)}
                  </p>
                )}
              </li>
            )
          })}
        </ul>
        <button
          type='button'
          className={ghostButton}
          onClick={() =>
            set({
              secrets: [
                ...draft.secrets,
                { id: rid(), key: '', stored: false, value: '', replacing: true, cleared: false }
              ]
            })
          }
        >
          <Plus className='h-3.5 w-3.5' aria-hidden /> Add secret
        </button>
      </section>

      {pinsKnown ? (
        <section aria-label='Extension pins' className='space-y-1.5'>
          <h5 className='m-0 text-[12px] font-semibold text-slate-800 dark:text-foreground'>
            Extension pins
          </h5>
          <ul className='m-0 list-none space-y-1.5 p-0'>
            {kvRows('pin', draft.pins, (pins) => set({ pins }), {
              key: 'extension-id',
              value: 'repo@sha256:…'
            })}
          </ul>
          <button
            type='button'
            className={ghostButton}
            onClick={() => set({ pins: [...draft.pins, { id: rid(), key: '', value: '' }] })}
          >
            <Plus className='h-3.5 w-3.5' aria-hidden /> Add pin
          </button>
        </section>
      ) : (
        <p className='m-0 text-[11px] text-amber-700 dark:text-amber-400'>
          The stored extension pins cannot be read, so they are left alone.
        </p>
      )}

      {notice != null && (
        <ErrorNotice description={hubError(notice, 'Could not save the settings')} />
      )}
      <div className='flex items-center gap-2'>
        <Button
          size='sm'
          className='h-8 bg-nvr-cyan text-white hover:bg-nvr-cyan/90'
          disabled={!dirty || save.isPending}
          onClick={() => save.mutate()}
        >
          {save.isPending ? 'Saving…' : 'Save settings'}
        </Button>
        {dirty && (
          <Button
            size='sm'
            variant='ghost'
            className='h-8'
            onClick={() => {
              setFieldError(null)
              setNotice(null)
              if (q.data) seed(q.data)
            }}
          >
            Discard changes
          </Button>
        )}
      </div>
    </div>
  )
}
