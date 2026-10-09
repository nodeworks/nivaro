import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertCircle, AlertTriangle } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useNivaroClient } from '../../../context'
import { get } from '../../../lib/commands'
import { Input } from '../../ui/input'
import { Label } from '../../ui/label'
import { Textarea } from '../../ui/textarea'
import { helpVideoApi, helpVideoKeys, useHelpVideoPages } from '../api'
import type { HelpVideoContext, HelpVideoDto, Visibility } from '../types'
import { PickerCombo, RemovableChip, RoleChips } from './PickerCombo'
import { blindRequiredRoles, joinNames } from './publish'

const label = (s: string) => s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())

type Text = { title: string; description: string; category: string }

const chipBase =
  'rounded-full border px-2.5 py-1 text-[12px] transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan motion-reduce:transition-none'
const chipOn = 'border-nvr-cyan bg-nvr-cyan/15 font-medium text-foreground'
const chipOff = 'border-border text-foreground hover:bg-muted'

function Section({
  title,
  hint,
  children
}: {
  title: string
  hint?: string
  children: React.ReactNode
}) {
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
  // the tab closes, so Publish and a tab switch never see stale text.
  const latest = useRef<Text>({ title, description, category })
  latest.current = { title, description, category }
  const sent = useRef<Text>(latest.current)
  const sendText = useCallback(() => {
    const t = latest.current
    const s = sent.current
    if (t.title === s.title && t.description === s.description && t.category === s.category) return
    sent.current = t
    helpVideoApi(client)
      .update(video.id, {
        title: t.title,
        description: t.description || null,
        category: t.category || null
      })
      .then(() => {
        setProblem(null)
        return refresh()
      })
      .catch((e) => {
        sent.current = s
        fail('The text', e)
      })
  }, [client, video.id, refresh, fail])
  // biome-ignore lint/correctness/useExhaustiveDependencies: the timer restarts on a text change only
  useEffect(() => {
    const t = window.setTimeout(sendText, 800)
    return () => window.clearTimeout(t)
  }, [title, description, category])
  // biome-ignore lint/correctness/useExhaustiveDependencies: lands the last edit when the tab closes
  useEffect(() => sendText, [])

  const saveContexts = (next: HelpVideoContext[]) => {
    const prev = contexts
    setContexts(next)
    helpVideoApi(client)
      .setContexts(video.id, next)
      .then(() => {
        setProblem(null)
        return refresh()
      })
      .catch((e) => {
        setContexts(prev)
        fail('Where it shows', e)
      })
  }
  const saveVisibility = (next: Visibility) => {
    const prev = visibility
    setVisibility(next)
    helpVideoApi(client)
      .update(video.id, { visibility: next })
      .then(() => {
        setProblem(null)
        return refresh()
      })
      .catch((e) => {
        setVisibility(prev)
        fail('Who can watch', e)
      })
  }
  const saveRequired = (next: string[]) => {
    const prev = required
    setRequired(next)
    helpVideoApi(client)
      .setRequirements(video.id, next)
      .then(() => {
        setProblem(null)
        return refresh()
      })
      .catch((e) => {
        setRequired(prev)
        fail('Required for', e)
      })
  }

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
  const collectionKeys = [
    ...new Set(contexts.filter((c) => c.kind === 'collection').map((c) => c.key))
  ]
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
  const roleName = (id: string) =>
    roles.data?.find((r) => r.id.toUpperCase() === id.toUpperCase())?.name ?? id
  const collName = (c: string) =>
    collections.data?.find((x) => x.collection === c)?.display_name || label(c)

  const toggleState = (collection: string, stateKey: string) => {
    const has = contexts.some(
      (c) => c.kind === 'collection' && c.key === collection && c.state_key === stateKey
    )
    const rest = contexts.filter(
      (c) => !(c.kind === 'collection' && c.key === collection && c.state_key === stateKey)
    )
    saveContexts(
      has ? rest : [...rest, { kind: 'collection', key: collection, state_key: stateKey }]
    )
  }

  const blind = blindRequiredRoles(visibility, required)
  const idp = `hv-details-${video.id}`

  return (
    <div className='max-w-[760px] space-y-5 p-5 text-[13px]' data-hv-details>
      <div className='space-y-1.5'>
        <Label htmlFor={`${idp}-title`}>Title</Label>
        <Input
          id={`${idp}-title`}
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
          value={description}
          rows={3}
          maxLength={4000}
          onChange={(e) => setDescription(e.target.value)}
          onBlur={sendText}
          className='text-[13px]'
        />
      </div>
      <div className='space-y-1.5'>
        <Label htmlFor={`${idp}-category`}>Category</Label>
        <Input
          id={`${idp}-category`}
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
        {collectionKeys.map((c, i) => (
          <div
            key={c}
            className='space-y-2 rounded-md border border-border p-3'
            data-hv-context-collection={c}
          >
            <div className='flex items-center gap-2'>
              <span className='font-medium text-foreground'>{collName(c)}</span>
              <button
                type='button'
                className='ml-auto rounded-sm text-[12px] text-muted-foreground underline underline-offset-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan'
                aria-label={`Remove ${collName(c)}`}
                onClick={() =>
                  saveContexts(contexts.filter((x) => !(x.kind === 'collection' && x.key === c)))
                }
              >
                Remove
              </button>
            </div>
            <div className='flex flex-wrap gap-1.5'>
              {(states[i]?.data ?? []).map((s) => {
                const on = contexts.some(
                  (x) => x.kind === 'collection' && x.key === c && x.state_key === s.key
                )
                return (
                  <button
                    key={s.key}
                    type='button'
                    aria-pressed={on}
                    onClick={() => toggleState(c, s.key)}
                    className={`${chipBase} ${on ? chipOn : chipOff}`}
                    data-hv-state-chip={s.key}
                  >
                    {s.label}
                  </button>
                )
              })}
              {states[i]?.data?.length === 0 && (
                <span className='text-[12px] text-muted-foreground'>
                  This collection has no pipeline steps.
                </span>
              )}
            </div>
          </div>
        ))}
        {contexts.some((c) => c.kind === 'page') && (
          <div className='flex flex-wrap gap-1.5'>
            {contexts
              .filter((c) => c.kind === 'page')
              .map((p) => (
                <RemovableChip
                  key={p.key}
                  removeLabel={`Remove ${pages.data?.find((x) => x.key === p.key)?.label ?? p.key}`}
                  onRemove={() =>
                    saveContexts(contexts.filter((x) => !(x.kind === 'page' && x.key === p.key)))
                  }
                  data-hv-context-page={p.key}
                >
                  {pages.data?.find((x) => x.key === p.key)?.label ?? p.key}
                </RemovableChip>
              ))}
          </div>
        )}
        {contexts.length === 0 && (
          <p className='text-[12px] text-muted-foreground'>
            Not shown anywhere yet. Add a record form or a page to publish.
          </p>
        )}
        <div className='flex flex-wrap gap-2'>
          <PickerCombo
            ariaLabel='Add a collection'
            placeholder='Add a record form'
            options={(collections.data ?? [])
              .filter(
                (c) => !c.collection.startsWith('nivaro_') && !collectionKeys.includes(c.collection)
              )
              .map((c) => ({ value: c.collection, label: c.display_name || label(c.collection) }))}
            onPick={(v) =>
              saveContexts([...contexts, { kind: 'collection', key: v, state_key: null }])
            }
          />
          <PickerCombo
            ariaLabel='Add a page'
            placeholder='Add a page'
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
          {(['everyone', 'roles'] as const).map((m) => (
            // biome-ignore lint/a11y/useSemanticElements: a segmented control — buttons in a radiogroup, not native radios
            <button
              key={m}
              type='button'
              role='radio'
              aria-checked={visibility.mode === m}
              onClick={() =>
                saveVisibility({ mode: m, role_ids: m === 'everyone' ? [] : visibility.role_ids })
              }
              className={`h-8 border-l border-input px-3 text-[12.5px] transition-colors duration-150 first:border-l-0 focus-visible:relative focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-nvr-cyan motion-reduce:transition-none ${visibility.mode === m ? 'bg-nvr-cyan/15 font-semibold text-foreground' : 'bg-background text-foreground hover:bg-muted'}`}
              data-hv-visibility={m}
            >
              {m === 'everyone' ? 'Everyone' : 'Chosen roles'}
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
        />
        {blind.length > 0 && (
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
