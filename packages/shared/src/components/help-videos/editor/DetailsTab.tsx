import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertCircle, AlertTriangle } from 'lucide-react'
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react'
import { useNivaroClient } from '../../../context'
import { get } from '../../../lib/commands'
import { Input } from '../../ui/input'
import { Label } from '../../ui/label'
import { Textarea } from '../../ui/textarea'
import { helpVideoApi, helpVideoKeys, useHelpVideoPages } from '../api'
import type { HelpVideoContext, HelpVideoDto, Visibility } from '../types'
import { addCollection, collectionKeysOf, removeCollection, stepsOf, toggleStep } from './contexts'
import { PickerCombo, RemovableChip, RoleChips } from './PickerCombo'
import { blindRequiredRoles, joinNames } from './publish'

const label = (s: string) => s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())

type Text = { title: string; description: string; category: string }
type Confirmed = {
  contexts: HelpVideoContext[]
  visibility: Visibility
  required: string[]
}

const chipBase =
  'rounded-full border px-2.5 py-1 text-[12px] transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan motion-reduce:transition-none'
const chipOn = 'border-nvr-cyan bg-nvr-cyan/15 font-medium text-foreground'
const chipOff = 'border-border text-foreground hover:bg-muted'
const linkBtn =
  'rounded-sm underline underline-offset-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan'

function Section({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <section className='space-y-2.5 border-t border-border pt-5'>
      <div className='space-y-0.5'>
        <h3 className='text-[13px] font-semibold text-foreground'>{title}</h3>
        {hint && <p className='max-w-[65ch] text-[12px] text-muted-foreground'>{hint}</p>}
      </div>
      {children}
    </section>
  )
}

/** A lookup that failed, in one plain line (loading reads in the picker and the chips). */
function Lookup({ error, what, onRetry }: { error: boolean; what: string; onRetry: () => void }) {
  if (error)
    return (
      <p
        className='flex items-start gap-1.5 text-[12px] text-rose-700 dark:text-rose-300'
        role='alert'
      >
        <AlertCircle className='mt-px h-3.5 w-3.5 shrink-0' aria-hidden />
        <span>
          The list of {what} couldn't load.{' '}
          <button type='button' className={linkBtn} onClick={onRetry}>
            Try again
          </button>
        </span>
      </p>
    )
  return null
}

const VIS = [
  ['everyone', 'Everyone'],
  ['roles', 'Chosen roles']
] as const

export function DetailsTab({ video }: { video: HelpVideoDto }) {
  const client = useNivaroClient()
  const qc = useQueryClient()
  const [title, setTitle] = useState(video.title)
  const [description, setDescription] = useState(video.description ?? '')
  const [category, setCategory] = useState(video.category ?? '')
  const [contexts, setContexts] = useState<HelpVideoContext[]>(video.contexts)
  const [visibility, setVisibility] = useState<Visibility>(
    video.visibility ?? { mode: 'everyone', role_ids: [] }
  )
  const [required, setRequired] = useState<string[]>(video.required_role_ids ?? [])
  // One inline line for a change that did not save (the control keeps what was typed).
  const [problem, setProblem] = useState<string | null>(null)

  const refresh = useCallback(
    () => qc.invalidateQueries({ queryKey: helpVideoKeys.one(video.id) }),
    [qc, video.id]
  )
  const fail = useCallback((what: string, e: unknown) => {
    const why = (e as Error)?.message
    setProblem(`${what} didn't save${why ? `: ${why}` : '.'} Change it again to retry.`)
  }, [])

  // Text saves 800 ms after typing stops, when a field loses focus, and when
  // the tab closes, so Publish and a tab switch never see stale text. Only the
  // fields that changed go out: a copy of the video that is a moment old must
  // never write its title back over a newer one.
  const latest = useRef<Text>({ title, description, category })
  latest.current = { title, description, category }
  const sent = useRef<Text>(latest.current)
  const inputs = useRef<Record<keyof Text, HTMLElement | null>>({
    title: null,
    description: null,
    category: null
  })
  const sendText = useCallback(() => {
    const t = latest.current
    const s = sent.current
    const body: Partial<{ title: string; description: string | null; category: string | null }> = {}
    if (t.title !== s.title) body.title = t.title
    if (t.description !== s.description) body.description = t.description || null
    if (t.category !== s.category) body.category = t.category || null
    const keys = Object.keys(body) as Array<keyof Text>
    if (!keys.length) return
    sent.current = { ...s, ...Object.fromEntries(keys.map((k) => [k, t[k]])) }
    helpVideoApi(client)
      .update(video.id, body)
      .then(() => {
        setProblem(null)
        // The cached video carries what was just saved, so a screen that mounts
        // from it (a tab switch, a reload) never starts from the old text.
        qc.setQueryData<HelpVideoDto>(helpVideoKeys.one(video.id), (old) =>
          old ? { ...old, ...body } : old
        )
        return refresh()
      })
      .catch((e) => {
        sent.current = { ...sent.current, ...Object.fromEntries(keys.map((k) => [k, s[k]])) }
        fail('The text', e)
      })
  }, [client, video.id, qc, refresh, fail])
  // biome-ignore lint/correctness/useExhaustiveDependencies: the timer restarts on a text change only
  useEffect(() => {
    const t = window.setTimeout(sendText, 800)
    return () => window.clearTimeout(t)
  }, [title, description, category])
  // biome-ignore lint/correctness/useExhaustiveDependencies: lands the last edit when the tab closes
  useEffect(() => sendText, [])

  // A newer copy of the video (a save that landed, another editor) reaches a
  // field only when the person has no unsent edit in it and is not typing in it.
  const reseed = (k: keyof Text, value: string, set: (v: string) => void) => {
    if (latest.current[k] !== sent.current[k]) return
    if (inputs.current[k] && document.activeElement === inputs.current[k]) return
    if (latest.current[k] === value) return
    sent.current = { ...sent.current, [k]: value }
    set(value)
  }
  // biome-ignore lint/correctness/useExhaustiveDependencies: reacts to the video's own text only
  useEffect(() => {
    reseed('title', video.title, setTitle)
    reseed('description', video.description ?? '', setDescription)
    reseed('category', video.category ?? '', setCategory)
  }, [video.title, video.description, video.category])

  // Saves of the lists go one after another, and a failure goes back to the
  // last value the server confirmed (not to what an earlier, overlapping save left).
  const confirmed = useRef<Confirmed>({ contexts, visibility, required })
  const chain = useRef<Promise<void>>(Promise.resolve())
  const persist = <K extends keyof Confirmed>(
    key: K,
    next: Confirmed[K],
    set: (v: Confirmed[K]) => void,
    run: () => Promise<unknown>,
    what: string
  ) => {
    set(next)
    chain.current = chain.current.then(async () => {
      try {
        await run()
        confirmed.current = { ...confirmed.current, [key]: next }
        setProblem(null)
        void refresh()
      } catch (e) {
        set(confirmed.current[key])
        fail(what, e)
      }
    })
  }
  const saveContexts = (next: HelpVideoContext[]) =>
    persist(
      'contexts',
      next,
      setContexts,
      () => helpVideoApi(client).setContexts(video.id, next),
      'Where it shows'
    )
  const saveVisibility = (next: Visibility) =>
    persist(
      'visibility',
      next,
      setVisibility,
      () => helpVideoApi(client).update(video.id, { visibility: next }),
      'Who can watch'
    )
  const saveRequired = (next: string[]) =>
    persist(
      'required',
      next,
      setRequired,
      () => helpVideoApi(client).setRequirements(video.id, next),
      'Required for'
    )

  const roles = useQuery({
    queryKey: ['chat-roles'],
    queryFn: async () =>
      (await client.request(get<{ data: Array<{ id: string; name: string }> }>('/chat/roles'))).data
  })
  const collections = useQuery({
    queryKey: ['hv-collections'],
    queryFn: async () =>
      (
        await client.request(
          get<{ data: Array<{ collection: string; display_name?: string | null }> }>('/collections')
        )
      ).data
  })
  const pages = useHelpVideoPages()
  const collectionKeys = collectionKeysOf(contexts)
  const states = useQueries({
    queries: collectionKeys.map((c) => ({
      queryKey: ['hv-states', c],
      queryFn: async () =>
        (
          await client.request(
            get<{ data: Array<{ key: string; label: string }> }>(`/queues/collection-states/${c}`)
          )
        ).data
    }))
  })
  const emptyOf = (q: { isLoading: boolean; isError: boolean }) =>
    q.isLoading ? 'Loading…' : q.isError ? "The list couldn't load." : undefined
  const roleName = (id: string) =>
    roles.data?.find((r) => r.id.toUpperCase() === id.toUpperCase())?.name ??
    (roles.isLoading ? 'Loading…' : 'Unknown role')
  const collName = (c: string) =>
    collections.data?.find((x) => x.collection === c)?.display_name || label(c)
  const pageName = (key: string) =>
    pages.data?.find((x) => x.key === key)?.label ?? (pages.isLoading ? 'Loading…' : 'Unknown page')

  const blind = blindRequiredRoles(visibility, required)
  const idp = `hv-details-${video.id}`
  const radios = useRef<Array<HTMLButtonElement | null>>([])
  const pickVis = (i: number) => {
    const m = VIS[(i + VIS.length) % VIS.length][0]
    saveVisibility({ mode: m, role_ids: m === 'everyone' ? [] : visibility.role_ids })
    radios.current[(i + VIS.length) % VIS.length]?.focus()
  }

  return (
    <div className='max-w-[760px] space-y-5 p-5 text-[13px]' data-hv-details>
      <div className='space-y-1.5'>
        <Label htmlFor={`${idp}-title`}>Title</Label>
        <Input
          id={`${idp}-title`}
          ref={(el) => {
            inputs.current.title = el
          }}
          value={title}
          maxLength={200}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={sendText}
          className='h-9 text-[13px]'
          data-hv-title
        />
      </div>
      <div className='space-y-1.5'>
        <Label htmlFor={`${idp}-description`}>Description</Label>
        <Textarea
          id={`${idp}-description`}
          ref={(el) => {
            inputs.current.description = el
          }}
          value={description}
          rows={3}
          maxLength={4000}
          onChange={(e) => setDescription(e.target.value)}
          onBlur={sendText}
          className='text-[13px]'
          data-hv-description
        />
      </div>
      <div className='space-y-1.5'>
        <Label htmlFor={`${idp}-category`}>Category</Label>
        <Input
          id={`${idp}-category`}
          ref={(el) => {
            inputs.current.category = el
          }}
          value={category}
          maxLength={100}
          onChange={(e) => setCategory(e.target.value)}
          onBlur={sendText}
          placeholder='For example, Workflows'
          className='h-9 text-[13px]'
        />
      </div>

      <Section
        title='Where it shows'
        hint='On a record form, the Videos button lists the videos for that collection. Pick steps to show a video only at those steps, or leave them all off to show it at every step.'
      >
        {collectionKeys.map((c, i) => {
          const q = states[i]
          const chosen = stepsOf(contexts, c)
          const known = q?.data ?? []
          // A chosen step the pipeline no longer lists still shows, so it can be turned off.
          const extra = chosen.filter((s) => !known.some((k) => k.key === s))
          return (
            <div
              key={c}
              className='space-y-2 rounded-md border border-border p-3'
              data-hv-context-collection={c}
            >
              <div className='flex items-center gap-2'>
                <span className='font-medium text-foreground'>{collName(c)}</span>
                <span className='text-[12px] text-muted-foreground' data-hv-step-summary>
                  {chosen.length ? 'Only at the chosen steps' : 'Every step'}
                </span>
                <button
                  type='button'
                  className={`ml-auto text-[12px] text-muted-foreground ${linkBtn}`}
                  aria-label={`Remove ${collName(c)}`}
                  onClick={() => saveContexts(removeCollection(contexts, c))}
                >
                  Remove
                </button>
              </div>
              <div className='flex flex-wrap items-center gap-1.5'>
                {[...known, ...extra.map((s) => ({ key: s, label: label(s) }))].map((s) => {
                  const on = chosen.includes(s.key)
                  return (
                    <button
                      key={s.key}
                      type='button'
                      aria-pressed={on}
                      onClick={() => saveContexts(toggleStep(contexts, c, s.key))}
                      className={`${chipBase} ${on ? chipOn : chipOff}`}
                      data-hv-state-chip={s.key}
                    >
                      {s.label}
                    </button>
                  )
                })}
                {q?.isLoading && (
                  <span className='text-[12px] text-muted-foreground'>Loading steps…</span>
                )}
                {q?.isError && (
                  <span className='text-[12px] text-rose-700 dark:text-rose-300' role='alert'>
                    The steps couldn't load.{' '}
                    <button type='button' className={linkBtn} onClick={() => void q.refetch()}>
                      Try again
                    </button>
                  </span>
                )}
                {q?.data?.length === 0 && extra.length === 0 && (
                  <span className='text-[12px] text-muted-foreground'>
                    This collection has no pipeline steps.
                  </span>
                )}
              </div>
            </div>
          )
        })}
        {contexts.some((c) => c.kind === 'page') && (
          <div className='flex flex-wrap gap-1.5'>
            {contexts
              .filter((c) => c.kind === 'page')
              .map((p) => (
                <RemovableChip
                  key={p.key}
                  removeLabel={`Remove ${pageName(p.key)}`}
                  onRemove={() =>
                    saveContexts(contexts.filter((x) => !(x.kind === 'page' && x.key === p.key)))
                  }
                  data-hv-context-page={p.key}
                >
                  {pageName(p.key)}
                </RemovableChip>
              ))}
          </div>
        )}
        {contexts.length === 0 && (
          <p className='text-[12px] text-muted-foreground'>
            Not shown anywhere yet. Add a record form or a page to publish.
          </p>
        )}
        <Lookup
          error={collections.isError}
          what='record forms'
          onRetry={() => void collections.refetch()}
        />
        <Lookup error={pages.isError} what='pages' onRetry={() => void pages.refetch()} />
        <div className='flex flex-wrap gap-2'>
          <PickerCombo
            ariaLabel='Add a record form'
            placeholder='Add a record form'
            emptyText={emptyOf(collections)}
            options={(collections.data ?? [])
              .filter(
                (c) => !c.collection.startsWith('nivaro_') && !collectionKeys.includes(c.collection)
              )
              .map((c) => ({ value: c.collection, label: c.display_name || label(c.collection) }))}
            onPick={(v) => saveContexts(addCollection(contexts, v))}
          />
          <PickerCombo
            ariaLabel='Add a page'
            placeholder='Add a page'
            emptyText={emptyOf(pages)}
            options={(pages.data ?? [])
              .filter((p) => !contexts.some((c) => c.kind === 'page' && c.key === p.key))
              .map((p) => ({ value: p.key, label: p.label, hint: p.app ?? undefined }))}
            onPick={(v) => saveContexts([...contexts, { kind: 'page', key: v, state_key: null }])}
          />
        </div>
      </Section>

      <Section title='Who can watch'>
        <div
          className='inline-flex overflow-hidden rounded-md border border-input'
          role='radiogroup'
          aria-label='Who can watch'
        >
          {VIS.map(([m, text], i) => (
            // biome-ignore lint/a11y/useSemanticElements: a segmented control — buttons in a radiogroup, not native radios
            <button
              key={m}
              ref={(el) => {
                radios.current[i] = el
              }}
              type='button'
              role='radio'
              aria-checked={visibility.mode === m}
              tabIndex={visibility.mode === m ? 0 : -1}
              onClick={() =>
                saveVisibility({ mode: m, role_ids: m === 'everyone' ? [] : visibility.role_ids })
              }
              onKeyDown={(e) => {
                if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
                  e.preventDefault()
                  pickVis(i + 1)
                } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
                  e.preventDefault()
                  pickVis(i - 1)
                }
              }}
              className={`h-8 border-l border-input px-3 text-[12.5px] transition-colors duration-150 first:border-l-0 focus-visible:relative focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-nvr-cyan motion-reduce:transition-none ${visibility.mode === m ? 'bg-nvr-cyan/15 font-semibold text-foreground' : 'bg-background text-foreground hover:bg-muted'}`}
              data-hv-visibility={m}
            >
              {text}
            </button>
          ))}
        </div>
        {visibility.mode === 'roles' && (
          <RoleChips
            roles={roles.data ?? []}
            selected={visibility.role_ids}
            onChange={(ids) => saveVisibility({ mode: 'roles', role_ids: ids })}
            roleName={roleName}
            addLabel='Add a role that can watch'
            emptyText={emptyOf(roles)}
          />
        )}
        {visibility.mode === 'roles' && visibility.role_ids.length === 0 && (
          <p className='flex items-start gap-1.5 text-[12px] text-amber-800 dark:text-amber-200'>
            <AlertTriangle className='mt-px h-3.5 w-3.5 shrink-0' aria-hidden />
            Pick at least one role. Until then, everyone can watch it.
          </p>
        )}
      </Section>

      <Section
        title='Required for'
        hint='People in these roles see the video in their Required videos list until they have watched it.'
      >
        <RoleChips
          roles={roles.data ?? []}
          selected={required}
          onChange={saveRequired}
          roleName={roleName}
          addLabel='Add a required role'
          emptyText={emptyOf(roles)}
        />
        <Lookup error={roles.isError} what='roles' onRetry={() => void roles.refetch()} />
        {blind.length > 0 && !roles.isLoading && (
          <p
            className='flex items-start gap-1.5 text-[12px] text-amber-800 dark:text-amber-200'
            data-hv-blind-roles
          >
            <AlertTriangle className='mt-px h-3.5 w-3.5 shrink-0' aria-hidden />
            <span>
              {joinNames(blind.map(roleName))} must watch this but can't see it. Add them to who can
              watch, or they won't be asked.
            </span>
          </p>
        )}
      </Section>

      <div role='status' aria-live='polite' className='min-h-[1rem]'>
        {problem && (
          <p
            className='flex items-start gap-1.5 text-[12px] text-rose-700 dark:text-rose-300'
            data-hv-details-problem
          >
            <AlertCircle className='mt-px h-3.5 w-3.5 shrink-0' aria-hidden />
            {problem}
          </p>
        )}
      </div>
    </div>
  )
}
