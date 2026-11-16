import { CollectionFieldPicker, type RelationWalk } from '@nivaro/shared'
import { ChevronDown, ListTree, Network, Rows3, TextCursorInput } from 'lucide-react'
import { useState } from 'react'
import { Popover, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import { humanizePath } from './labels'
import {
  FmLabel,
  FmPopoverContent,
  Hint,
  type ItemScope,
  quietButton,
  smallAction,
  TextField,
  useFieldMapEnv
} from './ui'

// Pickers that produce a render-scope path without making anyone type one:
// a field of this record (the relation-walking FieldPicker), a field of each
// list item, or a related-data lookup from the template's context.

/**
 * What a render can read through a relation (api payload-templates/hops.ts): many-to-one links
 * only, at most three deep. Every picker here walks no further, so it never offers a path that
 * reads nothing.
 */
export const PAYLOAD_WALK: RelationWalk = { m2oOnly: true, maxHops: 3 }

/** The path a pick from each list item writes: `material.cifa.task.name`. */
export function itemPath(alias: string, picked: string[]): string {
  return [alias, ...picked].join('.')
}

const CONTEXT_RE = /^context\.([^.[\]]+)(?:\[(\d+)\])?(?:\.(.+))?$/

export function parseContextPath(path: string) {
  const m = CONTEXT_RE.exec(path)
  if (!m) return null
  return { key: m[1], index: m[2] != null ? Number(m[2]) : null, rest: m[3] ?? '' }
}

/**
 * A field name typed by hand (no collection to pick from). Commits only a
 * non-empty name — an empty path is not a value the server will store — and
 * keeps the typed text while it is empty.
 */
function PathTextInput({
  rel,
  toPath,
  onChange,
  label
}: {
  rel: string
  toPath: (rel: string) => string
  onChange: (path: string) => void
  label: string
}) {
  const [text, setText] = useState(rel)
  const [seen, setSeen] = useState(rel)
  if (rel !== seen) {
    setSeen(rel)
    if (text.trim() !== rel) setText(rel)
  }
  return (
    <TextField
      mono
      value={text}
      onChange={(v) => {
        setText(v)
        const t = v.trim()
        if (t) onChange(toPath(t))
      }}
      placeholder='field_name'
      aria-label={label}
    />
  )
}

/** Record field + (inside a list) each item's field. */
export function RecordFieldSection({
  value,
  onChange,
  scope
}: {
  value: string
  onChange: (path: string) => void
  scope?: ItemScope | null
}) {
  const env = useFieldMapEnv()
  const recordRel = value.startsWith('record.') ? value.slice('record.'.length) : ''
  const prefix = scope ? `${scope.alias}.` : null
  const itemRel = prefix && value.startsWith(prefix) ? value.slice(prefix.length) : ''
  // A typed path for odd cases (a JSON column's key, a field the picker hides).
  const [typing, setTyping] = useState(false)
  const picking = !!scope?.collection && !typing
  return (
    <div className='space-y-3'>
      {scope && (
        <div>
          <div className='flex items-center justify-between gap-2'>
            <FmLabel>From each {scope.alias}</FmLabel>
            {scope.collection && (
              <button
                type='button'
                aria-pressed={typing}
                onClick={() => setTyping((t) => !t)}
                className={cn(quietButton, '-mr-1.5 -mt-1 mb-0.5')}
              >
                {typing ? (
                  <ListTree className='h-3 w-3' />
                ) : (
                  <TextCursorInput className='h-3 w-3' />
                )}
                {typing ? 'Pick a field' : 'Type a path'}
              </button>
            )}
          </div>
          {picking ? (
            <CollectionFieldPicker
              collection={scope.collection as string}
              value={itemRel}
              valueLabel={itemRel ? humanizePath(value, scope.alias, env.names) : undefined}
              onChange={(p) => onChange(itemPath(scope.alias, p.path))}
              placeholder={`Pick a field of the ${scope.alias}…`}
              walk={PAYLOAD_WALK}
            />
          ) : (
            <>
              <PathTextInput
                rel={itemRel}
                toPath={(r) => `${scope.alias}.${r}`}
                onChange={onChange}
                label={`Field of each ${scope.alias}`}
              />
              <Hint className='mt-1'>
                {itemRel
                  ? `Reads ${humanizePath(value, scope.alias, env.names)}`
                  : scope.collection
                    ? `A field of each ${scope.alias}, dots between links: cifa.task.name`
                    : `Type the name of a field each ${scope.alias} has.`}
              </Hint>
            </>
          )}
          <button
            type='button'
            aria-pressed={value === scope.alias}
            className={cn(
              smallAction,
              'mt-1.5 border border-slate-200 font-normal dark:border-border',
              value === scope.alias &&
                'border-nvr-cyan/50 bg-nvr-cyan/10 text-slate-900 hover:bg-nvr-cyan/15 dark:text-foreground'
            )}
            onClick={() => onChange(scope.alias)}
          >
            Use the {scope.alias} itself
          </button>
        </div>
      )}
      <div>
        {scope && <FmLabel>From the record</FmLabel>}
        <CollectionFieldPicker
          collection={env.collection}
          value={recordRel}
          valueLabel={recordRel ? humanizePath(value, null, env.names) : undefined}
          onChange={(p) => onChange(`record.${p.path.join('.')}`)}
          placeholder='Pick a field…'
          walk={PAYLOAD_WALK}
        />
        {!scope && (
          <Hint className='mt-1.5'>
            Fields of the {env.collection || 'record'}, including fields of related records.
          </Hint>
        )}
      </div>
    </div>
  )
}

/** A lookup from the template's data, then a field of its first row (or the whole list). */
export function RelatedSection({
  value,
  onChange,
  allowWhole
}: {
  value: string
  onChange: (path: string) => void
  /** Offer "all rows" (a list source) instead of a field of the first row. */
  allowWhole?: boolean
}) {
  const env = useFieldMapEnv()
  const parsed = parseContextPath(value)
  const [picked, setPicked] = useState<string | null>(parsed?.key ?? null)
  const key = picked ?? parsed?.key ?? null
  const lookup = env.lookups.find((l) => l.key === key)
  const sameKey = parsed?.key === key
  const rest = sameKey ? (parsed?.rest ?? '') : ''

  if (!env.lookups.length)
    return (
      <Hint>
        This payload reads no related data yet. Lookups appear here once they are on the Data tab.
      </Hint>
    )

  return (
    <div className='space-y-3'>
      <div>
        <FmLabel>Related data</FmLabel>
        <div className='flex flex-wrap gap-1'>
          {env.lookups.map((l) => (
            <button
              key={l.key}
              type='button'
              aria-pressed={key === l.key}
              onClick={() => {
                setPicked(l.key)
                if (allowWhole) onChange(`context.${l.key}`)
              }}
              className={cn(
                'inline-flex h-7 items-center gap-1.5 rounded-md border px-2 font-mono text-[12px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan',
                key === l.key
                  ? 'border-nvr-cyan bg-nvr-cyan/10 text-slate-900 dark:text-foreground'
                  : 'border-slate-200 text-slate-600 hover:border-slate-300 dark:border-border dark:text-slate-300'
              )}
            >
              <Network className='h-3 w-3 opacity-60' />
              {l.key}
            </button>
          ))}
        </div>
      </div>
      {key && !allowWhole && (
        <div>
          <FmLabel>Field of the first {key} row</FmLabel>
          {lookup?.collection ? (
            <CollectionFieldPicker
              collection={lookup.collection}
              value={rest}
              valueLabel={rest ? humanizePath(rest) : undefined}
              onChange={(p) => onChange(`context.${key}[0].${p.path.join('.')}`)}
              placeholder='Pick a field…'
              walk={PAYLOAD_WALK}
            />
          ) : (
            <PathTextInput
              rel={rest}
              toPath={(r) => `context.${key}[0].${r}`}
              onChange={onChange}
              label={`Field of the first ${key} row`}
            />
          )}
          <Hint className='mt-1.5'>
            For one entry per row, make this field a List and pick {key} as its source.
          </Hint>
        </div>
      )}
    </div>
  )
}

/** A compact path chooser for rules and list sources: label trigger → Record / Related. */
export function PathPicker({
  value,
  onChange,
  scope,
  placeholder = 'Choose a field',
  listSource,
  ariaLabel,
  className
}: {
  value: string
  onChange: (path: string) => void
  scope?: ItemScope | null
  placeholder?: string
  /** Picking a list: related lookups give their whole rows. */
  listSource?: boolean
  ariaLabel?: string
  className?: string
}) {
  const env = useFieldMapEnv()
  const [open, setOpen] = useState(false)
  const isContext = value.startsWith('context.')
  const [tab, setTab] = useState<'record' | 'related'>(
    isContext || (listSource && env.lookups.length) ? 'related' : 'record'
  )
  const label = value ? humanizePath(value, scope?.alias, env.names) : ''
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type='button'
          aria-label={ariaLabel}
          className={cn(
            'inline-flex h-7 min-w-0 max-w-full items-center gap-1 rounded-md border border-slate-200 bg-white px-2 text-left text-[12.5px] hover:border-slate-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan dark:border-border dark:bg-background',
            className
          )}
        >
          <span
            className={cn(
              'min-w-0 flex-1 truncate',
              value
                ? 'text-slate-800 dark:text-foreground'
                : 'text-slate-500 dark:text-muted-foreground'
            )}
          >
            {label || placeholder}
          </span>
          <ChevronDown className='h-3 w-3 shrink-0 text-slate-400' />
        </button>
      </PopoverTrigger>
      <FmPopoverContent className='w-[340px]'>
        <div className='flex gap-1 border-b border-slate-100 px-2 pt-2 dark:border-border'>
          {(
            [
              ['record', 'This record', Rows3],
              ['related', 'Related data', Network]
            ] as const
          ).map(([id, text, Icon]) => (
            <button
              key={id}
              type='button'
              aria-pressed={tab === id}
              onClick={() => setTab(id)}
              className={cn(
                '-mb-px inline-flex items-center gap-1.5 border-b-2 px-2 pb-1.5 text-[12px] font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-nvr-cyan',
                tab === id
                  ? 'border-nvr-cyan text-slate-900 dark:text-foreground'
                  : 'border-transparent text-slate-500 hover:text-slate-800 dark:text-muted-foreground'
              )}
            >
              <Icon className='h-3 w-3' />
              {text}
            </button>
          ))}
        </div>
        <div className='p-3'>
          {tab === 'record' ? (
            <RecordFieldSection
              value={value}
              scope={scope}
              onChange={(p) => {
                onChange(p)
              }}
            />
          ) : (
            <RelatedSection value={value} onChange={onChange} allowWhole={listSource} />
          )}
        </div>
      </FmPopoverContent>
    </Popover>
  )
}
