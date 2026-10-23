import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  ChevronRight,
  Copy,
  GripVertical,
  Lock,
  MoreHorizontal,
  Plus,
  StickyNote,
  Trash2
} from 'lucide-react'
import { createContext, type HTMLAttributes, type Ref, useContext, useState } from 'react'
import { Popover, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import type { Field, ListSpec, Problem, ValueSpec } from '../api'
import { GroupHeader } from './GroupHeader'
import { IncludeControl } from './IncludeControl'
import { showValue, TYPE_HINTS, TYPE_LABELS } from './labels'
import { RulesPopover } from './RulesPopover'
import type { RowMeta } from './row-store'
import { type AddFieldArgs, type FieldType, KEY_ISSUES } from './spec-ops'
import { FmPopoverContent, type ItemScope, OptionMenu, quietButton, useFieldMapEnv } from './ui'
import { ValueChip } from './ValuePopover'

// One row of the field map, read left to right as a sentence:
// handle · key · type · value · when it is sent · rules · value for the
// preview record · ⋯. Problems for the row sit in red right under it.

export interface RowActions {
  rename: (id: string, key: string) => void
  setType: (id: string, type: FieldType) => void
  setValue: (id: string, v: ValueSpec | undefined) => void
  setInclude: (id: string, inc: Field['include']) => void
  setRules: (id: string, r: Field['rules']) => void
  setNote: (id: string, note: string | undefined) => void
  patchList: (id: string, patch: Partial<ListSpec>) => void
  /** Renames a list's rows; false = `to` is unsafe, only `item` changed (rewrite later from `from`). */
  renameAlias: (id: string, from: string, to: string) => boolean
  /** Adds a row and focuses its key. Returns the new id. */
  add: (args: AddFieldArgs) => string
  remove: (id: string) => void
  duplicate: (id: string) => void
  move: (id: string, delta: -1 | 1) => void
  toggle: (id: string) => void
  /** The key input of a just-added row lost focus — its empty key now counts. */
  settle: (id: string) => void
}

export interface FieldMapLayout {
  narrow: boolean
  /** The preview for the current draft is still on its way. */
  valuesPending: boolean
}

export const FieldMapLayoutContext = createContext<FieldMapLayout>({
  narrow: false,
  valuesPending: false
})

/** Indent per depth level; the key column shrinks by the same amount so values line up. */
export const INDENT = 20

const TYPE_OPTIONS = (Object.keys(TYPE_LABELS) as FieldType[]).map((t) => ({
  value: t,
  label: TYPE_LABELS[t],
  hint: TYPE_HINTS[t]
}))

export interface HandleProps {
  ref: Ref<HTMLButtonElement>
  attributes: HTMLAttributes<HTMLButtonElement>
  listeners: Record<string, unknown> | undefined
}

function InlineValue({ meta, field, pending }: { meta: RowMeta; field: Field; pending: boolean }) {
  if (!meta.hasValue) {
    if (pending)
      return (
        <span
          className='ml-auto block h-3 w-14 animate-pulse rounded bg-[hsl(var(--nvr-skeleton))]'
          aria-hidden
        />
      )
    return (
      <span
        className='block truncate text-right text-slate-300 dark:text-slate-600'
        data-tip='Not in the payload for this record'
      >
        —
      </span>
    )
  }
  if (field.type === 'object') return null
  const v = meta.value
  const text = showValue(v)
  const full = text.length > 500 ? `${text.slice(0, 500)}…` : text
  return (
    <span
      className={cn(
        'block truncate text-right font-mono text-[12px]',
        v === null || v === ''
          ? 'italic text-slate-400 dark:text-slate-500'
          : 'text-slate-600 dark:text-slate-300'
      )}
      data-tip={text.length > 24 ? full : undefined}
    >
      {v === '' ? 'empty' : text}
    </span>
  )
}

function RowMenu({
  field,
  locked,
  isGroup,
  hasNote,
  actions,
  onEditNote,
  partner
}: {
  field: Field
  locked: boolean
  isGroup: boolean
  hasNote: boolean
  actions: RowActions
  onEditNote: () => void
  partner: string
}) {
  const [open, setOpen] = useState(false)
  const run = (fn: () => void) => () => {
    setOpen(false)
    fn()
  }
  const item =
    'flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[12.5px] text-slate-700 hover:bg-muted focus-visible:bg-accent focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-40 dark:text-slate-200'
  const kbd = 'ml-auto font-mono text-[11px] text-slate-400'
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type='button'
          aria-label={`More for ${field.key || 'this field'}`}
          className={cn(
            'inline-flex h-6 w-6 shrink-0 items-center justify-center rounded text-slate-400 hover:bg-slate-100 hover:text-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan dark:hover:bg-muted dark:hover:text-foreground',
            open
              ? 'visible bg-slate-100 dark:bg-muted'
              : 'invisible group-focus-within/row:visible group-hover/row:visible'
          )}
        >
          <MoreHorizontal className='h-4 w-4' />
        </button>
      </PopoverTrigger>
      <FmPopoverContent
        className='w-[236px] p-1'
        align='end'
        onKeyDown={(e) => {
          if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
          e.preventDefault()
          const items = [
            ...e.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')
          ]
          const i = items.indexOf(document.activeElement as HTMLButtonElement)
          const next = items[(i + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]
          next?.focus()
        }}
      >
        <div role='menu' aria-label='Field actions'>
          <button
            type='button'
            role='menuitem'
            className={item}
            onClick={run(() => actions.add({ after: field.id }))}
          >
            <Plus className='h-3.5 w-3.5 text-slate-400' />
            Add a field below
          </button>
          {isGroup && (
            <button
              type='button'
              role='menuitem'
              className={item}
              onClick={run(() => actions.add({ parent: field.id }))}
            >
              <Plus className='h-3.5 w-3.5 text-slate-400' />
              Add a field inside
            </button>
          )}
          <button
            type='button'
            role='menuitem'
            className={item}
            onClick={run(() => actions.duplicate(field.id))}
          >
            <Copy className='h-3.5 w-3.5 text-slate-400' />
            Duplicate
            <span className={kbd}>⌘D</span>
          </button>
          <button
            type='button'
            role='menuitem'
            className={item}
            onClick={run(() => actions.move(field.id, -1))}
          >
            <ArrowUp className='h-3.5 w-3.5 text-slate-400' />
            Move up
            <span className={kbd}>⌥↑</span>
          </button>
          <button
            type='button'
            role='menuitem'
            className={item}
            onClick={run(() => actions.move(field.id, 1))}
          >
            <ArrowDown className='h-3.5 w-3.5 text-slate-400' />
            Move down
            <span className={kbd}>⌥↓</span>
          </button>
          <button type='button' role='menuitem' className={item} onClick={run(onEditNote)}>
            <StickyNote className='h-3.5 w-3.5 text-slate-400' />
            {hasNote ? 'Edit the note' : 'Add a note'}
          </button>
          <div className='my-1 h-px bg-slate-100 dark:bg-border' />
          <span
            className='block'
            data-tip={
              locked
                ? `Nivaro reads this back to confirm ${partner} got it. It can't be removed.`
                : undefined
            }
          >
            <button
              type='button'
              role='menuitem'
              disabled={locked}
              className={cn(
                item,
                !locked && 'text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-500/10'
              )}
              onClick={run(() => actions.remove(field.id))}
            >
              <Trash2 className='h-3.5 w-3.5' />
              Remove{isGroup ? ' with its fields' : ''}
              <span className={kbd}>⌫</span>
            </button>
          </span>
        </div>
      </FmPopoverContent>
    </Popover>
  )
}

export interface FieldRowProps {
  field: Field
  depth: number
  meta: RowMeta
  /** Scope the row's own value reads from (the nearest list around it). */
  scope: ItemScope | null
  /** For a list row: what its children read. */
  itemCollection?: string
  isScalarChild: boolean
  actions: RowActions
  handle: HandleProps | null
  dragging?: boolean
}

export function FieldRow({
  field,
  depth,
  meta,
  scope,
  itemCollection,
  isScalarChild,
  actions,
  handle,
  dragging
}: FieldRowProps) {
  const env = useFieldMapEnv()
  const { narrow, valuesPending } = useContext(FieldMapLayoutContext)
  const [editingNote, setEditingNote] = useState(false)
  const isGroup = field.type === 'object' || field.type === 'list'
  const lockedSelf = meta.lock === 'self'
  const locked = meta.lock != null
  const lockTip = `Nivaro reads this back to confirm ${env.partner} got it. It can't be renamed or removed.`
  const insideTip = `A field in here is read back by Nivaro to confirm ${env.partner} got it, so this can't be renamed, retyped or removed.`
  // A just-added row's empty key is not an error until the person leaves it.
  const issues = meta.fresh ? meta.issues.filter((m) => m.code !== 'empty_key') : meta.issues
  const keyBad = issues.some((m) => KEY_ISSUES.has(m.code))
  const keyWidth = Math.max(96, (narrow ? 152 : 184) - depth * INDENT)
  const pad = 4 + depth * INDENT

  const controls = (
    <>
      <IncludeControl
        include={field.include}
        scope={scope}
        onChange={(inc) => actions.setInclude(field.id, inc)}
        className={cn(
          'max-w-[150px] shrink-0',
          field.include === 'always' &&
            !narrow &&
            'invisible group-focus-within/row:visible group-hover/row:visible'
        )}
      />
      {!isGroup || field.type === 'list' ? (
        <RulesPopover
          rules={field.rules}
          type={field.type}
          onChange={(r) => actions.setRules(field.id, r)}
          className={cn(
            'max-w-[150px] shrink-0',
            !field.rules &&
              !narrow &&
              'invisible group-focus-within/row:visible group-hover/row:visible'
          )}
        />
      ) : null}
    </>
  )

  const valueCell = isGroup ? (
    <GroupHeader
      field={field}
      outerScope={scope}
      itemCollection={itemCollection}
      collapsed={meta.collapsed}
      onPatchList={actions.patchList}
      onRenameAlias={actions.renameAlias}
    />
  ) : (
    <ValueChip
      value={field.value}
      type={field.type}
      scope={scope}
      onChange={(v) => actions.setValue(field.id, v)}
      emptyText={isScalarChild ? `The ${scope?.alias ?? 'row'} itself` : undefined}
    />
  )

  return (
    <div className={cn(dragging && 'opacity-60')}>
      <div
        data-row-id={field.id}
        tabIndex={-1}
        className={cn(
          'group/row relative flex min-h-9 items-center gap-1.5 rounded-md pr-1.5 outline-none hover:bg-slate-50 focus-visible:ring-1 focus-visible:ring-nvr-cyan/70 focus-within:bg-slate-50 dark:hover:bg-muted/40 dark:focus-within:bg-muted/40',
          narrow && 'flex-wrap py-1'
        )}
        style={{ paddingLeft: pad }}
      >
        {/* depth guides */}
        {depth > 0 &&
          Array.from({ length: depth }, (_, i) => (
            <span
              // biome-ignore lint/suspicious/noArrayIndexKey: static guides
              key={i}
              aria-hidden
              className='absolute bottom-0 top-0 w-px bg-slate-200 dark:bg-border'
              style={{ left: 12 + i * INDENT }}
            />
          ))}
        <button
          type='button'
          ref={handle?.ref}
          {...(handle?.attributes ?? {})}
          {...((handle?.listeners ?? {}) as HTMLAttributes<HTMLButtonElement>)}
          aria-label={`Drag ${field.key || 'field'} — Space to pick up, arrows to move`}
          className='invisible inline-flex h-6 w-4 shrink-0 cursor-grab items-center justify-center rounded text-slate-400 hover:text-slate-600 focus-visible:visible focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan active:cursor-grabbing group-focus-within/row:visible group-hover/row:visible'
        >
          <GripVertical className='h-3.5 w-3.5' />
        </button>
        {isGroup ? (
          <button
            type='button'
            onClick={() => actions.toggle(field.id)}
            aria-expanded={!meta.collapsed}
            aria-label={meta.collapsed ? 'Unfold' : 'Fold'}
            className='inline-flex h-5 w-4 shrink-0 items-center justify-center rounded text-slate-400 hover:text-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan dark:hover:text-foreground'
          >
            {meta.collapsed ? (
              <ChevronRight className='h-3.5 w-3.5' />
            ) : (
              <ChevronDown className='h-3.5 w-3.5' />
            )}
          </button>
        ) : (
          <span className='w-4 shrink-0' aria-hidden />
        )}
        <span className='relative flex shrink-0 items-center' style={{ width: keyWidth }}>
          {isScalarChild ? (
            <span className='px-1.5 text-[12.5px] text-slate-500 dark:text-muted-foreground'>
              Each value
            </span>
          ) : (
            <input
              data-key-input=''
              value={field.key}
              readOnly={locked}
              aria-readonly={locked}
              aria-label='Key'
              aria-invalid={keyBad}
              spellCheck={false}
              autoComplete='off'
              placeholder='key'
              onChange={(e) => actions.rename(field.id, e.target.value)}
              onBlur={() => meta.fresh && actions.settle(field.id)}
              data-tip={lockedSelf ? lockTip : meta.lock === 'inside' ? insideTip : undefined}
              className={cn(
                'h-7 w-full min-w-0 rounded border bg-transparent px-1.5 font-mono text-[12.5px] text-slate-900 placeholder:text-slate-300 focus:bg-white focus:outline-none dark:text-foreground dark:placeholder:text-slate-600 dark:focus:bg-background',
                locked ? 'cursor-default pr-6' : 'hover:border-slate-200 dark:hover:border-border',
                keyBad
                  ? 'border-red-300 focus:border-red-500 dark:border-red-500/50'
                  : 'border-transparent focus:border-nvr-cyan',
                isGroup && 'font-semibold'
              )}
            />
          )}
          {lockedSelf && (
            <Lock
              className='pointer-events-none absolute right-1.5 h-3 w-3 text-slate-400'
              aria-label='Locked key'
            />
          )}
        </span>
        <OptionMenu
          value={field.type}
          options={TYPE_OPTIONS}
          onSelect={(t) => actions.setType(field.id, t)}
          disabled={locked}
          tip={
            locked
              ? lockedSelf
                ? 'Nivaro reads this back — its type stays'
                : insideTip
              : undefined
          }
          ariaLabel={`Type: ${TYPE_LABELS[field.type]}`}
          width='w-[260px]'
          triggerClassName={cn(quietButton, 'w-[74px] shrink-0 justify-between')}
        >
          <span className='truncate'>{TYPE_LABELS[field.type]}</span>
          {!locked && <ChevronDown className='h-3 w-3 shrink-0 opacity-60' />}
        </OptionMenu>
        <span
          className={cn('flex min-w-0 items-center', narrow ? 'min-w-[120px] flex-1' : 'flex-1')}
        >
          {valueCell}
        </span>
        {!narrow && controls}
        {!narrow && (
          <span className='w-[22%] min-w-[64px] max-w-[240px] shrink-0 pl-1'>
            <InlineValue meta={meta} field={field} pending={valuesPending} />
          </span>
        )}
        <RowMenu
          field={field}
          locked={locked}
          isGroup={isGroup}
          hasNote={!!field.note}
          actions={actions}
          onEditNote={() => setEditingNote(true)}
          partner={env.partner}
        />
        {narrow && (
          <div
            className='flex w-full min-w-0 items-center gap-1.5'
            style={{ paddingLeft: 4 + 16 + 4 + 16 + 6 }}
          >
            {controls}
            <span className='ml-auto min-w-0 max-w-[50%] flex-1'>
              <InlineValue meta={meta} field={field} pending={valuesPending} />
            </span>
          </div>
        )}
      </div>
      {(field.note || editingNote) && (
        <div className='pb-1' style={{ paddingLeft: pad + 42 }}>
          {editingNote ? (
            <input
              // biome-ignore lint/a11y/noAutofocus: opened from the menu to type the note
              autoFocus
              value={field.note ?? ''}
              onChange={(e) => actions.setNote(field.id, e.target.value || undefined)}
              onBlur={() => setEditingNote(false)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === 'Escape') {
                  e.preventDefault()
                  setEditingNote(false)
                }
              }}
              placeholder='A note for whoever edits this next'
              aria-label='Note'
              className='h-6 w-full max-w-[520px] rounded border border-slate-200 bg-white px-1.5 text-[11.5px] text-slate-600 focus:border-nvr-cyan focus:outline-none dark:border-border dark:bg-background dark:text-slate-300'
            />
          ) : (
            <button
              type='button'
              onClick={() => setEditingNote(true)}
              className='text-left text-[11.5px] text-slate-500 hover:text-slate-800 dark:text-muted-foreground dark:hover:text-foreground'
            >
              {field.note}
            </button>
          )}
        </div>
      )}
      {(issues.length > 0 || meta.problems.length > 0) && (
        <ul className='space-y-0.5 pb-1.5' style={{ paddingLeft: pad + 42 }} aria-live='polite'>
          {issues.map((m) => (
            <li
              key={`i:${m.code}:${m.message}`}
              data-issue={m.code}
              className='text-[11.5px] leading-snug text-red-600 dark:text-red-400'
            >
              {m.message}
            </li>
          ))}
          {meta.problems.map((p: Problem, i) => (
            <li
              // biome-ignore lint/suspicious/noArrayIndexKey: problems may repeat a message
              key={`p:${i}`}
              className={cn(
                'text-[11.5px] leading-snug',
                p.severity === 'warning'
                  ? 'text-amber-700 dark:text-amber-300'
                  : 'text-red-600 dark:text-red-400'
              )}
            >
              {p.message}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
