import { FlaskConical, Plus, X } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { useNivaroClient } from '../../../context'
import { useDebounced } from '../../../hooks/useDebounced'
import { useRelationOptions } from '../../../hooks/useRelationOptions'
import { post } from '../../../lib/commands'
import { cn } from '../../../lib/utils'
import { Popover, PopoverContent, PopoverTrigger } from '../../ui/popover'
import { SimpleSelect } from '../../ui/SimpleSelect'
import { AiStartComposer, AiStartOptions } from '../ai-forms/AiStart'
import type { ComposeMode } from '../ai-forms/ai-forms-api'
import { apiFailure, fetchExplain, useDisplayTemplate, useRoleNames } from './overview-api'
import type { ExplainResponse, LayoutType } from './types'

export const LAYOUT_TYPES: Array<{ type: LayoutType; label: string; detail: string }> = [
  { type: 'grouped', label: 'Form', detail: 'What people fill in and edit' },
  { type: 'summary', label: 'Summary', detail: 'Read mode for a saved record' },
  { type: 'detail', label: 'Detail', detail: 'The panel a list opens when you drill in' },
  { type: 'file', label: 'PDF', detail: 'A PDF generated from the record' },
  { type: 'addendum', label: 'Addendum', detail: 'The form for a change to a saved record' },
  { type: 'table', label: 'Grid columns', detail: 'Columns when shown as a grid in another record' }
]

const DEFAULT_NAMES: Record<LayoutType, string> = {
  grouped: 'New form',
  summary: 'Summary',
  detail: 'Detail',
  file: 'PDF',
  addendum: 'Addendum',
  table: 'Grid columns'
}

export const btnOutline =
  'inline-flex h-8 items-center gap-1.5 whitespace-nowrap rounded-md border border-slate-200 bg-white px-2.5 text-[12.5px] font-medium text-slate-700 transition-colors hover:bg-slate-50 disabled:opacity-50 dark:border-border dark:bg-card dark:text-foreground dark:hover:bg-muted'
export const btnPrimary =
  'inline-flex h-8 items-center gap-1.5 whitespace-nowrap rounded-md bg-nvr-cyan px-3 text-[12.5px] font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-50'
const inputCls =
  'h-8 w-full rounded-md border border-slate-200 bg-white px-2.5 text-[12.5px] text-slate-800 outline-none placeholder:text-slate-400 focus:border-nvr-cyan dark:border-border dark:bg-background dark:text-foreground dark:placeholder:text-muted-foreground'
const labelCls = 'mb-1 block text-[11.5px] font-semibold text-slate-600 dark:text-muted-foreground'

/** Create a layout of a chosen type; returns the new id. */
export async function createLayout(
  client: ReturnType<typeof useNivaroClient>,
  body: { collection: string; name: string; layout_type: LayoutType; seed_fields?: boolean }
): Promise<number | null> {
  const res = await client.request<{ data?: { id?: number } | null; id?: number }>(
    post('/collection-layouts', body)
  )
  const id = res?.data?.id ?? res?.id
  return typeof id === 'number' ? id : id != null ? Number(id) : null
}

export function NewFormButton({
  collection,
  onCreated
}: {
  collection: string
  onCreated: (type: LayoutType, id: number) => void
}) {
  const client = useNivaroClient()
  const [open, setOpen] = useState(false)
  const [type, setType] = useState<LayoutType>('grouped')
  const [name, setName] = useState(DEFAULT_NAMES.grouped)
  const [nameTouched, setNameTouched] = useState(false)
  const [busy, setBusy] = useState(false)
  // "Start with AI" (#2668-#2670): the composer replaces the kind list.
  const [aiMode, setAiMode] = useState<ComposeMode | null>(null)

  const pick = (t: LayoutType) => {
    setType(t)
    if (!nameTouched) setName(DEFAULT_NAMES[t])
  }

  const create = async () => {
    const trimmed = name.trim()
    if (!trimmed || busy) return
    setBusy(true)
    try {
      const id = await createLayout(client, { collection, name: trimmed, layout_type: type })
      if (id == null) throw new Error('No id came back')
      setOpen(false)
      setNameTouched(false)
      setName(DEFAULT_NAMES.grouped)
      setType('grouped')
      onCreated(type, id)
    } catch (err) {
      toast.error(apiFailure(err, 'Could not create the layout').message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Popover
      open={open}
      onOpenChange={(v) => {
        setOpen(v)
        if (!v) setAiMode(null)
      }}
    >
      <PopoverTrigger asChild>
        <button type='button' className={btnPrimary}>
          <Plus className='h-3.5 w-3.5' />
          New form
        </button>
      </PopoverTrigger>
      <PopoverContent
        align='end'
        className={cn(
          'p-3',
          aiMode && 'max-h-[min(72vh,560px)] w-[460px] overflow-y-auto overscroll-contain',
          !aiMode && 'w-[320px]'
        )}
      >
        {aiMode ? (
          <AiStartComposer
            collection={collection}
            mode={aiMode}
            name={nameTouched ? name : null}
            onBack={() => setAiMode(null)}
            onCreated={(id) => {
              setOpen(false)
              setAiMode(null)
              onCreated('grouped', id)
            }}
          />
        ) : (
          <>
            <p className={labelCls}>What kind?</p>
            <div role='radiogroup' aria-label='Layout kind' className='flex flex-col gap-0.5'>
              {LAYOUT_TYPES.map((t) => (
                // biome-ignore lint/a11y/useSemanticElements: two-line option cards; a native radio cannot hold the description
                <button
                  key={t.type}
                  type='button'
                  role='radio'
                  aria-checked={type === t.type}
                  onClick={() => pick(t.type)}
                  className={cn(
                    'flex flex-col items-start rounded-md px-2 py-1.5 text-left transition-colors',
                    type === t.type ? 'bg-accent' : 'hover:bg-muted'
                  )}
                >
                  <span className='text-[12.5px] font-semibold text-slate-800 dark:text-foreground'>
                    {t.label}
                  </span>
                  <span className='text-[11.5px] text-slate-500 dark:text-muted-foreground'>
                    {t.detail}
                  </span>
                </button>
              ))}
            </div>
            <label className='mt-3 block'>
              <span className={labelCls}>Name</span>
              <input
                value={name}
                onChange={(e) => {
                  setName(e.target.value)
                  setNameTouched(true)
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void create()
                }}
                className={inputCls}
              />
            </label>
            <div className='mt-3 flex justify-end gap-2'>
              <button type='button' className={btnOutline} onClick={() => setOpen(false)}>
                Cancel
              </button>
              <button
                type='button'
                className={btnPrimary}
                disabled={!name.trim() || busy}
                onClick={() => void create()}
              >
                {busy ? 'Creating…' : 'Create'}
              </button>
            </div>
            {type === 'grouped' && <AiStartOptions onPick={setAiMode} />}
          </>
        )}
      </PopoverContent>
    </Popover>
  )
}

export interface ExplainResult extends ExplainResponse {
  recordLabel: string
  roleName: string | null
}

const AS_MYSELF = ''

export function TestRecordButton({
  collection,
  onResult
}: {
  collection: string
  onResult: (r: ExplainResult) => void
}) {
  const client = useNivaroClient()
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const debounced = useDebounced(search, 250)
  const [record, setRecord] = useState<{ id: string | number; label: string } | null>(null)
  const [roleId, setRoleId] = useState(AS_MYSELF)
  const [busy, setBusy] = useState(false)
  const { data: template } = useDisplayTemplate(collection, open)
  const { data: roles = [] } = useRoleNames(open)
  const { options, loading } = useRelationOptions(open ? client : null, collection, {
    search: debounced,
    limit: 8,
    displayTemplate: template ?? null,
    enabled: open && !record && template !== undefined
  })

  const run = async () => {
    if (!record || busy) return
    setBusy(true)
    try {
      const res = await fetchExplain(client, {
        collection,
        item: record.id,
        role_id: roleId || null
      })
      onResult({
        ...res,
        recordLabel: record.label,
        roleName: roles.find((r) => r.id === roleId)?.name ?? null
      })
      setOpen(false)
    } catch (err) {
      toast.error(apiFailure(err, 'Could not test that record').message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type='button' className={btnOutline}>
          <FlaskConical className='h-3.5 w-3.5' />
          Test a record…
        </button>
      </PopoverTrigger>
      <PopoverContent align='end' className='w-[340px] p-3'>
        <p className={labelCls}>Record</p>
        {record ? (
          <span className='inline-flex max-w-full items-center gap-1.5 rounded-full bg-nvr-cyan/10 px-2.5 py-1 text-[12px] font-medium text-slate-800 dark:text-foreground'>
            <span className='truncate'>{record.label}</span>
            <button
              type='button'
              aria-label='Pick another record'
              onClick={() => {
                setRecord(null)
                setSearch('')
              }}
              className='text-slate-500 hover:text-slate-800 dark:text-muted-foreground dark:hover:text-foreground'
            >
              <X className='h-3 w-3' />
            </button>
          </span>
        ) : (
          <>
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder='Search records…'
              className={inputCls}
            />
            <div className='mt-1 max-h-[220px] overflow-y-auto overscroll-contain'>
              {options.map((o) => (
                <button
                  key={String(o.id)}
                  type='button'
                  onClick={() => setRecord({ id: o.id, label: o.label })}
                  className='block w-full truncate rounded px-2 py-1.5 text-left text-[12.5px] text-slate-700 hover:bg-muted dark:text-foreground'
                >
                  {o.label}
                </button>
              ))}
              {!loading && options.length === 0 && (
                <p className='px-2 py-1.5 text-[12px] text-slate-500 dark:text-muted-foreground'>
                  No records match.
                </p>
              )}
            </div>
          </>
        )}
        <p className={cn(labelCls, 'mt-3')}>As a role (optional)</p>
        <SimpleSelect
          value={roleId}
          onChange={setRoleId}
          ariaLabel='Test as role'
          className='h-8 text-[12.5px]'
          options={[
            { value: AS_MYSELF, label: 'As myself' },
            ...roles.map((r) => ({ value: r.id, label: r.name }))
          ]}
        />
        <div className='mt-3 flex justify-end'>
          <button
            type='button'
            className={btnPrimary}
            disabled={!record || busy}
            onClick={() => void run()}
          >
            {busy ? 'Testing…' : 'Show its form'}
          </button>
        </div>
      </PopoverContent>
    </Popover>
  )
}
