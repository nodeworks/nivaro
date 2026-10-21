import { Layers } from 'lucide-react'
import { useState } from 'react'
import { cn, formatNumber } from '../../../lib/utils'
import { Popover, PopoverContent } from '../../ui/popover'
import { effectText, labelText, tintCard } from '../panel-style'
import { PickList, type PickOption, Segmented } from '../settings/controls'
import { ToolButton } from '../toolbar-kit'
import { BulkRun } from './BulkRun'
import type { BulkAction, BulkChange, BulkFlag } from './bulk-api'
import { useFieldLabels } from './field-labels'
import { MacrosPanel } from './MacrosPanel'
import type { MacroRecorder } from './useMacroRecorder'

// "Every form" (#2639 / #2662 / #2663): changes made to all layouts of the
// collection at once — retire a field, one change everywhere, recorded
// macros. An anchored popover beside its button, in the editor's top bar and
// on the Layouts overview.

type Tab = 'retire' | 'change' | 'macros'

export interface BulkChangesButtonProps {
  collection: string
  /** In the editor: the layout open now (its unsaved changes keep it out of a bulk change). */
  layoutId?: number | null
  dirty?: boolean
  /** In the editor: Record / Stop for macros. */
  recorder?: MacroRecorder
}

export function BulkChangesButton({
  collection,
  layoutId,
  dirty,
  recorder
}: BulkChangesButtonProps) {
  const [open, setOpen] = useState(false)
  const [tab, setTab] = useState<Tab>('retire')
  const recording = !!recorder?.recording
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <ToolButton
        popover
        onOpen={() => setOpen(true)}
        label='Every form'
        icon={<Layers className='h-3.5 w-3.5' />}
        tip='Retire a field, make one change on every form, or replay a recorded macro'
        hint={
          recording
            ? `Recording a macro: ${recorder?.steps.length ?? 0} steps`
            : 'Retire a field, one change everywhere, macros'
        }
        dot={recording}
        data={{ 'data-bulk-button': '' }}
        trailing={
          recording && (
            <span
              data-recording=''
              className='ml-0.5 inline-flex items-center gap-1 rounded-full bg-rose-50 px-1.5 text-[11px] font-semibold text-rose-700 dark:bg-rose-500/15 dark:text-rose-300'
            >
              <span className='h-1.5 w-1.5 animate-pulse rounded-full bg-rose-500' />
              {recorder?.steps.length ?? 0}
            </span>
          )
        }
      />
      <PopoverContent
        align='end'
        data-bulk-panel=''
        className='max-h-[min(78vh,680px)] w-[460px] max-w-[calc(100vw-24px)] overflow-y-auto overscroll-contain p-0'
      >
        {open && (
          <div className='space-y-3 p-4'>
            <div>
              <h3 className='text-[14px] font-semibold text-slate-900 dark:text-foreground'>
                Every form of this collection
              </h3>
              <p className={effectText}>
                Previewed form by form first. Each form saves its own version, so History can put
                any one back.
              </p>
            </div>
            <Segmented<Tab>
              ariaLabel='What to do'
              value={tab}
              onChange={setTab}
              options={[
                { value: 'retire', label: 'Retire a field' },
                { value: 'change', label: 'One change' },
                { value: 'macros', label: recording ? 'Macros · recording' : 'Macros' }
              ]}
            />
            {tab === 'retire' && (
              <RetireTab collection={collection} layoutId={layoutId} dirty={dirty} />
            )}
            {tab === 'change' && (
              <ChangeTab collection={collection} layoutId={layoutId} dirty={dirty} />
            )}
            {tab === 'macros' && (
              <MacrosPanel
                collection={collection}
                layoutId={layoutId ?? null}
                dirty={dirty}
                recorder={recorder}
                onRecordStart={() => setOpen(false)}
              />
            )}
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}

function RetireTab({
  collection,
  layoutId,
  dirty
}: {
  collection: string
  layoutId?: number | null
  dirty?: boolean
}) {
  const { labels, onForms } = useFieldLabels(collection)
  const [field, setField] = useState<string | null>(null)
  const action: BulkAction | null = field ? { kind: 'retire', field } : null
  return (
    <div data-bulk-tab='retire' className='space-y-3'>
      <p className={effectText}>
        Takes a field off every form at once: its placements, header, summaries, quick picker and
        defaults. The values stay in the database.
      </p>
      <div className='space-y-1'>
        <span className={labelText}>Field</span>
        <PickList
          ariaLabel='Field to retire'
          value={field}
          options={onForms}
          onChange={setField}
          placeholder='Pick a field on the forms…'
          emptyText='No fields are placed on these forms'
          className='w-full'
        />
      </div>
      <BulkRun
        collection={collection}
        action={action}
        labels={labels}
        dirtyLayoutId={dirty ? layoutId : null}
        applyLabel={(n) => `Retire from ${n} form${n === 1 ? '' : 's'}`}
        extra={(p) =>
          p.values ? (
            <div data-bulk-values='' className={cn(tintCard, 'p-2.5 text-[12.5px]')}>
              {p.values.populated != null && p.values.total != null ? (
                <span className='text-slate-800 dark:text-foreground'>
                  <strong>{formatNumber(p.values.populated)}</strong> of{' '}
                  {formatNumber(p.values.total)} records still hold a value. Retiring keeps them;
                  nobody sees or edits them on a form any more.
                </span>
              ) : (
                <span className={effectText}>{p.values.note}</span>
              )}
            </div>
          ) : null
        }
      />
    </div>
  )
}

type ChangeKind =
  | 'place_after'
  | 'place_before'
  | 'set_width'
  | 'required'
  | 'readonly'
  | 'hidden'
  | 'remove'

const CHANGE_KINDS: PickOption[] = [
  { value: 'place_after', label: 'Place it after another field' },
  { value: 'place_before', label: 'Place it before another field' },
  { value: 'set_width', label: 'Set its width' },
  { value: 'required', label: 'Required or optional' },
  { value: 'readonly', label: 'Read-only or editable' },
  { value: 'hidden', label: 'Hidden or shown' },
  { value: 'remove', label: 'Remove it from the forms' }
]

const WIDTHS = [
  { value: '12', label: 'Full' },
  { value: '6', label: '½' },
  { value: '4', label: '⅓' },
  { value: '3', label: '¼' }
]

function ChangeTab({
  collection,
  layoutId,
  dirty
}: {
  collection: string
  layoutId?: number | null
  dirty?: boolean
}) {
  const { labels, all, onForms } = useFieldLabels(collection)
  const [kind, setKind] = useState<ChangeKind>('place_after')
  const [field, setField] = useState<string | null>(null)
  const [anchor, setAnchor] = useState<string | null>(null)
  const [width, setWidth] = useState('6')
  const [on, setOn] = useState<'on' | 'off'>('on')
  const placing = kind === 'place_after' || kind === 'place_before'
  const isFlag = kind === 'required' || kind === 'readonly' || kind === 'hidden'

  const change: BulkChange | null = !field
    ? null
    : placing
      ? anchor && anchor !== field
        ? { type: kind, field, anchor }
        : null
      : kind === 'set_width'
        ? { type: 'set_width', field, width: Number(width) }
        : isFlag
          ? { type: 'set_flag', field, flag: kind as BulkFlag, on: on === 'on' }
          : { type: 'remove', field }
  const action: BulkAction | null = change ? { kind: 'change', change } : null
  const flagWords: Record<string, [string, string]> = {
    required: ['Required', 'Optional'],
    readonly: ['Read-only', 'Editable'],
    hidden: ['Hidden', 'Shown']
  }

  return (
    <div data-bulk-tab='change' className='space-y-3'>
      <div className='space-y-1'>
        <span className={labelText}>Change</span>
        <PickList
          ariaLabel='Change'
          value={kind}
          options={CHANGE_KINDS}
          onChange={(v) => v && setKind(v as ChangeKind)}
          className='w-full'
        />
      </div>
      <div className='space-y-1'>
        <span className={labelText}>Field</span>
        <PickList
          ariaLabel='Field'
          value={field}
          // Placing may add a field no form holds yet; the rest need it on a form.
          options={placing ? all : onForms}
          onChange={setField}
          placeholder='Pick a field…'
          className='w-full'
        />
      </div>
      {placing && (
        <div className='space-y-1'>
          <span className={labelText}>{kind === 'place_after' ? 'After' : 'Before'}</span>
          <PickList
            ariaLabel='Next to field'
            value={anchor}
            options={onForms.filter((o) => o.value !== field)}
            onChange={setAnchor}
            placeholder='Pick the field it goes next to…'
            className='w-full'
          />
          <p className={effectText}>Forms without this field are skipped and listed.</p>
        </div>
      )}
      {kind === 'set_width' && (
        <Segmented ariaLabel='Width' value={width} onChange={setWidth} options={WIDTHS} />
      )}
      {isFlag && (
        <Segmented<'on' | 'off'>
          ariaLabel='Set to'
          value={on}
          onChange={setOn}
          options={[
            { value: 'on', label: flagWords[kind][0] },
            { value: 'off', label: flagWords[kind][1] }
          ]}
        />
      )}
      <BulkRun
        collection={collection}
        action={action}
        labels={labels}
        dirtyLayoutId={dirty ? layoutId : null}
        applyLabel={(n) => `Apply to ${n} form${n === 1 ? '' : 's'}`}
      />
    </div>
  )
}
