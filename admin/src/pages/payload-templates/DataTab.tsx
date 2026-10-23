import { ArrowRight, Code2 } from 'lucide-react'
import { Link } from 'react-router'
import type { TemplateDetail } from './api'
import { describeLookups, findErpAction, type LookupLine } from './lookups'
import { usePipeline } from './panel-api'
import { Bars, InlineError } from './panel-parts'

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
        {transitions.length > 1
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

/**
 * Data tab: what a field path can read — the record, the lookups (from the
 * pipeline action that sends the payload, read-only here, plus the
 * template's own) and the built-ins; for code-built pushes, who provides the
 * data.
 */
export function DataTab({ template }: DataTabProps) {
  const own = describeLookups(template.lookups)
  const codeSenders = template.used_by.filter((u) => u.kind === 'code')
  const hasTransitions = template.used_by.some((u) => u.kind === 'transition')
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
            ? `Set by ${template.owner} when it registers this payload. A pipeline action’s lookup with the same name wins.`
            : 'Lookups every sender of this payload gets. A pipeline action’s lookup with the same name wins.'}
        </p>
        <LookupList
          lines={own}
          empty={
            hasTransitions ? 'None — the pipeline action above supplies the extra data.' : 'None.'
          }
        />
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
