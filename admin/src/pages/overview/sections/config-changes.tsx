import {
  ActivityEntry,
  type ActivityEntryInput,
  UndoButton,
  useActivityLabels
} from '@nivaro/shared'
import { useQuery } from '@tanstack/react-query'
import { useNavigate } from 'react-router'
import { Skeleton } from '@/components/ui/skeleton'
import { api } from '@/lib/api'
import { ActionLink, Section, SectionEmpty, SectionError, type SectionProps, Surface } from './kit'

/**
 * #18 Recent config changes (administrators) — the last five changes to authored configuration
 * (roles, policies, fields, layouts, flows, pipelines…; services/config-inventory CONFIG_TABLES)
 * in plain words through the shared activity sentence renderer, labels read as the viewer.
 * Undo shows only where the existing activity undo path accepts the entry (UndoButton asks the
 * server and hides itself otherwise); every line can be opened.
 */

export function useConfigChanges() {
  return useQuery({
    queryKey: ['overview', 'config-changes'],
    queryFn: () =>
      api
        .get<{ data: { items: ActivityEntryInput[] } }>('/overview/config-changes')
        .then((r) => r.data.data.items),
    staleTime: 30_000
  })
}

export function ConfigChangesSection({ hideTitle }: SectionProps = {}) {
  const navigate = useNavigate()
  const { data, isLoading, isError, error, refetch } = useConfigChanges()
  const entries = data ?? []
  const labels = useActivityLabels(entries, { enabled: entries.length > 0 })

  return (
    <Section
      id='config-changes'
      title='Recent config changes'
      hideTitle={hideTitle}
      more={{ label: 'All activity', to: '/activity' }}
    >
      {isLoading ? (
        <Surface className='divide-y divide-slate-100 dark:divide-border'>
          {[0, 1, 2, 3, 4].map((i) => (
            <div key={i} className='flex items-center gap-2.5 px-3 py-2.5'>
              <Skeleton className='h-6 w-6 rounded-full' />
              <Skeleton className='h-3.5 w-64 max-w-[70%]' />
              <Skeleton className='ml-auto h-3 w-12' />
            </div>
          ))}
        </Surface>
      ) : isError ? (
        <SectionError error={error} what='recent config changes' onRetry={() => void refetch()} />
      ) : entries.length === 0 ? (
        <SectionEmpty next={{ label: 'Restore points', to: '/environments/config' }}>
          No configuration changed in the last 30 days.
        </SectionEmpty>
      ) : (
        <Surface>
          <ul className='divide-y divide-slate-100 px-1 dark:divide-border'>
            {entries.map((e) => (
              <li key={String(e.id)} data-config-change={String(e.id)}>
                <ActivityEntry
                  entry={e}
                  labels={labels}
                  onOpen={(x) => x.id != null && navigate(`/activity/${x.id}`)}
                  actions={
                    e.id != null ? (
                      <>
                        <UndoButton activityId={e.id} onDone={() => void refetch()} />
                        <ActionLink to={`/activity/${e.id}`}>Open</ActionLink>
                      </>
                    ) : null
                  }
                />
              </li>
            ))}
          </ul>
        </Surface>
      )}
    </Section>
  )
}
