import { useQuery } from '@tanstack/react-query'
import { Lightbulb, Plus } from 'lucide-react'
import { useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import {
  IDEA_STATUSES,
  type Idea,
  IdeaStatusBadge,
  IdeaVoteButton,
  SuggestIdeaDialog
} from '@/components/ideas'
import { Button } from '@/components/ui/button'
import { SimpleSelect } from '@/components/ui/simple-select'
import { api } from '@/lib/api'

// Idea board: every open (not merged) idea, most-voted first. `?suggest=1`
// (the help menu's "Suggest a feature") opens the suggestion dialog.

export function IdeasPage() {
  const [params, setParams] = useSearchParams()
  const [status, setStatus] = useState('')
  const suggestOpen = params.get('suggest') === '1'
  const setSuggestOpen = (open: boolean) => {
    const next = new URLSearchParams(params)
    if (open) next.set('suggest', '1')
    else next.delete('suggest')
    setParams(next, { replace: true })
  }

  const { data: ideas = [], isLoading } = useQuery({
    queryKey: ['ideas', 'list', status],
    queryFn: () =>
      api
        .get<{ data: Idea[] }>('/ideas', { params: status ? { status } : {} })
        .then((r) => r.data.data)
  })

  return (
    <div className='flex flex-1 min-h-0 flex-col'>
      <header className='shrink-0 border-b border-slate-200 bg-white px-6 py-4 dark:border-border dark:bg-card'>
        <div className='flex items-center gap-2'>
          <Lightbulb className='h-4 w-4 text-nvr-cyan' />
          <h1 className='text-[15px] font-semibold text-slate-900 dark:text-foreground'>Ideas</h1>
          <div className='ml-auto flex items-center gap-2'>
            <SimpleSelect
              value={status}
              onChange={setStatus}
              options={[{ value: '', label: 'All statuses' }, ...IDEA_STATUSES]}
              ariaLabel='Filter by status'
              className='h-8 w-40 text-[12.5px]'
            />
            <Button size='sm' className='h-8' onClick={() => setSuggestOpen(true)}>
              <Plus className='mr-1 h-3.5 w-3.5' /> Suggest a feature
            </Button>
          </div>
        </div>
        <p className='mt-0.5 max-w-[72ch] text-[12.5px] text-slate-500 dark:text-muted-foreground'>
          Feature requests from everyone. Vote for the ones you want; you will be notified when
          their status changes.
        </p>
      </header>
      <div className='min-h-0 flex-1 overflow-y-auto p-6'>
        {isLoading ? null : ideas.length === 0 ? (
          <p className='text-[12.5px] text-slate-400'>
            No ideas{status ? ' with this status' : ' yet'} — suggest the first one.
          </p>
        ) : (
          <div className='space-y-2'>
            {ideas.map((idea) => (
              <div
                key={idea.id}
                className='flex items-center gap-3 rounded-md border border-slate-200 bg-white px-4 py-3 hover:border-slate-300 dark:border-border dark:bg-card'
              >
                <IdeaVoteButton idea={idea} />
                <Link to={`/ideas/${idea.id}`} className='flex min-w-0 flex-1 items-center gap-3'>
                  <div className='min-w-0 flex-1'>
                    <p className='truncate text-[13.5px] font-medium text-slate-900 dark:text-foreground'>
                      {idea.title}
                    </p>
                    {idea.description && (
                      <p className='truncate text-[12px] text-slate-500 dark:text-muted-foreground'>
                        {idea.description}
                      </p>
                    )}
                  </div>
                  <IdeaStatusBadge status={idea.status} />
                </Link>
              </div>
            ))}
          </div>
        )}
      </div>
      <SuggestIdeaDialog open={suggestOpen} onOpenChange={setSuggestOpen} />
    </div>
  )
}
