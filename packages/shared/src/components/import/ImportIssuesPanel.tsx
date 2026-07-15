import type { ImportParseResponse } from '@nivaro/sdk'
import { AlertCircle, AlertTriangle } from 'lucide-react'
import { cn } from '../../lib/utils'
import { Button } from '../ui/button'

type ImportIssue = ImportParseResponse['issues'][number]

function issuePrefix(issue: ImportIssue): string | null {
  if (issue.row != null && issue.column) return `Row ${issue.row} · ${issue.column}`
  if (issue.row != null) return `Row ${issue.row}`
  if (issue.column) return issue.column
  return null
}

export function ImportIssuesPanel({
  issues,
  onDismiss
}: {
  issues: ImportIssue[]
  onDismiss?: () => void
}) {
  if (issues.length === 0) return null
  const hasError = issues.some((i) => i.severity === 'error')

  return (
    <div
      className={cn(
        'rounded-lg border p-3',
        hasError
          ? 'border-red-200 bg-red-50 dark:border-red-500/30 dark:bg-red-500/10'
          : 'border-amber-200 bg-amber-50 dark:border-amber-500/30 dark:bg-amber-500/10'
      )}
    >
      <div className='mb-2 flex items-center justify-between gap-2'>
        <p
          className={cn(
            'text-[11px] font-semibold uppercase tracking-wide',
            hasError ? 'text-red-700 dark:text-red-400' : 'text-amber-700 dark:text-amber-400'
          )}
        >
          {hasError ? 'Import errors' : 'Import warnings'}
        </p>
        {!hasError && onDismiss && (
          <Button
            type='button'
            variant='ghost'
            size='sm'
            className='h-6 px-2 text-[11px]'
            onClick={onDismiss}
          >
            Dismiss
          </Button>
        )}
      </div>
      <ul className='space-y-1.5'>
        {issues.map((issue, i) => {
          const prefix = issuePrefix(issue)
          const key = `${issue.rule}-${issue.row ?? ''}-${issue.column ?? ''}-${i}`
          return (
            <li key={key} className='flex items-start gap-2 text-[12px]'>
              {issue.severity === 'error' ? (
                <AlertCircle className='mt-0.5 h-3.5 w-3.5 shrink-0 text-red-500' />
              ) : (
                <AlertTriangle className='mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-500' />
              )}
              <span
                className={
                  hasError ? 'text-red-700 dark:text-red-300' : 'text-amber-700 dark:text-amber-300'
                }
              >
                {prefix && <span className='font-medium'>{prefix} · </span>}
                {issue.message}
              </span>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
