import { useQuery } from '@tanstack/react-query'
import { ChevronRight, GitFork, Workflow } from 'lucide-react'
import { Link } from 'react-router'
import { api } from '@/lib/api'

interface WorkflowTemplate {
  id: string
  name: string
  description?: string | null
  is_active?: boolean
}

export function WorkflowsPage() {
  const { data: templates = [], isLoading } = useQuery<WorkflowTemplate[]>({
    queryKey: ['pipeline-templates'],
    queryFn: () => api.get<{ data: WorkflowTemplate[] }>('/pipelines').then((r) => r.data.data)
  })

  return (
    <div className='flex flex-1 min-h-0 flex-col'>
      <header className='shrink-0 border-b border-slate-200 bg-white px-6 py-4 dark:border-border dark:bg-card'>
        <h1 className='text-[18px] font-semibold text-slate-900 dark:text-foreground'>Workflows</h1>
        <p className='mt-0.5 text-[13px] text-slate-500'>
          Workflow templates share the pipeline engine. Configure parallel branches here, or open
          the full editor for states, transitions, and bindings.
        </p>
      </header>

      <div className='flex-1 overflow-y-auto bg-slate-50 p-6 dark:bg-background'>
        {isLoading ? (
          <div className='space-y-2'>
            {[0, 1, 2].map((i) => (
              <div
                key={i}
                className='h-14 animate-pulse rounded-lg bg-slate-200/60 dark:bg-muted'
              />
            ))}
          </div>
        ) : templates.length === 0 ? (
          <div className='flex flex-col items-center justify-center py-24 text-center'>
            <Workflow className='h-10 w-10 text-slate-300' />
            <p className='mt-3 text-[14px] font-medium text-slate-600 dark:text-foreground'>
              No workflow templates yet
            </p>
            <p className='mt-1 max-w-sm text-[13px] text-slate-400'>
              Create a template on the{' '}
              <Link to='/pipelines' className='text-nvr-cyan hover:underline'>
                Pipelines
              </Link>{' '}
              page — workflows and pipelines share the same state machine engine.
            </p>
          </div>
        ) : (
          <div className='overflow-hidden rounded-lg border border-slate-200 bg-white dark:border-border dark:bg-card'>
            {templates.map((t, i) => (
              <div
                key={t.id}
                className={
                  i > 0
                    ? 'border-t border-slate-100 dark:border-border flex items-center gap-4 px-4 py-3'
                    : 'flex items-center gap-4 px-4 py-3'
                }
              >
                <Workflow className='h-4 w-4 shrink-0 text-nvr-cyan' />
                <div className='min-w-0 flex-1'>
                  <p className='truncate text-[13px] font-medium text-slate-900 dark:text-foreground'>
                    {t.name}
                  </p>
                  {t.description ? (
                    <p className='truncate text-[12px] text-slate-400'>{t.description}</p>
                  ) : null}
                </div>
                <Link
                  to={`/workflows/${t.id}`}
                  className='flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[12px] font-medium text-slate-600 transition-colors hover:bg-nvr-cyan/10 hover:text-nvr-cyan dark:text-muted-foreground'
                >
                  <GitFork className='h-3.5 w-3.5' />
                  Parallel branches
                </Link>
                <Link
                  to={`/pipelines/${t.id}`}
                  className='flex items-center gap-1 rounded-md px-2.5 py-1.5 text-[12px] font-medium text-slate-600 transition-colors hover:bg-nvr-cyan/10 hover:text-nvr-cyan dark:text-muted-foreground'
                >
                  Full editor
                  <ChevronRight className='h-3.5 w-3.5' />
                </Link>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
