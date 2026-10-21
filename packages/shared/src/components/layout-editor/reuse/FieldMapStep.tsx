import { ArrowRight } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { titleCase } from '../../../lib/utils'
import { SimpleSelect } from '../../ui/SimpleSelect'
import { useOverviewFields } from '../overview/overview-api'
import { suggestFieldMap } from './field-match'
import type { FieldMap } from './reuse-api'

// The mapping step a block from another collection goes through: each field
// the target collection has no field of the same name for gets the best match
// (or "Leave out"), and the admin can change any of them.

const LEAVE_OUT = ''

/**
 * The field map for `fields` (from `sourceCollection`) landing on
 * `targetCollection`: suggested once the target's fields load, then edited.
 * `needed` lists the fields with no same-name counterpart (empty: no step).
 */
export function useFieldMapping(
  fields: string[],
  sourceCollection: string | null,
  targetCollection: string
) {
  const { data: target, isLoading } = useOverviewFields(targetCollection)
  const { data: source = [] } = useOverviewFields(sourceCollection ?? targetCollection)
  const names = useMemo(() => new Set((target ?? []).map((f) => f.field)), [target])
  const needed = useMemo(
    () => (target ? fields.filter((f) => !f.startsWith('__') && !names.has(f)) : []),
    [fields, names, target]
  )
  const sig = `${targetCollection}|${needed.join(',')}`
  const [map, setMap] = useState<FieldMap>({})
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-suggest only when the question changes
  useEffect(() => {
    if (!target) return
    const labels = new Map(source.map((f) => [f.field, f.label ?? null]))
    setMap(
      suggestFieldMap(
        needed.map((f) => ({ field: f, label: labels.get(f) ?? null })),
        target
      )
    )
  }, [sig, target])
  return { map, setMap, needed, loading: isLoading, sourceFields: source }
}

export function FieldMapStep({
  needed,
  map,
  onChange,
  targetCollection,
  sourceLabels
}: {
  needed: string[]
  map: FieldMap
  onChange: (next: FieldMap) => void
  targetCollection: string
  sourceLabels?: Map<string, string | null | undefined>
}) {
  const { data: target = [] } = useOverviewFields(targetCollection)
  const options = useMemo(
    () => [
      { value: LEAVE_OUT, label: 'Leave out' },
      ...target
        .filter((f) => !f.field.startsWith('__'))
        .map((f) => ({ value: f.field, label: `${f.label || titleCase(f.field)} · ${f.field}` }))
        .sort((a, b) => a.label.localeCompare(b.label))
    ],
    [target]
  )
  if (!needed.length) return null
  return (
    <div data-reuse-map='' className='space-y-1.5'>
      <p className='text-[12px] leading-snug text-slate-600 dark:text-muted-foreground'>
        {needed.length === 1 ? 'One field has' : `${needed.length} fields have`} no field of the
        same name here. Pick where each goes:
      </p>
      <div className='max-h-[240px] space-y-1 overflow-y-auto overscroll-contain pr-0.5'>
        {needed.map((f) => (
          <div key={f} data-reuse-map-row={f} className='flex items-center gap-1.5'>
            <span
              className='min-w-0 flex-1 truncate font-mono text-[11.5px] text-slate-700 dark:text-foreground'
              data-tip={sourceLabels?.get(f) ?? undefined}
            >
              {f}
            </span>
            <ArrowRight className='h-3 w-3 shrink-0 text-slate-400' />
            <SimpleSelect
              value={map[f] ?? LEAVE_OUT}
              onChange={(v) => onChange({ ...map, [f]: v || null })}
              ariaLabel={`Where ${f} goes`}
              className='h-7 w-[150px] shrink-0 text-[12px]'
              options={options}
            />
          </div>
        ))}
      </div>
    </div>
  )
}
