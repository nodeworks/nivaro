import { ConfirmButton } from '@nivaro/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ListChecks, X } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { SimpleSelect } from '@/components/ui/simple-select'
import { Switch } from '@/components/ui/switch'
import { UserCombobox } from '@/components/user-combobox'
import { api, type User } from '@/lib/api'
import { cn } from '@/lib/utils'
import { hubToast } from '../hub-api'
import { dangerArmed, dangerGhost, Field, ghostButton, SectionCard } from '../hub-parts'
import {
  archiveItem,
  type ChangesOverview,
  type ChecklistAction,
  type ChecklistItem,
  changeKeys,
  saveItem,
  TICK_BY_WORDS,
  type TickBy
} from './changes-api'

/**
 * Pre-deploy checklist items per app. A production promotion, move or shared upgrade cannot
 * start until every required item that applies is ticked for that start. Owners read their
 * apps' items; administrators change them. Removing an item archives it (a used checklist still
 * names it).
 */

const ACTION_WORDS: Record<ChecklistAction, string> = {
  promote: 'Promotions',
  move: 'Moves',
  upgrade: 'Shared upgrades'
}

function ItemForm({
  data,
  current,
  appId: fixedApp,
  onDone
}: {
  data: ChangesOverview
  current: ChecklistItem | null
  appId: number | null
  onDone: () => void
}) {
  const qc = useQueryClient()
  const [appId, setAppId] = useState(String(current?.app_id ?? fixedApp ?? data.apps[0]?.id ?? ''))
  const [envId, setEnvId] = useState(current?.environment_id ? String(current.environment_id) : '')
  const [text, setText] = useState(current?.text ?? '')
  const [help, setHelp] = useState(current?.help ?? '')
  const [required, setRequired] = useState(current?.required ?? true)
  const [tickBy, setTickBy] = useState<TickBy>(current?.tick_by ?? 'owner')
  const [people, setPeople] = useState<string[]>(current?.tick_people ?? [])
  const [names, setNames] = useState<Array<string | null>>(current?.tick_people_names ?? [])
  const [actions, setActions] = useState<ChecklistAction[]>(
    current?.actions ?? ['promote', 'move', 'upgrade']
  )
  // The picker's own list (same key and shape as UserCombobox) names people just added.
  const users = useQuery({
    queryKey: ['users', 'combobox'],
    queryFn: () => api.get<{ data: User[] }>('/users?limit=200').then((r) => r.data.data),
    enabled: tickBy === 'people'
  })
  const nameOf = (id: string, i: number) => {
    const u = users.data?.find((x) => x.id === id)
    const full = u ? [u.first_name, u.last_name].filter(Boolean).join(' ').trim() : ''
    return full || u?.email || names[i] || 'Someone'
  }
  const prodEnvs = data.environments.filter((e) => e.app_id === Number(appId) && e.production)
  const save = useMutation({
    mutationFn: () =>
      saveItem(current?.id ?? null, {
        app_id: Number(appId),
        environment_id: envId ? Number(envId) : null,
        text,
        help: help.trim() || null,
        required,
        tick_by: tickBy,
        ...(tickBy === 'people' ? { tick_people: people } : {}),
        actions,
        position: current?.position ?? 0
      }),
    onSuccess: () => {
      toast.success('Checklist item saved')
      void qc.invalidateQueries({ queryKey: changeKeys.all })
      onDone()
    },
    onError: (err) => hubToast(err, 'Could not save the checklist item')
  })
  const valid =
    !!appId && !!text.trim() && actions.length > 0 && (tickBy !== 'people' || people.length > 0)
  return (
    <div className='space-y-3 border-b border-slate-200 bg-slate-50 px-4 py-3 dark:border-border dark:bg-muted/40'>
      <div className='grid gap-3 sm:grid-cols-2'>
        <Field id='cl-app' label='App'>
          <SimpleSelect
            value={appId}
            onChange={(v) => {
              setAppId(v)
              setEnvId('')
            }}
            options={data.apps.map((a) => ({ value: String(a.id), label: a.key }))}
            ariaLabel='App'
            className='h-8 bg-white text-left text-[13px] dark:bg-background'
            triggerProps={{ id: 'cl-app' }}
          />
        </Field>
        <Field id='cl-env' label='Environment'>
          <SimpleSelect
            value={envId || 'all'}
            onChange={(v) => setEnvId(v === 'all' ? '' : v)}
            options={[
              { value: 'all', label: 'Every production environment' },
              ...prodEnvs.map((e) => ({ value: String(e.id), label: e.key }))
            ]}
            ariaLabel='Environment'
            className='h-8 bg-white text-left text-[13px] dark:bg-background'
            triggerProps={{ id: 'cl-env' }}
          />
        </Field>
      </div>
      <Field id='cl-text' label='Item'>
        <Input
          id='cl-text'
          value={text}
          onChange={(e) => setText(e.target.value)}
          maxLength={500}
          placeholder='Support told about the release'
          className='h-8 text-[13px]'
        />
      </Field>
      <Field
        id='cl-help'
        label='Help (optional)'
        hint='Shown under the item: where to check, whom to ask.'
      >
        <Input
          id='cl-help'
          value={help}
          onChange={(e) => setHelp(e.target.value)}
          maxLength={1000}
          className='h-8 text-[13px]'
        />
      </Field>
      <div className='grid gap-3 sm:grid-cols-2'>
        <Field id='cl-who' label='Who may tick it'>
          <SimpleSelect
            value={tickBy}
            onChange={(v) => setTickBy(v === 'admin' || v === 'people' ? v : 'owner')}
            options={(['owner', 'admin', 'people'] as TickBy[]).map((v) => ({
              value: v,
              label: TICK_BY_WORDS[v]
            }))}
            ariaLabel='Who may tick it'
            className='h-8 bg-white text-left text-[13px] dark:bg-background'
            triggerProps={{ id: 'cl-who' }}
          />
        </Field>
        <fieldset className='m-0 space-y-1.5 border-0 p-0'>
          <legend className='mb-1.5 text-[12px] font-medium text-slate-700 dark:text-foreground'>
            Needed for
          </legend>
          <div className='flex flex-wrap gap-1.5'>
            {(['promote', 'move', 'upgrade'] as ChecklistAction[]).map((a) => {
              const on = actions.includes(a)
              return (
                <button
                  key={a}
                  type='button'
                  aria-pressed={on}
                  onClick={() => setActions(on ? actions.filter((x) => x !== a) : [...actions, a])}
                  className={cn(
                    'h-8 rounded-md border px-2.5 text-[12px] font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/50',
                    on
                      ? 'border-nvr-cyan/60 bg-nvr-cyan/10 text-nvr-navy dark:text-nvr-cyan'
                      : 'border-slate-200 bg-white text-slate-500 hover:bg-slate-50 dark:border-border dark:bg-background dark:text-slate-400 dark:hover:bg-muted'
                  )}
                >
                  {ACTION_WORDS[a]}
                </button>
              )
            })}
          </div>
        </fieldset>
      </div>
      {tickBy === 'people' && (
        <div className='space-y-1.5'>
          <span className='block text-[12px] font-medium text-slate-700 dark:text-foreground'>
            People who may tick it
          </span>
          <p className='m-0 text-[11px] text-slate-500 dark:text-muted-foreground'>
            Only these people — administrators too only when named here.
          </p>
          {people.length > 0 && (
            <ul className='m-0 flex list-none flex-wrap gap-1.5 p-0'>
              {people.map((p, i) => (
                <li
                  key={p}
                  className='inline-flex items-center gap-1 rounded-full border border-slate-200 bg-white px-2 py-px text-[11.5px] dark:border-border dark:bg-background'
                >
                  {nameOf(p, i)}
                  <button
                    type='button'
                    aria-label={`Remove ${nameOf(p, i)}`}
                    className='rounded-full p-0.5 text-slate-500 hover:bg-slate-100 dark:hover:bg-muted'
                    onClick={() => {
                      setPeople(people.filter((_, j) => j !== i))
                      setNames(names.filter((_, j) => j !== i))
                    }}
                  >
                    <X className='h-3 w-3' aria-hidden />
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className='w-full max-w-[320px]'>
            <UserCombobox
              value={null}
              hideNone
              placeholder='Add a person…'
              onChange={(v) => {
                if (!v || people.includes(v)) return
                setPeople([...people, v])
                setNames([...names, null])
              }}
              className='h-8 w-full text-[13px]'
            />
          </div>
        </div>
      )}
      <div className='flex items-center gap-2'>
        <Switch id='cl-required' checked={required} onCheckedChange={setRequired} />
        <label htmlFor='cl-required' className='text-[12px] text-slate-700 dark:text-foreground'>
          {required ? 'Required — the start waits for it' : 'Optional — shown, never waited for'}
        </label>
      </div>
      <div className='flex gap-2'>
        <Button
          size='sm'
          className='h-8 bg-nvr-cyan text-white hover:bg-nvr-cyan/90'
          disabled={!valid || save.isPending}
          onClick={() => save.mutate()}
        >
          {save.isPending ? 'Saving…' : 'Save item'}
        </Button>
        <Button size='sm' variant='ghost' className='h-8' onClick={onDone}>
          Cancel
        </Button>
      </div>
    </div>
  )
}

function whoWords(i: ChecklistItem): string {
  if (i.tick_by !== 'people') return TICK_BY_WORDS[i.tick_by].toLowerCase()
  const named = (i.tick_people_names ?? []).filter(Boolean)
  return named.length ? named.join(', ') : `${i.tick_people.length} named people`
}

export function ChecklistItemsCard({
  data,
  isAdmin,
  appFilter
}: {
  data: ChangesOverview
  isAdmin: boolean
  appFilter: number | null
}) {
  const qc = useQueryClient()
  const [editing, setEditing] = useState<ChecklistItem | 'new' | null>(null)
  const remove = useMutation({
    mutationFn: (id: number) => archiveItem(id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: changeKeys.all }),
    onError: (err) => hubToast(err, 'Could not remove the item')
  })
  const apps = data.apps.filter((a) => appFilter == null || a.id === appFilter)
  const envKey = (id: number | null) =>
    id == null
      ? 'every production environment'
      : (data.environments.find((e) => e.id === id)?.key ?? `#${id}`)
  return (
    <SectionCard
      title='Pre-deploy checklists'
      description='What must be ticked before a production promotion, move or shared upgrade of an app starts.'
      actions={
        isAdmin &&
        !editing &&
        data.apps.length > 0 && (
          <button type='button' className={ghostButton} onClick={() => setEditing('new')}>
            <ListChecks className='h-3.5 w-3.5' aria-hidden /> New item
          </button>
        )
      }
    >
      {editing && (
        <ItemForm
          key={editing === 'new' ? 'new' : editing.id}
          data={data}
          current={editing === 'new' ? null : editing}
          appId={appFilter}
          onDone={() => setEditing(null)}
        />
      )}
      {apps.every((a) => !data.items.some((i) => i.app_id === a.id)) ? (
        <p className='m-0 px-4 py-3 text-[12px] text-slate-500 dark:text-muted-foreground'>
          No checklist items: production starts need no ticks.
        </p>
      ) : (
        <div className='divide-y divide-slate-100 dark:divide-border'>
          {apps.map((a) => {
            const items = data.items.filter((i) => i.app_id === a.id)
            if (!items.length) return null
            return (
              <section key={a.id} aria-label={a.key} className='px-4 py-2.5'>
                <h4 className='m-0 mb-1.5 text-[12px] font-semibold text-slate-800 dark:text-slate-100'>
                  {a.key}
                </h4>
                <ul className='m-0 list-none space-y-1.5 p-0'>
                  {items.map((i) => (
                    <li key={i.id} className='flex items-start gap-3 text-[12px]'>
                      <div className='min-w-0 flex-1'>
                        <div className='text-slate-900 dark:text-foreground'>
                          {i.text}
                          {!i.required && (
                            <span className='ml-1.5 text-[11px] text-slate-500 dark:text-muted-foreground'>
                              optional
                            </span>
                          )}
                        </div>
                        <div className='text-[11px] text-slate-500 dark:text-muted-foreground'>
                          {envKey(i.environment_id)} ·{' '}
                          {i.actions.map((x) => ACTION_WORDS[x].toLowerCase()).join(', ')} · ticked
                          by {whoWords(i)}
                        </div>
                      </div>
                      {isAdmin && (
                        <div className='flex shrink-0 gap-1'>
                          <button
                            type='button'
                            className={ghostButton}
                            onClick={() => setEditing(i)}
                          >
                            Edit
                          </button>
                          <ConfirmButton
                            className={dangerGhost}
                            armedClassName={dangerArmed}
                            confirmLabel='Remove it?'
                            onConfirm={() => remove.mutate(i.id)}
                          >
                            Remove
                          </ConfirmButton>
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              </section>
            )
          })}
        </div>
      )}
    </SectionCard>
  )
}
