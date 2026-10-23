import { Lock } from 'lucide-react'
import type { Field, MapSpec, Problem } from '../api'

// STUB — Task 11 replaces this file with the field map editor (rows that read
// as a sentence, value popover, transforms, dnd reorder, undo/redo). The props
// below are the contract the editor shell (PayloadTemplateEditor) passes.

export interface FieldMapProps {
  spec: MapSpec
  onChange: (spec: MapSpec) => void
  /** Server-computed value per field id for the preview record (lists: the first item). */
  values: Record<string, unknown>
  problems: Problem[]
  lockedKeys: string[]
  /** Body-secret names on the template's external API. */
  secretNames: string[]
  collection: string
}

function show(v: unknown): string {
  if (v === undefined) return ''
  if (typeof v === 'string') return v
  try {
    return JSON.stringify(v)
  } catch {
    return String(v)
  }
}

function Rows({ fields, depth, props }: { fields: Field[]; depth: number; props: FieldMapProps }) {
  return (
    <>
      {fields.map((f) => {
        const locked = f.locked || (depth === 0 && props.lockedKeys.includes(f.key))
        const rowProblems = props.problems.filter((p) => p.field_id === f.id)
        return (
          <li key={f.id}>
            <div
              className='flex items-center gap-2 py-1.5 text-[12.5px]'
              style={{ paddingLeft: depth * 20 }}
            >
              <span className='font-mono text-slate-900 dark:text-foreground'>{f.key || '—'}</span>
              {locked && <Lock className='h-3 w-3 text-slate-400' aria-label='Locked key' />}
              <span className='text-[11.5px] text-slate-400'>{f.type}</span>
              <span className='min-w-0 flex-1 truncate text-right font-mono text-[11.5px] text-slate-500 dark:text-slate-400'>
                {show(props.values[f.id])}
              </span>
            </div>
            {rowProblems.map((p) => (
              <p
                key={p.message}
                className='pb-1 text-[11.5px] text-red-600 dark:text-red-400'
                style={{ paddingLeft: depth * 20 }}
              >
                {p.message}
              </p>
            ))}
            {f.children?.length ? (
              <ul>
                <Rows fields={f.children} depth={depth + 1} props={props} />
              </ul>
            ) : null}
          </li>
        )
      })}
    </>
  )
}

export function FieldMap(props: FieldMapProps) {
  return (
    <div className='px-5 py-4' data-payload-field-map-stub>
      <p className='mb-3 text-[12px] text-slate-500 dark:text-muted-foreground'>
        Read-only outline — the field map editor arrives with Task 11.
      </p>
      {props.spec.fields.length === 0 ? (
        <p className='text-[12.5px] text-slate-500 dark:text-muted-foreground'>No fields yet.</p>
      ) : (
        <ul className='divide-y divide-slate-100 dark:divide-border'>
          <Rows fields={props.spec.fields} depth={0} props={props} />
        </ul>
      )}
    </div>
  )
}
