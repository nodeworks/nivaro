import type { DraftBody, Problem, TemplateDetail } from './api'

// STUB — Task 12 replaces this file: map templates → editable spec JSON
// (validateSpec errors inline) + one-way Convert to Liquid; code templates →
// mono Liquid editor. Props are the contract the editor shell passes.

export interface CodeTabProps {
  template: TemplateDetail
  draft: DraftBody
  onChange: (next: DraftBody) => void
  problems: Problem[]
}

export function CodeTab({ draft }: CodeTabProps) {
  const text = draft.mode === 'code' ? draft.body : JSON.stringify(draft.body, null, 2)
  return (
    <div className='px-5 py-4' data-payload-code-stub>
      <p className='mb-2 text-[12px] text-slate-500 dark:text-muted-foreground'>
        {draft.mode === 'code'
          ? 'Liquid that renders this body (read-only until Task 12).'
          : 'The field map as stored JSON (read-only until Task 12).'}
      </p>
      <pre className='overflow-x-auto rounded-md border border-slate-200 bg-slate-50 p-3 font-mono text-[12px] leading-relaxed text-slate-700 dark:border-border dark:bg-background dark:text-slate-300'>
        {text}
      </pre>
    </div>
  )
}
