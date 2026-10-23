import { ArrowRight, Check, ChevronsUpDown, Code2, Plus, Trash2 } from 'lucide-react'
import { useId, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router'
import { toast } from 'sonner'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList
} from '@/components/ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import { errorMessage, staleCurrent, type TemplateDetail } from './api'
import { usePayloadEditor } from './editor-context'
import { JsonDiff } from './JsonDiff'
import {
  buildLookups,
  describeLookups,
  emptyLookupRow,
  findErpAction,
  type LookupLine,
  type LookupRow,
  rowsFromLookups
} from './lookups'
import {
  draftLookupsOf,
  liveLookupsOf,
  sameLookups,
  serverErrors,
  useLookupCollections,
  usePipeline,
  useSaveLookups
} from './panel-api'
import { Bars, InlineError, OUTLINE_BTN, STRONG_BTN } from './panel-parts'

export interface DataTabProps {
  template: TemplateDetail
}

const H = 'text-[12.5px] font-semibold text-slate-800 dark:text-slate-100'
const P = 'text-[12.5px] text-slate-600 dark:text-slate-300'
const CODE = 'font-mono text-[11.5px] text-slate-800 dark:text-slate-100'

function LookupList({ lines, empty }: { lines: LookupLine[]; empty: string }) {
  if (!lines.length)
    return <p className='text-[12.5px] text-slate-500 dark:text-muted-foreground'>{empty}</p>
  return (
    <ul
      className='divide-y divide-slate-100 rounded-md border border-slate-200 dark:divide-border dark:border-border'
      data-payload-lookups
    >
      {lines.map((l) => (
        <li key={l.name} className='px-3 py-2'>
          <p className='flex min-w-0 flex-wrap items-baseline gap-x-1.5'>
            <span className={CODE}>context.{l.name}</span>
            <span className='text-[12px] text-slate-500 dark:text-muted-foreground'>
              — rows of <span className='font-mono text-[11.5px]'>{l.collection}</span>
            </span>
          </p>
          {l.details.length > 0 && (
            <p className='mt-0.5 break-words text-[12px] text-slate-500 dark:text-muted-foreground'>
              {l.details.join(' · ')}
            </p>
          )}
        </li>
      ))}
    </ul>
  )
}

const BUILTINS: Array<[string, string]> = [
  ['state.label / state.external_label', 'the state the transition moves the record to'],
  [
    'acting_user.name / .email / .employee_id',
    'whoever moved the record (empty on automatic moves)'
  ],
  ['today / now', 'the date and time of the push'],
  ['list.number', 'the 1-based row number inside a list']
]

function ActionLookups({ template }: { template: TemplateDetail }) {
  const ref = template.used_by.find((u) => u.kind === 'transition' && u.template_id)
  const q = usePipeline(ref?.template_id)
  if (!ref) return null
  const transitions = template.used_by.filter((u) => u.kind === 'transition')
  const tr = q.data?.transitions?.find((t) => String(t.id) === String(ref.transition_id))
  const action = tr ? findErpAction(tr.actions, template.key) : null
  // The pipeline no longer sends it from this transition: "previews read this one" would be wrong.
  const gone = !q.isLoading && !q.isError && !action
  return (
    <section className='space-y-2' aria-label='From the pipeline action'>
      <div className='flex flex-wrap items-baseline gap-x-2'>
        <h3 className={H}>From the pipeline action</h3>
        <Link
          to={`/pipelines/${ref.template_id}`}
          className='inline-flex items-center gap-1 text-[12px] font-medium text-slate-600 underline underline-offset-2 hover:text-slate-900 dark:text-slate-300 dark:hover:text-foreground'
        >
          Edit in pipeline
          <ArrowRight className='h-3 w-3' />
        </Link>
      </div>
      <p className={P}>
        {ref.label}
        {transitions.length > 1 && !gone
          ? ` — previews read this one; ${transitions.length - 1} more ${transitions.length === 2 ? 'transition sends' : 'transitions send'} this payload with their own lookups.`
          : ''}
      </p>
      {q.isLoading ? (
        <Bars rows={[60, 40]} />
      ) : q.isError ? (
        <InlineError
          title="The pipeline's lookups could not load."
          error={q.error}
          onRetry={() => void q.refetch()}
        />
      ) : !action ? (
        <p className='text-[12.5px] text-slate-500 dark:text-muted-foreground'>
          That transition no longer sends this payload. Reopen this page to refresh “Used by”.
        </p>
      ) : (
        <LookupList
          lines={describeLookups(action.context)}
          empty='This action reads no extra data — only the record itself.'
        />
      )}
    </section>
  )
}

const INPUT =
  'h-8 w-full rounded-md border border-slate-200 bg-white px-2.5 text-[12.5px] text-slate-800 placeholder:text-slate-500 dark:placeholder:text-slate-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan dark:border-border dark:bg-background dark:text-slate-100'
const JSON_INPUT =
  'block min-h-[56px] w-full resize-y rounded-md border border-slate-200 bg-slate-50 px-2.5 py-1.5 font-mono text-[11.5px] leading-[1.55] text-slate-800 placeholder:text-slate-500 dark:placeholder:text-slate-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan dark:border-border dark:bg-background dark:text-slate-200'
const FIELD_LABEL = 'mb-1 block text-[11.5px] font-medium text-slate-600 dark:text-slate-300'

function CollectionPicker({
  id,
  value,
  onChange
}: {
  id: string
  value: string
  onChange: (c: string) => void
}) {
  const [open, setOpen] = useState(false)
  const q = useLookupCollections(open || !!value)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          id={id}
          type='button'
          role='combobox'
          aria-expanded={open}
          className={cn(INPUT, 'flex items-center gap-2 text-left')}
        >
          <span
            className={cn(
              'min-w-0 flex-1 truncate font-mono text-[12px]',
              !value && 'font-sans text-slate-500 dark:text-muted-foreground'
            )}
          >
            {value || 'Pick a collection'}
          </span>
          <ChevronsUpDown className='h-3.5 w-3.5 shrink-0 text-slate-400' />
        </button>
      </PopoverTrigger>
      <PopoverContent className='w-[280px] p-0' align='start'>
        <Command>
          <CommandInput placeholder='Search collections…' className='h-8 text-[12px]' />
          <CommandList>
            {q.isError ? (
              <p className='px-3 py-3 text-[12px] text-red-600 dark:text-red-400'>
                {errorMessage(q.error, 'Collections could not load')}
              </p>
            ) : q.isLoading ? (
              <div className='space-y-1.5 p-2' aria-hidden>
                {[0, 1, 2].map((i) => (
                  <div
                    key={i}
                    className='h-6 animate-pulse rounded bg-[hsl(var(--nvr-skeleton))]'
                  />
                ))}
              </div>
            ) : (
              <>
                <CommandEmpty className='py-3 text-center text-[12px] text-muted-foreground'>
                  No collection matches
                </CommandEmpty>
                <CommandGroup>
                  {(q.data ?? []).map((c) => (
                    <CommandItem
                      key={c}
                      value={c}
                      onSelect={() => {
                        onChange(c)
                        setOpen(false)
                      }}
                      className='gap-2 font-mono text-[12px]'
                    >
                      <Check
                        className={cn(
                          'h-3 w-3 shrink-0',
                          c === value ? 'opacity-100' : 'opacity-0'
                        )}
                      />
                      {c}
                    </CommandItem>
                  ))}
                </CommandGroup>
              </>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

function LookupRowEditor({
  row,
  errors,
  onChange,
  onRemove
}: {
  row: LookupRow
  errors: string[]
  onChange: (next: LookupRow) => void
  onRemove: () => void
}) {
  const id = useId()
  const set = (patch: Partial<LookupRow>) => onChange({ ...row, ...patch })
  const kept = Object.keys(row.extra)
  return (
    <li className='space-y-2.5 px-3 py-3' data-payload-lookup-row>
      <div className='grid grid-cols-1 gap-2.5 sm:grid-cols-2'>
        <div>
          <label htmlFor={`${id}-name`} className={FIELD_LABEL}>
            Name{' '}
            <span className='font-normal text-slate-500 dark:text-muted-foreground'>
              (read as context.name)
            </span>
          </label>
          <input
            id={`${id}-name`}
            value={row.name}
            onChange={(e) => set({ name: e.target.value })}
            placeholder='lines'
            spellCheck={false}
            className={cn(INPUT, 'font-mono text-[12px]')}
          />
        </div>
        <div>
          <label htmlFor={`${id}-col`} className={FIELD_LABEL}>
            Rows of
          </label>
          <CollectionPicker
            id={`${id}-col`}
            value={row.collection}
            onChange={(c) => set({ collection: c })}
          />
        </div>
      </div>
      <div>
        <label htmlFor={`${id}-filter`} className={FIELD_LABEL}>
          Filter{' '}
          <span className='font-normal text-slate-500 dark:text-muted-foreground'>
            (JSON, optional)
          </span>
        </label>
        <textarea
          id={`${id}-filter`}
          value={row.filterText}
          onChange={(e) => set({ filterText: e.target.value })}
          placeholder={'{ "workflow": "$id" }'}
          spellCheck={false}
          className={JSON_INPUT}
        />
        <p className='mt-1 text-[11.5px] text-slate-500 dark:text-muted-foreground'>
          <span className='font-mono'>$id</span> = this record,{' '}
          <span className='font-mono'>$record.field</span> = a field on it,{' '}
          <span className='font-mono'>$user</span> = whoever moved it.
        </p>
      </div>
      <div className='grid grid-cols-2 gap-2.5'>
        <div>
          <label htmlFor={`${id}-sort`} className={FIELD_LABEL}>
            Sort
          </label>
          <input
            id={`${id}-sort`}
            value={row.sort}
            onChange={(e) => set({ sort: e.target.value })}
            placeholder='-id'
            spellCheck={false}
            className={cn(INPUT, 'font-mono text-[12px]')}
          />
        </div>
        <div>
          <label htmlFor={`${id}-limit`} className={FIELD_LABEL}>
            Up to (rows)
          </label>
          <input
            id={`${id}-limit`}
            value={row.limit}
            onChange={(e) => set({ limit: e.target.value })}
            placeholder='500'
            inputMode='numeric'
            className={cn(INPUT, 'tabular-nums')}
          />
        </div>
      </div>
      <div>
        <label htmlFor={`${id}-expand`} className={FIELD_LABEL}>
          Expand{' '}
          <span className='font-normal text-slate-500 dark:text-muted-foreground'>
            (JSON, optional — adds fk_data)
          </span>
        </label>
        <textarea
          id={`${id}-expand`}
          value={row.expandText}
          onChange={(e) => set({ expandText: e.target.value })}
          placeholder={'{ "item": { "collection": "items", "fields": ["code", "name"] } }'}
          spellCheck={false}
          className={JSON_INPUT}
        />
      </div>
      {kept.length > 0 && (
        <p className='text-[11.5px] text-slate-500 dark:text-muted-foreground'>
          Also keeps <span className='font-mono'>{kept.join(', ')}</span> as set elsewhere.
        </p>
      )}
      {errors.length > 0 && (
        <ul className='space-y-0.5 text-[12px] text-red-700 dark:text-red-300' role='alert'>
          {errors.map((m) => (
            <li key={m}>{m}</li>
          ))}
        </ul>
      )}
      <button
        type='button'
        onClick={onRemove}
        className='inline-flex items-center gap-1 text-[12px] font-medium text-slate-500 hover:text-red-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan dark:text-muted-foreground dark:hover:text-red-300'
      >
        <Trash2 className='h-3 w-3' />
        Remove lookup
      </button>
    </li>
  )
}

const isBlank = (r: LookupRow) =>
  !r.name && !r.collection && !r.filterText && !r.expandText && !r.sort && !r.limit

/** A UI-created template's own lookups: edit, check, save (PUT /:key/lookups). */
function LookupsEditor({ template }: { template: TemplateDetail }) {
  const ctx = usePayloadEditor()
  const ctxRef = useRef(ctx)
  ctxRef.current = ctx
  const draftLookups = draftLookupsOf(template)
  const live = liveLookupsOf(template)
  const initial = useMemo(() => rowsFromLookups(draftLookups), [draftLookups])
  const [rows, setRows] = useState<LookupRow[]>(initial)
  const [blocked, setBlocked] = useState<string | null>(null)
  const save = useSaveLookups(template.key)
  const unpublished = !sameLookups(draftLookups, live)
  const built = useMemo(() => buildLookups(rows), [rows])
  const baseline = useMemo(() => JSON.stringify(buildLookups(initial).value), [initial])
  const dirty = JSON.stringify(built.value) !== baseline
  const hasErrors = Object.keys(built.errors).length > 0
  const srvErrors = save.isError ? serverErrors(save.error) : []

  const update = (uid: string, next: LookupRow) =>
    setRows((rs) => rs.map((r) => (r.uid === uid ? next : r)))

  const doSave = async () => {
    setBlocked(null)
    // Lookups ride the draft's revision: send any waiting body edit first, then save at its rev.
    const ok = await ctxRef.current.saveNow()
    if (!ok) {
      setBlocked(
        ctxRef.current.conflicted
          ? 'Saving is paused by the conflict above. Reload, or keep your draft, first.'
          : 'Your latest body edit didn’t save, so the lookups weren’t saved either. Fix it first.'
      )
      return
    }
    try {
      const key = template.key
      const saved = await save.mutateAsync({
        lookups: built.value,
        base_rev: ctxRef.current.getRev() ?? 0,
        base_published_version: ctxRef.current.getLoadedVersion(key)
      })
      // Recorded under the template this save was for, even if the editor moved on meanwhile.
      ctxRef.current.bumpRev(key, saved.rev)
      setRows(rowsFromLookups(saved.lookups))
      toast.success('Lookups saved to the draft', {
        description: 'Previews of the draft read them now. Publish to use them in pushes.'
      })
    } catch (e) {
      const current = staleCurrent(e)
      if (current) {
        ctxRef.current.raiseConflict(current)
        setBlocked('The draft changed on the server. See the banner above.')
      }
    }
  }

  return (
    <div className='space-y-2.5' data-payload-lookups-editor>
      {rows.length === 0 ? (
        <p className='text-[12.5px] text-slate-500 dark:text-muted-foreground'>
          None yet. Add one when a field needs rows from another collection — e.g. the lines of this
          record.
        </p>
      ) : (
        <ul className='divide-y divide-slate-100 rounded-md border border-slate-200 dark:divide-border dark:border-border'>
          {rows.map((r) => (
            <LookupRowEditor
              key={r.uid}
              row={r}
              errors={
                isBlank(r)
                  ? ['Fill in a name and the collection it reads, or remove it.']
                  : (built.errors[r.uid] ?? [])
              }
              onChange={(n) => update(r.uid, n)}
              onRemove={() => setRows((rs) => rs.filter((x) => x.uid !== r.uid))}
            />
          ))}
        </ul>
      )}
      {blocked && (
        <p className='text-[12px] text-red-700 dark:text-red-300' role='alert'>
          {blocked}
        </p>
      )}
      {srvErrors.length > 0 ? (
        <ul className='space-y-0.5 text-[12px] text-red-700 dark:text-red-300' role='alert'>
          {srvErrors.map((m) => (
            <li key={m}>{m}</li>
          ))}
        </ul>
      ) : save.isError && !staleCurrent(save.error) ? (
        <p className='text-[12px] text-red-700 dark:text-red-300' role='alert'>
          {errorMessage(save.error, 'The lookups were not saved')}
        </p>
      ) : null}
      <div className='flex flex-wrap items-center gap-2'>
        <button
          type='button'
          onClick={() => setRows((rs) => [...rs, emptyLookupRow()])}
          className={OUTLINE_BTN}
        >
          <Plus className='h-3.5 w-3.5 text-slate-400' />
          Add lookup
        </button>
        <span
          data-tip={
            !dirty
              ? 'No changes to save'
              : hasErrors
                ? 'Fix the lookups marked in red first'
                : undefined
          }
        >
          <button
            type='button'
            disabled={!dirty || hasErrors || save.isPending}
            onClick={() => void doSave()}
            className={STRONG_BTN}
            data-payload-lookups-save
          >
            {save.isPending ? 'Saving…' : 'Save lookups'}
          </button>
        </span>
        {dirty && (
          <button
            type='button'
            onClick={() => {
              setRows(rowsFromLookups(draftLookups))
              save.reset()
              setBlocked(null)
            }}
            className='text-[12px] font-medium text-slate-500 underline underline-offset-2 hover:text-slate-800 dark:text-muted-foreground dark:hover:text-foreground'
          >
            Discard changes
          </button>
        )}
      </div>
      <p className='text-[11.5px] text-slate-500 dark:text-muted-foreground'>
        Saved to the draft — publish to use. Pushes keep reading the live version’s lookups until
        then.
      </p>
      {unpublished && !dirty && (
        <div className='space-y-1.5 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 dark:border-amber-500/30 dark:bg-amber-500/10'>
          <p className='text-[12px] font-medium text-amber-900 dark:text-amber-200'>
            The draft’s lookups differ from the live ones
          </p>
          <JsonDiff
            before={live ?? {}}
            after={draftLookups ?? {}}
            beforeLabel={`live v${template.published_version ?? '—'}`}
            afterLabel='draft'
            sameText=''
          />
        </div>
      )}
    </div>
  )
}

/**
 * Data tab: what a field path can read — the record, the lookups (from the
 * pipeline action that sends the payload, read-only here, plus the
 * template's own) and the built-ins; for code-built pushes, who provides the
 * data.
 */
export function DataTab({ template }: DataTabProps) {
  const own = describeLookups(draftLookupsOf(template))
  const codeSenders = template.used_by.filter((u) => u.kind === 'code')
  const hasTransitions = template.used_by.some((u) => u.kind === 'transition')
  // Built by an extension's code (its scope() documents the variables in the description).
  const codeBuilt = codeSenders.length > 0 || (!!template.owner && !hasTransitions)
  return (
    <div className='space-y-5 px-5 py-4' data-payload-data-tab>
      <section className='space-y-1.5' aria-label='The record'>
        <h3 className={H}>The record</h3>
        <p className={P}>
          <span className={CODE}>record</span> is the{' '}
          <span className='font-mono text-[11.5px]'>{template.collection}</span> record being sent —
          every field on it, by its field name.
        </p>
      </section>

      {hasTransitions && <ActionLookups template={template} />}

      <section className='space-y-2' aria-label="This payload's own lookups">
        <h3 className={H}>This payload’s own lookups</h3>
        <p className={P}>
          {template.owner
            ? `Declared by ${template.owner} in code, so they're read-only here (restoring a version or the file default puts that version's into the draft — publish to use). A pipeline action’s lookup with the same name wins.`
            : 'Extra rows every sender of this payload reads. A pipeline action’s lookup with the same name wins.'}
        </p>
        {template.owner ? (
          <LookupList
            lines={own}
            empty={
              hasTransitions ? 'None — the pipeline action above supplies the extra data.' : 'None.'
            }
          />
        ) : (
          <LookupsEditor key={template.key} template={template} />
        )}
      </section>

      {codeSenders.length > 0 && (
        <section className='space-y-2' aria-label='Code pushes'>
          <h3 className={H}>Code pushes</h3>
          <p className={P}>
            {template.owner ?? 'An extension'} builds the data for these pushes in code: the same{' '}
            <span className={CODE}>record</span>, plus whatever it adds for the push.
          </p>
          <ul className='space-y-1'>
            {codeSenders.map((u) => (
              <li
                key={u.label}
                className='flex items-center gap-2 text-[12.5px] text-slate-700 dark:text-slate-200'
              >
                <Code2 className='h-3 w-3 shrink-0 text-slate-400' />
                {u.label}
              </li>
            ))}
          </ul>
        </section>
      )}

      {codeBuilt && template.description?.trim() && (
        <section className='space-y-1.5' aria-label='What the push provides'>
          <h3 className={H}>What {template.owner ?? 'the extension'} provides</h3>
          <p
            className='whitespace-pre-wrap break-words text-[12.5px] leading-relaxed text-slate-600 dark:text-slate-300'
            data-payload-scope-doc
          >
            {template.description}
          </p>
        </section>
      )}

      <section className='space-y-2' aria-label='Built-in values'>
        <h3 className={H}>Built-in values</h3>
        <ul className='space-y-1'>
          {BUILTINS.map(([k, v]) => (
            <li key={k} className='text-[12.5px] text-slate-600 dark:text-slate-300'>
              <span className={CODE}>{k}</span> — {v}
            </li>
          ))}
        </ul>
      </section>
    </div>
  )
}
