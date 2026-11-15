import { useQuery } from '@tanstack/react-query'
import { ChevronDown, Copy, RotateCcw } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { useItemNavigation, useNivaroClient } from '../../context'
import { post } from '../../lib/commands'
import { copyRulesQuery, fieldTitle, groupNeverCopied, headerCopySkip } from '../../lib/copy-rules'
import { cn } from '../../lib/utils'
import { Button } from '../ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger
} from '../ui/dialog'
import { Label } from '../ui/label'
import { Switch } from '../ui/switch'
import { FieldRenderer } from './FieldRenderer'
import type { CMSField, CMSRelation } from './types'

const SKIP_FIELDS = new Set(['id', 'created_at', 'updated_at', 'created_by', 'updated_by'])

function isCloneable(f: CMSField, relations: CMSRelation[], collection: string) {
  if (SKIP_FIELDS.has(f.field)) return false
  // A related record's value (`unit.name`) is not this record's field.
  if (f.field.includes('.')) return false
  if (f.computed_formula) return false
  const iface = f.interface ?? ''
  if (['sub_rows', 'repeater', 'rich_text', 'file', 'image', 'o2m', 'm2m', 'm2a'].includes(iface))
    return false
  if (['sub_rows', 'repeater', 'rich_text'].includes(f.type)) return false
  const isO2M = relations.some((r) => r.one_collection === collection && r.one_field === f.field)
  if (isO2M) return false
  return true
}

function isSubRowField(f: CMSField) {
  return f.interface === 'sub_rows' || f.type === 'sub_rows'
}

/** A field's label as the form shows it. */
function labelOf(f: CMSField): string {
  return f.label?.trim() || fieldTitle(f.field)
}

interface FieldState {
  include: boolean
  value: unknown
}

interface CloneDialogProps {
  collection: string
  itemId: string
  /** The record's fields in the order the form shows them. */
  fields: CMSField[]
  relations: CMSRelation[]
  currentValues: Record<string, unknown>
  onSuccess: (newId: string | number) => void
}

export function CloneDialog({
  collection,
  itemId,
  fields,
  relations,
  currentValues,
  onSuccess
}: CloneDialogProps) {
  const client = useNivaroClient()
  const itemNav = useItemNavigation()
  const [open, setOpen] = useState(false)
  const [cloning, setCloning] = useState(false)
  const [showNever, setShowNever] = useState(false)
  const [fieldStates, setFieldStates] = useState<Record<string, FieldState>>({})
  const [subRowIncludes, setSubRowIncludes] = useState<Record<string, boolean>>({})

  // The one copy rule (api services/copy-rules.ts): the pipeline's state field,
  // read-only / hidden / partner fields and the collection's never-copy list are
  // not offered — the server leaves them out of the copy either way.
  const rules = useQuery({ ...copyRulesQuery(client, collection), enabled: open })
  const neverCopy = headerCopySkip(rules.data)
  const neverGroups = groupNeverCopied(rules.data, fields)
  const neverCount = neverGroups.reduce((n, g) => n + g.fields.length, 0)
  // Until the rule is known the list would offer fields that never copy.
  const rulesPending = open && rules.isPending
  const cloneableFields = fields.filter(
    (f) => isCloneable(f, relations, collection) && !neverCopy.has(f.field)
  )
  const subRowFields = fields.filter(isSubRowField)

  function openFresh() {
    const init: Record<string, FieldState> = {}
    for (const f of fields) {
      init[f.field] = { include: true, value: currentValues[f.field] ?? null }
    }
    setFieldStates(init)
    const srInit: Record<string, boolean> = {}
    for (const f of subRowFields) srInit[f.field] = true
    setSubRowIncludes(srInit)
    setShowNever(false)
    setOpen(true)
  }

  function isDirty(field: string, state: FieldState): boolean {
    return JSON.stringify(state.value) !== JSON.stringify(currentValues[field] ?? null)
  }

  async function handleClone() {
    setCloning(true)
    try {
      const field_overrides: Record<string, unknown> = {}
      const exclude_fields: string[] = []
      for (const f of cloneableFields) {
        const state = fieldStates[f.field]
        if (!state) continue
        if (!state.include) {
          exclude_fields.push(f.field)
          continue
        }
        if (isDirty(f.field, state)) field_overrides[f.field] = state.value
      }
      const include_sub_rows = subRowFields
        .filter((f) => subRowIncludes[f.field])
        .map((f) => f.field)
      const res = await client.request<{
        data: { id: string | number; not_copied?: Array<{ field: string; reason: string }> }
      }>(
        post(`/items/${collection}/${itemId}/clone`, {
          field_overrides,
          exclude_fields,
          include_sub_rows
        })
      )
      setOpen(false)
      const newId = res?.data?.id
      if (newId == null) {
        // Cloned, but the copy came back without an id: say so, never crash.
        toast.success('Item cloned — open it from the list')
        return
      }
      // Linked lists (Zone, sub types…) copy too; one the person may not set,
      // or a link refused, stays behind and is named here.
      const byName = new Map(fields.map((f) => [f.field, f]))
      const left = (res?.data?.not_copied ?? []).map((n) => {
        const f = byName.get(n.field)
        return f ? labelOf(f) : fieldTitle(n.field)
      })
      if (left.length)
        toast.warning(`Item cloned — not copied: ${left.join(', ')}`, {
          description: 'You may not set these on a new record. Opening the copy.'
        })
      else toast.success('Item cloned — opening the copy')
      onSuccess(newId)
      // Open the COPY. Hosts only navigate from a new-record form, so the person
      // used to stay on the original (still at its workflow step) and read it as
      // the copy (Rob 2026-11-14: "cloning an active workflow keeps its state").
      itemNav.open({ collection, itemId: String(newId) })
    } catch {
      toast.error('Failed to clone item')
    } finally {
      setCloning(false)
    }
  }

  const setValue = (field: string, value: unknown) =>
    setFieldStates((s) => ({ ...s, [field]: { ...s[field], value } }))

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (v) openFresh()
        else setOpen(false)
      }}
    >
      <DialogTrigger asChild>
        <Button size='sm' variant='outline' className='gap-1.5'>
          <Copy className='h-3.5 w-3.5' />
          Clone
        </Button>
      </DialogTrigger>
      <DialogContent className='flex max-h-[85vh] max-w-xl flex-col overflow-hidden'>
        <DialogHeader className='shrink-0 space-y-1.5 px-6 pt-6'>
          <DialogTitle className='text-[15px]'>Clone item</DialogTitle>
          <DialogDescription className='text-[12.5px] leading-relaxed' data-clone-intro>
            The copy starts at the first step with its own history.
            {!rulesPending && neverCount > 0 && (
              <>
                {' '}
                {neverCount === 1 ? '1 field is' : `${neverCount} fields are`} never copied.{' '}
                <button
                  type='button'
                  aria-expanded={showNever}
                  onClick={() => setShowNever((v) => !v)}
                  className='inline-flex items-center gap-0.5 font-medium text-nvr-cyan hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/60 rounded'
                  data-clone-never-toggle
                >
                  {showNever ? 'Hide' : 'Show which'}
                  <ChevronDown
                    className={cn('h-3 w-3 transition-transform', showNever && 'rotate-180')}
                  />
                </button>
              </>
            )}
          </DialogDescription>
          {showNever && !rulesPending && (
            <dl
              className='mt-1 space-y-1 rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-[12px] dark:border-border dark:bg-muted/40'
              data-clone-never-list
            >
              {neverGroups.map((g) => (
                <div key={g.label} className='flex gap-2'>
                  <dt className='w-36 shrink-0 text-slate-500 dark:text-muted-foreground'>
                    {g.label}
                  </dt>
                  <dd className='min-w-0 text-slate-700 dark:text-foreground'>
                    {g.fields.map((f) => f.label).join(', ')}
                  </dd>
                </div>
              ))}
            </dl>
          )}
        </DialogHeader>
        <div className='min-h-0 flex-1 overflow-y-auto px-6 py-4'>
          <div className='space-y-4'>
            {rulesPending && (
              <p
                className='text-[12px] text-slate-500 dark:text-muted-foreground'
                data-clone-rules-pending
              >
                Checking which fields a copy keeps…
              </p>
            )}
            {!rulesPending && cloneableFields.length > 0 && (
              <div>
                <p className='mb-2 text-[11px] font-medium uppercase tracking-wide text-slate-500 dark:text-muted-foreground'>
                  Values the copy starts with
                </p>
                <div className='space-y-2.5'>
                  {cloneableFields.map((f) => {
                    const state = fieldStates[f.field]
                    if (!state) return null
                    const dirty = isDirty(f.field, state)
                    return (
                      <div
                        key={f.field}
                        className='flex items-start gap-2'
                        data-clone-field={f.field}
                      >
                        <Switch
                          checked={state.include}
                          aria-label={`Copy ${labelOf(f)}`}
                          onCheckedChange={() =>
                            setFieldStates((s) => ({
                              ...s,
                              [f.field]: { ...s[f.field], include: !s[f.field].include }
                            }))
                          }
                          className='mt-2 shrink-0 scale-75'
                        />
                        <Label
                          className={cn(
                            'mt-2.5 w-36 shrink-0 truncate text-[12px]',
                            !state.include && 'text-slate-400 line-through'
                          )}
                        >
                          {labelOf(f)}
                        </Label>
                        <div
                          className={cn(
                            'min-w-0 flex-1',
                            !state.include && 'pointer-events-none opacity-40'
                          )}
                        >
                          {/* The form's own control: pickers show labels, dates the
                              form's date input, choices their text. */}
                          <FieldRenderer
                            field={f}
                            value={state.value}
                            onChange={(v) => setValue(f.field, v)}
                            relations={relations}
                            collection={collection}
                            itemId='new'
                          />
                        </div>
                        {dirty && state.include && (
                          <button
                            type='button'
                            data-tip='Back to the original value'
                            aria-label={`Reset ${labelOf(f)}`}
                            onClick={() => setValue(f.field, currentValues[f.field] ?? null)}
                            className='mt-2.5 shrink-0 text-slate-400 hover:text-slate-600 dark:hover:text-foreground'
                          >
                            <RotateCcw className='h-3.5 w-3.5' />
                          </button>
                        )}
                      </div>
                    )
                  })}
                </div>
              </div>
            )}
            {subRowFields.length > 0 && (
              <div>
                <p className='mb-2 text-[11px] font-medium uppercase tracking-wide text-slate-500 dark:text-muted-foreground'>
                  Sub-rows
                </p>
                <div className='space-y-2'>
                  {subRowFields.map((f) => (
                    <div key={f.field} className='flex items-center gap-2'>
                      <Switch
                        checked={!!subRowIncludes[f.field]}
                        onCheckedChange={(v) => setSubRowIncludes((s) => ({ ...s, [f.field]: v }))}
                        className='shrink-0 scale-75'
                      />
                      <Label className='text-[12px]'>Include {labelOf(f)} rows</Label>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
        <DialogFooter className='shrink-0 border-t border-slate-100 px-6 py-4 dark:border-border'>
          <Button variant='outline' size='sm' onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button size='sm' disabled={cloning || rulesPending} onClick={handleClone}>
            <Copy className='mr-1.5 h-3.5 w-3.5' />
            {cloning ? 'Cloning…' : 'Clone'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
