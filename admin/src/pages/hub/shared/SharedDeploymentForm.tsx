import { type ErrorDescription, ErrorNotice } from '@nivaro/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { SimpleSelect } from '@/components/ui/simple-select'
import { Textarea } from '@/components/ui/textarea'
import { fetchDrivers, HUB_KEY_PATTERN, hubKeys, isBaseUrl } from '../hub-api'
import { Field } from '../hub-parts'
import {
  createShared,
  MODE_WORDS,
  type SharedCreated,
  type SharedDeployment,
  type SharedInput,
  type SharedMode,
  sharedError,
  sharedKeys,
  updateShared
} from './shared-api'

/**
 * Add or edit a shared deployment (inline, in the detail pane). Key and how it runs are set once:
 * an edit shows them read-only and sends only the fields that changed. The API checks everything
 * again; the checks here only save a round trip.
 */

interface Draft {
  name: string
  key: string
  mode: SharedMode
  driver_id: string
  stack: string
  link_url: string
  host_pattern: string
  extensions: string
  pins: string
  pool_budget: string
}

const PATTERN_RE = /^\*\.(?:[a-z0-9-]{1,63}\.)+[a-z0-9-]{1,63}$/
const EXT_ID_RE = /^[a-z0-9-]{1,64}$/
const VERSION_RE = /^[0-9A-Za-z][0-9A-Za-z._+-]{0,63}$/
const STACK_RE = /^[a-z][a-z0-9-]{1,40}$/

function draftOf(s: SharedDeployment | null): Draft {
  return {
    name: s?.name ?? '',
    key: s?.key ?? '',
    mode: s?.mode ?? 'registered',
    driver_id: s?.driver_id != null ? String(s.driver_id) : '',
    stack: s?.stack ?? '',
    link_url: s?.link_url ?? '',
    host_pattern: s?.host_pattern ?? '',
    extensions: (s?.extensions ?? []).join(', '),
    pins: Object.entries(s?.extension_pins ?? {})
      .map(([id, v]) => `${id}=${v}`)
      .join('\n'),
    pool_budget: String(s?.pool_budget ?? 60)
  }
}

/** "a, b c" → ['a', 'b', 'c'] (duplicates dropped, order kept). */
export const extensionList = (raw: string): string[] => [
  ...new Set(
    raw
      .split(/[\s,]+/)
      .map((x) => x.trim())
      .filter(Boolean)
  )
]

/** "id=version" lines → a map; null when a line is not of that shape. */
export function pinMap(raw: string): Record<string, string> | null {
  const out: Record<string, string> = {}
  for (const line of raw.split('\n')) {
    const t = line.trim()
    if (!t) continue
    const m = /^([^=\s]+)\s*=\s*(\S+)$/.exec(t)
    if (!m) return null
    out[m[1]] = m[2]
  }
  return out
}

/** What the form would refuse before the API is asked. */
export function sharedDraftErrors(
  d: Draft,
  creating: boolean
): Partial<Record<keyof Draft, string>> {
  const e: Partial<Record<keyof Draft, string>> = {}
  if (!d.name.trim() || d.name.trim().length > 200)
    e.name = 'Give it a name (at most 200 characters)'
  if (creating && !HUB_KEY_PATTERN.test(d.key.trim()))
    e.key = '2–63 lower-case letters, digits and hyphens, starting with a letter'
  if (creating && d.mode === 'docker' && !d.driver_id) e.driver_id = 'Pick the Docker driver'
  if (creating && d.mode === 'docker' && d.stack.trim() && !STACK_RE.test(d.stack.trim()))
    e.stack = '2–41 lower-case letters, digits and hyphens, starting with a letter'
  if (!isBaseUrl(d.link_url))
    e.link_url = 'An address such as https://shared-one.internal.example.com'
  if (d.host_pattern.trim() && !PATTERN_RE.test(d.host_pattern.trim()))
    e.host_pattern = 'A wildcard name such as *.apps.example.com (lower case)'
  const exts = extensionList(d.extensions)
  if (exts.length > 50 || exts.some((x) => !EXT_ID_RE.test(x)))
    e.extensions = 'Extension ids: lower-case letters, digits and hyphens, separated by commas'
  const pins = pinMap(d.pins)
  if (!pins || Object.entries(pins).some(([id, v]) => !exts.includes(id) || !VERSION_RE.test(v)))
    e.pins = 'One extension=version per line, for an extension listed above'
  const budget = Number(d.pool_budget)
  if (!/^\d+$/.test(d.pool_budget.trim()) || budget < 1 || budget > 500)
    e.pool_budget = 'A whole number from 1 to 500'
  return e
}

function inputOf(d: Draft): SharedInput {
  const docker = d.mode === 'docker'
  return {
    key: d.key.trim(),
    name: d.name.trim(),
    mode: d.mode,
    driver_id: docker ? Number(d.driver_id) : null,
    stack: docker && d.stack.trim() ? d.stack.trim() : null,
    link_url: d.link_url.trim().replace(/\/$/, ''),
    host_pattern: d.host_pattern.trim() || null,
    extensions: extensionList(d.extensions),
    extension_pins: pinMap(d.pins) ?? {},
    pool_budget: Number(d.pool_budget)
  }
}

/** The editable fields that differ from the stored row (an edit sends only these). */
function changesOf(row: SharedDeployment, next: SharedInput): Partial<SharedInput> {
  const out: Partial<SharedInput> = {}
  if (next.name !== row.name) out.name = next.name
  if (next.link_url !== row.link_url.replace(/\/$/, '')) out.link_url = next.link_url
  if ((next.host_pattern ?? null) !== (row.host_pattern ?? null))
    out.host_pattern = next.host_pattern
  if (JSON.stringify(next.extensions) !== JSON.stringify(row.extensions))
    out.extensions = next.extensions
  if (JSON.stringify(next.extension_pins) !== JSON.stringify(row.extension_pins ?? {}))
    out.extension_pins = next.extension_pins
  if (next.pool_budget !== row.pool_budget) out.pool_budget = next.pool_budget
  return out
}

const MODE_OPTIONS = (['registered', 'docker'] as const).map((m) => ({
  value: m,
  label: MODE_WORDS[m].label
}))

export function SharedDeploymentForm({
  shared,
  onCreated,
  onSaved,
  onCancel
}: {
  shared: SharedDeployment | null
  onCreated?: (created: SharedCreated) => void
  onSaved?: (row: SharedDeployment) => void
  onCancel: () => void
}) {
  const qc = useQueryClient()
  const creating = shared === null
  const [d, setD] = useState<Draft>(() => draftOf(shared))
  const [tried, setTried] = useState(false)
  const [failure, setFailure] = useState<ErrorDescription | null>(null)
  const set = (patch: Partial<Draft>) => setD((x) => ({ ...x, ...patch }))
  const errors = sharedDraftErrors(d, creating)
  const invalid = Object.values(errors).some(Boolean)
  const err = (k: keyof Draft) => (tried ? (errors[k] ?? null) : null)

  const drivers = useQuery({
    queryKey: hubKeys.drivers(),
    queryFn: fetchDrivers,
    enabled: creating && d.mode === 'docker'
  })
  const dockerDrivers = (drivers.data ?? []).filter((x) => x.kind === 'docker')

  const changes = shared ? changesOf(shared, inputOf(d)) : null
  const unchanged = changes !== null && Object.keys(changes).length === 0

  const save = useMutation({
    mutationFn: async () => {
      if (!shared) return { created: await createShared(inputOf(d)) }
      return { saved: await updateShared(shared.id, changes ?? {}) }
    },
    onSuccess: (r) => {
      setFailure(null)
      void qc.invalidateQueries({ queryKey: sharedKeys.list() })
      if ('created' in r && r.created) onCreated?.(r.created)
      if ('saved' in r && r.saved) {
        void qc.invalidateQueries({ queryKey: sharedKeys.detail(r.saved.id) })
        onSaved?.(r.saved)
      }
    },
    onError: (e) =>
      setFailure(
        sharedError(e, creating ? 'Could not add the shared deployment' : 'Could not save')
      )
  })

  const submit = () => {
    setTried(true)
    if (invalid || unchanged) return
    save.mutate()
  }

  return (
    <form
      aria-label={creating ? 'New shared deployment' : `Edit ${shared.name}`}
      className='space-y-4 p-4 sm:p-6'
      onSubmit={(e) => {
        e.preventDefault()
        submit()
      }}
    >
      <div>
        <h2 className='m-0 text-[15px] font-semibold text-slate-900 dark:text-foreground'>
          {creating ? 'New shared deployment' : `Edit ${shared.name}`}
        </h2>
        <p className='m-0 mt-1 max-w-[72ch] text-[12px] text-slate-500 dark:text-muted-foreground'>
          One process serving many apps, each with its own database. The Hub sends it the list of
          apps it serves and calls it on its link address.
        </p>
      </div>

      <div className='grid max-w-[880px] grid-cols-1 gap-4 md:grid-cols-2'>
        <Field id='sh-name' label='Name' error={err('name')}>
          <Input
            id='sh-name'
            value={d.name}
            onChange={(e) => set({ name: e.target.value })}
            className='h-8 text-[13px]'
          />
        </Field>

        {creating ? (
          <Field
            id='sh-key'
            label='Key'
            error={err('key')}
            hint='Names the deployment everywhere (HUB_SHARED_DEPLOYMENT). It never changes.'
          >
            <Input
              id='sh-key'
              value={d.key}
              onChange={(e) => set({ key: e.target.value })}
              autoComplete='off'
              spellCheck={false}
              placeholder='shared-one'
              className='h-8 font-mono text-[13px]'
            />
          </Field>
        ) : (
          <ReadOnly label='Key' value={shared.key} mono />
        )}

        {creating ? (
          <Field id='sh-mode' label='How it runs' hint={MODE_WORDS[d.mode].tip}>
            <SimpleSelect
              value={d.mode}
              onChange={(v) => set({ mode: v as SharedMode })}
              options={MODE_OPTIONS}
              ariaLabel='How it runs'
              className='h-8 bg-white text-left text-[13px] dark:bg-background'
              triggerProps={{ id: 'sh-mode' }}
            />
          </Field>
        ) : (
          <ReadOnly label='How it runs' value={MODE_WORDS[shared.mode].label} />
        )}

        {creating && d.mode === 'docker' && (
          <Field
            id='sh-driver'
            label='Docker driver'
            error={err('driver_id')}
            hint={
              drivers.isSuccess && dockerDrivers.length === 0
                ? 'No Docker driver yet: add one under Drivers first.'
                : 'The agent that runs the stack.'
            }
          >
            <SimpleSelect
              value={d.driver_id}
              onChange={(v) => set({ driver_id: v })}
              options={[
                { value: '', label: 'Pick a driver' },
                ...dockerDrivers.map((x) => ({ value: String(x.id), label: x.name }))
              ]}
              ariaLabel='Docker driver'
              className='h-8 bg-white text-left text-[13px] dark:bg-background'
              triggerProps={{ id: 'sh-driver' }}
            />
          </Field>
        )}

        {creating && d.mode === 'docker' && (
          <Field
            id='sh-stack'
            label='Stack name'
            error={err('stack')}
            hint='Leave empty to use the key.'
          >
            <Input
              id='sh-stack'
              value={d.stack}
              onChange={(e) => set({ stack: e.target.value })}
              autoComplete='off'
              spellCheck={false}
              placeholder={d.key || 'shared-one'}
              className='h-8 font-mono text-[13px]'
            />
          </Field>
        )}

        <Field
          id='sh-link'
          label='Link address'
          error={err('link_url')}
          hint='Where the Hub reaches the deployment: an https origin, or http to a private address outside production.'
        >
          <Input
            id='sh-link'
            value={d.link_url}
            onChange={(e) => set({ link_url: e.target.value })}
            autoComplete='off'
            spellCheck={false}
            placeholder='https://shared-one.internal.example.com'
            className='h-8 font-mono text-[13px]'
          />
        </Field>

        <Field
          id='sh-pattern'
          label='Host pattern'
          error={err('host_pattern')}
          hint='Optional. Every app name under it reaches this deployment, e.g. *.apps.example.com.'
        >
          <Input
            id='sh-pattern'
            value={d.host_pattern}
            onChange={(e) => set({ host_pattern: e.target.value })}
            autoComplete='off'
            spellCheck={false}
            placeholder='*.apps.example.com'
            className='h-8 font-mono text-[13px]'
          />
        </Field>

        <Field
          id='sh-ext'
          label='Extensions'
          error={err('extensions')}
          hint='The only extensions it loads (HUB_SHARED_EXTENSIONS), separated by commas. An app that needs another one cannot be placed here.'
        >
          <Input
            id='sh-ext'
            value={d.extensions}
            onChange={(e) => set({ extensions: e.target.value })}
            autoComplete='off'
            spellCheck={false}
            placeholder='none'
            className='h-8 font-mono text-[13px]'
          />
        </Field>

        <Field
          id='sh-budget'
          label='Pool budget'
          error={err('pool_budget')}
          hint='Database connections all apps here may hold together (each app has its own pool max).'
        >
          <Input
            id='sh-budget'
            inputMode='numeric'
            value={d.pool_budget}
            onChange={(e) => set({ pool_budget: e.target.value })}
            className='h-8 max-w-[140px] font-mono text-[13px]'
          />
        </Field>

        <div className='md:col-span-2'>
          <Field
            id='sh-pins'
            label='Extension pins'
            error={err('pins')}
            hint='Optional. One extension=version per line; an app whose pin differs cannot be placed here.'
          >
            <Textarea
              id='sh-pins'
              value={d.pins}
              onChange={(e) => set({ pins: e.target.value })}
              spellCheck={false}
              rows={2}
              placeholder='efp-ops=1.4.2'
              className='font-mono text-[12px]'
            />
          </Field>
        </div>
      </div>

      {failure && <ErrorNotice description={failure} />}

      <div className='flex flex-wrap items-center gap-2'>
        <Button
          type='submit'
          size='sm'
          className='h-8 bg-nvr-cyan text-white hover:bg-nvr-cyan/90'
          disabled={save.isPending || unchanged}
        >
          {save.isPending ? 'Saving…' : creating ? 'Add shared deployment' : 'Save'}
        </Button>
        <Button type='button' variant='outline' size='sm' className='h-8' onClick={onCancel}>
          Cancel
        </Button>
        {tried && invalid && (
          <span role='status' className='text-[12px] text-red-600 dark:text-red-400'>
            Check the fields marked above.
          </span>
        )}
      </div>
    </form>
  )
}

function ReadOnly({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className='space-y-1.5'>
      <p className='m-0 text-[12px] font-medium text-slate-700 dark:text-foreground'>{label}</p>
      <p
        className={
          mono
            ? 'm-0 font-mono text-[13px] text-slate-900 dark:text-foreground'
            : 'm-0 text-[13px] text-slate-900 dark:text-foreground'
        }
      >
        {value}
      </p>
      <p className='m-0 text-[11px] text-slate-500 dark:text-muted-foreground'>
        Set when it was added; add a new shared deployment to change it.
      </p>
    </div>
  )
}
