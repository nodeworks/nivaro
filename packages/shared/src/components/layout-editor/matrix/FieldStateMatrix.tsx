import { type ReactNode, useMemo, useState } from 'react'
import { toast } from 'sonner'
import {
  HEADER_GROUP_KEY,
  type LayoutBundle,
  type LayoutOp,
  type PlacementRow
} from '../../../lib/layout-ops'
import { userErrorMessage } from '../../../lib/safe-error'
import { cn } from '../../../lib/utils'
import { Skeleton } from '../../ui/skeleton'
import type { DesignTarget, SelectOptions } from '../design-context'
import { fieldZones, isFieldRow, keyOf, targetOfKey, zoneItems } from '../field-zones'
import { resetPlacementOps } from '../inheritance'
import { useCollectionMeta } from '../inspector/field-context'
import { describeField, overridePlacementOps } from '../inspector/model'
import { LoadError } from '../load-error'
import { useCollectionPipelines } from '../preview/preview-api'
import type { ApplyOptions } from '../useLayoutDraft'
import {
  type CellTone,
  type Choice,
  InheritChip,
  MatrixCellButton,
  MatrixMenu,
  matrixCellTd,
  matrixCorner,
  matrixRowHead,
  matrixTh,
  matrixZoneTd,
  useCellMenu
} from './MatrixGrid'
import { useSaveRequirements } from './matrix-api'
import {
  CELL_KINDS,
  type CellKind,
  cellChange,
  everyStateOps,
  everyStateValue,
  type MatrixState,
  type MatrixTransition,
  movesFrom,
  stateCell
} from './state-matrix'

// Field × state matrix (#2644): a row per field, a column per pipeline state
// (plus Every state), each cell normal / read-only / required / hidden. Rules
// and storage: state-matrix.ts. Layout changes go through the draft (one undo
// step per cell); requirement changes are saved to the pipeline at once.

export interface FieldStateMatrixProps {
  bundle: LayoutBundle
  parent: LayoutBundle | null
  collection: string
  apply: (ops: LayoutOp[], opts?: ApplyOptions) => void
  onSelect: (t: DesignTarget, opts?: SelectOptions) => void
}

type Source = 'own' | 'override' | 'inherited'
interface MatrixRow {
  row: PlacementRow
  source: Source
}
interface Zone {
  key: string
  label: string
  rows: MatrixRow[]
}

const WORD: Record<CellKind, string> = {
  normal: 'Editable',
  readonly: 'Read-only',
  required: 'Required',
  hidden: 'Hidden'
}
const TONE: Record<CellKind, CellTone> = {
  normal: 'normal',
  readonly: 'readonly',
  required: 'required',
  hidden: 'hidden'
}
const EVERY = '*'
const rowId = (p: PlacementRow) => `${p.field}\u0001${p.group_key ?? ''}`

/** Fields in page order, by zone; the header strip first; the parent's last. */
export function matrixZones(bundle: LayoutBundle, parent: LayoutBundle | null): Zone[] {
  const parentFields = new Set(parent?.placements.map((p) => p.field) ?? [])
  const mark = (row: PlacementRow): MatrixRow => ({
    row,
    source: parentFields.has(row.field) ? 'override' : 'own'
  })
  const out: Zone[] = []
  const header = bundle.placements
    .filter((p) => p.group_key === HEADER_GROUP_KEY && isFieldRow(p))
    .sort((a, b) => a.sort - b.sort)
  if (header.length)
    out.push({ key: HEADER_GROUP_KEY, label: 'Header strip', rows: header.map(mark) })
  for (const z of fieldZones(bundle)) {
    const rows = zoneItems(bundle, z.key).filter(isFieldRow)
    if (rows.length) out.push({ key: z.key ?? '', label: z.label, rows: rows.map(mark) })
  }
  if (parent) {
    const childFields = new Set(bundle.placements.map((p) => p.field))
    const seen = new Set<string>()
    const inherited = parent.placements.filter((p) => {
      if (!isFieldRow(p) || childFields.has(p.field) || seen.has(p.field)) return false
      seen.add(p.field)
      return true
    })
    if (inherited.length)
      out.push({
        key: '\u0002parent',
        label: `From ${String(parent.layout.name ?? 'the parent layout')}`,
        rows: inherited.map((row) => ({ row, source: 'inherited' }))
      })
  }
  return out
}

export function FieldStateMatrix({
  bundle,
  parent,
  collection,
  apply,
  onSelect
}: FieldStateMatrixProps) {
  const { data: meta } = useCollectionMeta(collection)
  const {
    data: pipelines = [],
    isLoading,
    isError,
    refetch
  } = useCollectionPipelines(collection, true)
  const [pipelineId, setPipelineId] = useState<string | null>(null)
  const pipeline = pipelines.find((p) => p.id === pipelineId) ?? pipelines[0] ?? null
  const states: MatrixState[] = pipeline?.states ?? []
  const transitions = (pipeline?.transitions ?? []) as MatrixTransition[]
  const saveRequirements = useSaveRequirements(collection)
  const menu = useCellMenu()
  const zones = useMemo(() => matrixZones(bundle, parent), [bundle, parent])
  const parentName = String(parent?.layout.name ?? 'the parent layout')

  const nameOf = (row: PlacementRow) =>
    describeField(row.field, meta?.fields ?? [], meta?.relations ?? [], row).label

  // The open cell: "<row id>|<state key or *>".
  const open = useMemo(() => {
    if (!menu.open) return null
    const at = menu.open.lastIndexOf('|')
    const id = menu.open.slice(0, at)
    const col = menu.open.slice(at + 1)
    for (const z of zones)
      for (const r of z.rows)
        if (rowId(r.row) === id && r.source !== 'inherited')
          return { row: r.row, state: col === EVERY ? null : states.find((s) => s.key === col) }
    return null
  }, [menu.open, zones, states])

  const choices: Choice<CellKind>[] = !open
    ? []
    : open.state == null
      ? CELL_KINDS.map((k) => ({
          value: k,
          label: WORD[k],
          tone: TONE[k],
          effect:
            k === 'normal'
              ? 'No rule of its own on this form'
              : k === 'readonly'
                ? 'Read-only on this form, in every state'
                : k === 'required'
                  ? 'The form will not save without a value'
                  : 'Not shown on this form',
          blocked: null
        }))
      : (() => {
          const state = open.state
          const cell = stateCell(open.row, state, transitions)
          const moves = movesFrom(transitions, state)
          const movesWord =
            moves.length === 1 ? `"${moves[0]?.label}"` : `the ${moves.length} moves out`
          return CELL_KINDS.map((k) => {
            const o = cell.options[k]
            return {
              value: k,
              label: WORD[k],
              tone: TONE[k],
              effect:
                k === 'normal'
                  ? `Editable in ${state.label}`
                  : k === 'readonly'
                    ? `Locked while the record is in ${state.label}`
                    : k === 'required'
                      ? everyStateValue(open.row) === 'required'
                        ? 'Required on every state'
                        : `${movesWord} will ask for it — saved to the ${pipeline?.name ?? ''} pipeline at once, for every form`
                      : '',
              blocked: o.ok ? null : o.why
            }
          })
        })()
  const current: CellKind | null = !open
    ? null
    : open.state == null
      ? everyStateValue(open.row)
      : stateCell(open.row, open.state, transitions).value

  const pick = async (to: CellKind) => {
    if (!open) return
    const name = nameOf(open.row)
    if (open.state == null) {
      const ops = everyStateOps(open.row, to)
      if (ops.length) apply(ops, { label: `${name}: ${WORD[to].toLowerCase()} on every state` })
      return
    }
    if (!pipeline) return
    const state = open.state
    const change = cellChange(open.row, state, pipeline.id, transitions, to)
    if (!change) return
    if (change.ops.length)
      apply(change.ops, { label: `${name}: ${WORD[to].toLowerCase()} in ${state.label}` })
    if (change.requirements.length === 0) return
    try {
      await saveRequirements(change.requirements)
      const moves = change.requirements.map((c) => `"${c.label}"`).join(', ')
      toast.success(
        to === 'required'
          ? `${moves} now ${change.requirements.length === 1 ? 'asks' : 'ask'} for ${name}`
          : `${moves} no longer ${change.requirements.length === 1 ? 'asks' : 'ask'} for ${name}`,
        {
          description: `Saved to the ${pipeline.name} pipeline`,
          action: {
            label: 'Undo',
            onClick: () =>
              void saveRequirements(change.requirements, 'before').catch((e) =>
                toast.error(errorText(e))
              )
          }
        }
      )
    } catch (e) {
      toast.error(`The pipeline was not changed: ${errorText(e)}`)
    }
  }

  const fieldCount = zones.reduce((n, z) => n + z.rows.length, 0)

  return (
    <div data-field-state-matrix='' className='flex min-h-full flex-col gap-2 p-4'>
      <div className='flex flex-wrap items-center gap-2'>
        <p className='m-0 min-w-0 flex-1 text-[12px] text-slate-500 dark:text-muted-foreground'>
          {fieldCount} {fieldCount === 1 ? 'field' : 'fields'} by workflow state. Read-only uses the
          field's Read-only when; Required asks for the value before the record leaves the state.
        </p>
        {pipelines.length > 1 && (
          <fieldset
            aria-label='Pipeline'
            className='m-0 inline-flex h-8 items-center gap-0.5 rounded-md border-0 bg-slate-100 p-0.5 dark:bg-muted'
          >
            {pipelines.map((p) => (
              <button
                key={p.id}
                type='button'
                aria-pressed={p.id === pipeline?.id}
                onClick={() => setPipelineId(p.id)}
                className={cn(
                  'inline-flex h-7 items-center rounded px-2 text-[12px] font-medium transition-colors',
                  p.id === pipeline?.id
                    ? 'bg-white text-slate-900 shadow-sm dark:bg-background dark:text-foreground'
                    : 'text-slate-500 hover:text-slate-800 dark:text-muted-foreground dark:hover:text-foreground'
                )}
              >
                {p.name}
              </button>
            ))}
          </fieldset>
        )}
      </div>
      {isError ? (
        <LoadError what='the workflow states' onRetry={() => void refetch()} />
      ) : (
        !isLoading &&
        !pipeline && (
          <p
            role='note'
            className='m-0 rounded-md bg-slate-100 px-3 py-2 text-[12px] text-slate-600 dark:bg-muted dark:text-muted-foreground'
          >
            No pipeline runs on this collection, so only Every state applies.
          </p>
        )
      )}
      {isLoading ? (
        <Skeleton className='h-48 w-full rounded-lg' />
      ) : (
        <MatrixMenu
          menu={menu}
          title={
            open ? `${nameOf(open.row)} · ${open.state ? open.state.label : 'Every state'}` : ''
          }
          choices={choices}
          current={current}
          onPick={(k) => void pick(k)}
        >
          <div className='min-h-0 flex-1 overflow-auto rounded-lg border border-slate-200 bg-white dark:border-border dark:bg-card'>
            <table className='border-separate border-spacing-0 text-[12.5px]'>
              <thead>
                <tr>
                  <th className={matrixCorner}>Field</th>
                  <th
                    className={cn(matrixTh, 'text-center')}
                    data-tip='The field on this form, whatever the state'
                  >
                    Every state
                  </th>
                  {states.map((s) => (
                    <th
                      key={s.key}
                      className={cn(matrixTh, 'text-center')}
                      data-matrix-state={s.key}
                    >
                      <span className='inline-flex items-center gap-1.5'>
                        <span
                          aria-hidden
                          className='h-2 w-2 shrink-0 rounded-full bg-slate-300 dark:bg-slate-600'
                          style={s.color ? { backgroundColor: s.color } : undefined}
                        />
                        {s.label}
                      </span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {zones.map((z) => (
                  <ZoneRows
                    key={z.key}
                    zone={z}
                    colSpan={states.length + 1}
                    render={(r) => {
                      const name = nameOf(r.row)
                      const id = rowId(r.row)
                      const locked =
                        r.source === 'inherited'
                          ? `From ${parentName} — override it to change it here`
                          : null
                      const every = everyStateValue(r.row)
                      return (
                        <tr key={id} data-matrix-row={r.row.field}>
                          <th scope='row' className={matrixRowHead}>
                            <button
                              type='button'
                              onClick={(e) =>
                                onSelect(targetOfKey(keyOf(r.row)), {
                                  additive: e.shiftKey || e.metaKey || e.ctrlKey
                                })
                              }
                              data-tip='Select it on the form'
                              className='block max-w-full truncate text-left font-medium text-slate-800 hover:underline dark:text-foreground'
                            >
                              {name}
                            </button>
                            {r.source !== 'own' && parent && (
                              <InheritChip
                                kind={r.source === 'inherited' ? 'inherited' : 'override'}
                                parentName={parentName}
                                action={r.source === 'inherited' ? 'override' : 'reset'}
                                actionLabel={
                                  r.source === 'inherited'
                                    ? `Override ${name} on this form`
                                    : `Reset ${name} to ${parentName}`
                                }
                                actionTip={
                                  r.source === 'inherited'
                                    ? 'Copy it onto this form to change it here'
                                    : `Take ${parentName}'s placement of it again`
                                }
                                onAction={() =>
                                  r.source === 'inherited'
                                    ? apply(overridePlacementOps(bundle, parent, r.row), {
                                        label: `Override ${name} on this form`
                                      })
                                    : apply(resetPlacementOps(bundle, r.row.field), {
                                        label: `Reset ${name} to ${parentName}`
                                      })
                                }
                              />
                            )}
                          </th>
                          <td className={matrixCellTd}>
                            <MatrixCellButton
                              cellKey={`${id}|${EVERY}`}
                              tone={TONE[every]}
                              word={WORD[every]}
                              tip={
                                every === 'normal'
                                  ? 'No rule of its own'
                                  : `${WORD[every]} on every state`
                              }
                              locked={locked}
                              label={`${name}, every state: ${WORD[every]}`}
                              menu={menu}
                            />
                          </td>
                          {states.map((s) => {
                            const cell = stateCell(r.row, s, transitions)
                            return (
                              <td key={s.key} className={matrixCellTd}>
                                <MatrixCellButton
                                  cellKey={`${id}|${s.key}`}
                                  tone={TONE[cell.value]}
                                  word={WORD[cell.value]}
                                  tip={cell.conflict ?? cell.because}
                                  conflict={cell.conflict}
                                  locked={locked}
                                  label={`${name} in ${s.label}: ${WORD[cell.value]}`}
                                  menu={menu}
                                />
                              </td>
                            )
                          })}
                        </tr>
                      )
                    }}
                  />
                ))}
                {zones.length === 0 && (
                  <tr>
                    <td
                      colSpan={states.length + 2}
                      className='px-3 py-6 text-center text-[12.5px] text-slate-500 dark:text-muted-foreground'
                    >
                      No fields on this form yet.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </MatrixMenu>
      )}
    </div>
  )
}

function ZoneRows({
  zone,
  colSpan,
  render
}: {
  zone: Zone
  colSpan: number
  render: (r: MatrixRow) => ReactNode
}) {
  return (
    <>
      <tr data-matrix-zone={zone.key}>
        <td className={matrixZoneTd}>{zone.label}</td>
        <td
          colSpan={colSpan}
          className='border-b border-slate-200 bg-slate-100 dark:border-border dark:bg-muted'
        />
      </tr>
      {zone.rows.map(render)}
    </>
  )
}

function errorText(e: unknown): string {
  const body = (e as { response?: { data?: { error?: unknown } } })?.response?.data?.error
  if (typeof body === 'string') return body
  return userErrorMessage(e, 'Something went wrong')
}
