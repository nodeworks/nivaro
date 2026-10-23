import type { TemplateDetail } from './api'

// STUB — Task 12 replaces this file: the lookups the template can read (the
// referencing action's context read-only with "edit in pipeline", plus the
// template's own lookups, editable), or the registrar's documented variables
// for code-built templates. Props are the contract the editor shell passes.

export interface DataTabProps {
  template: TemplateDetail
}

export function DataTab({ template }: DataTabProps) {
  const lookups = template.lookups
  const empty =
    lookups == null || (typeof lookups === 'object' && Object.keys(lookups as object).length === 0)
  return (
    <div className='px-5 py-4' data-payload-data-stub>
      <p className='mb-2 text-[12px] text-slate-500 dark:text-muted-foreground'>
        Extra data this payload reads besides the {template.collection} record (read-only until Task
        12).
      </p>
      {empty ? (
        <p className='text-[12.5px] text-slate-500 dark:text-muted-foreground'>
          No template lookups.
        </p>
      ) : (
        <pre className='overflow-x-auto rounded-md border border-slate-200 bg-slate-50 p-3 font-mono text-[12px] leading-relaxed text-slate-700 dark:border-border dark:bg-background dark:text-slate-300'>
          {JSON.stringify(lookups, null, 2)}
        </pre>
      )}
    </div>
  )
}
