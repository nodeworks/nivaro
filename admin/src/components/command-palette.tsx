import { useQuery } from '@tanstack/react-query'
import { ArrowRight, CornerDownLeft, FileText, Plus, Search } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator
} from '@/components/ui/command'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { api } from '@/lib/api'
import { titleCase } from '@/lib/utils'

// ─── Static page registry (mirrors AppLayout nav structure) ──────────────────

const PAGES: { label: string; path: string; keywords?: string }[] = [
  { label: 'Overview', path: '/', keywords: 'home dashboard' },
  { label: 'Dashboards', path: '/dashboards', keywords: 'kpi widgets' },
  { label: 'Collections', path: '/collections', keywords: 'content data items' },
  { label: 'Data Model', path: '/data-model', keywords: 'schema fields tables' },
  { label: 'Files', path: '/files', keywords: 'uploads media' },
  { label: 'Hierarchies', path: '/hierarchies', keywords: 'tree levels' },
  { label: 'Record Templates', path: '/record-templates' },
  { label: 'Collection Presets', path: '/collection-presets' },
  { label: 'Users', path: '/users', keywords: 'people accounts' },
  { label: 'Roles', path: '/roles', keywords: 'permissions policies rbac' },
  { label: 'Workspaces', path: '/workspaces' },
  { label: 'Pipelines', path: '/pipelines', keywords: 'owner matrix' },
  { label: 'Flows', path: '/flows', keywords: 'automation inngest' },
  { label: 'Workflows', path: '/workflows', keywords: 'state machine' },
  { label: 'Webhooks', path: '/webhooks' },
  { label: 'Rules', path: '/rules', keywords: 'automation conditions' },
  { label: 'Blackout Dates', path: '/blackout-dates' },
  { label: 'Scheduled Changes', path: '/scheduled-changes' },
  { label: 'Virtual Collections', path: '/virtual-collections' },
  { label: 'External APIs', path: '/external-apis', keywords: 'integrations' },
  { label: 'GraphQL Explorer', path: '/graphql', keywords: 'graphiql' },
  { label: 'Custom Queries', path: '/custom-queries', keywords: 'sql' },
  { label: 'Extensions', path: '/extensions', keywords: 'plugins' },
  { label: 'Analytics', path: '/analytics' },
  { label: 'Presence', path: '/presence' },
  { label: 'Docs', path: '/docs', keywords: 'documentation reference' },
  { label: 'API Docs', path: '/api-docs', keywords: 'rest reference' },
  { label: 'Settings', path: '/settings', keywords: 'configuration ai key' },
  { label: 'Activity', path: '/activity', keywords: 'audit log' },
  { label: 'Reports', path: '/reports', keywords: 'audit' },
  { label: 'Alerts', path: '/alerts', keywords: 'thresholds' },
  { label: 'SLA Rules', path: '/sla-rules' },
  { label: 'Field Watches', path: '/field-watches', keywords: 'changelog' },
  { label: 'Subscriptions', path: '/notification-subscriptions', keywords: 'notifications' },
  { label: 'Imports', path: '/imports', keywords: 'csv upload' },
  { label: 'Submission Forms', path: '/submission-forms', keywords: 'public forms' },
  { label: 'Schema Snapshot', path: '/schema-snapshot' },
  { label: 'Profile', path: '/profile', keywords: 'account token' }
]

interface SearchRecord {
  collection: string
  id: string | number
  label: string
  snippet: string
}

interface GlobalSearchResponse {
  records: SearchRecord[]
  pages: { label: string; path: string }[]
  actions: { label: string; path: string }[]
}

function matchesQuery(p: { label: string; path: string; keywords?: string }, q: string) {
  const lower = q.toLowerCase()
  return (
    p.label.toLowerCase().includes(lower) ||
    (p.keywords ?? '').toLowerCase().includes(lower) ||
    p.path.toLowerCase().includes(lower)
  )
}

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className='inline-flex h-5 min-w-5 items-center justify-center rounded border border-border bg-muted px-1 font-mono text-[10px] text-muted-foreground'>
      {children}
    </kbd>
  )
}

// ─── Component ────────────────────────────────────────────────────────────────

export function CommandPalette() {
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [debouncedQuery, setDebouncedQuery] = useState('')

  // ⌘K / Ctrl+K + custom focus-search event
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setOpen((o) => !o)
      }
    }
    const onFocusSearch = () => setOpen(true)
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('nivaro:focus-search', onFocusSearch)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('nivaro:focus-search', onFocusSearch)
    }
  }, [])

  // Debounce live record search (250ms)
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(query.trim()), 250)
    return () => clearTimeout(t)
  }, [query])

  // Reset query when closing
  useEffect(() => {
    if (!open) {
      setQuery('')
      setDebouncedQuery('')
    }
  }, [open])

  const { data: searchData, isFetching } = useQuery({
    queryKey: ['global-search', debouncedQuery],
    queryFn: () =>
      api
        .get<{ data: GlobalSearchResponse }>('/global-search', {
          params: { q: debouncedQuery }
        })
        .then((r) => r.data.data),
    enabled: open && debouncedQuery.length >= 2,
    staleTime: 15_000
  })

  const { data: collections } = useQuery({
    queryKey: ['command-palette-collections'],
    queryFn: () =>
      api
        .get<{ data: { collection: string; display_name?: string | null }[] }>('/collections')
        .then((r) => r.data.data),
    enabled: open,
    staleTime: 60_000
  })

  const q = query.trim()
  const pageMatches = q ? PAGES.filter((p) => matchesQuery(p, q)).slice(0, 8) : PAGES.slice(0, 8)
  const records = debouncedQuery.length >= 2 ? (searchData?.records ?? []) : []
  const serverActions = debouncedQuery.length >= 2 ? (searchData?.actions ?? []) : []

  const newItemActions = q
    ? (collections ?? [])
        .filter(
          (c) =>
            !c.collection.toLowerCase().startsWith('nivaro_') &&
            (c.collection.toLowerCase().includes(q.toLowerCase()) ||
              (c.display_name ?? '').toLowerCase().includes(q.toLowerCase()))
        )
        .slice(0, 5)
    : []

  function go(path: string) {
    setOpen(false)
    navigate(path)
  }

  const hasResults =
    pageMatches.length > 0 ||
    records.length > 0 ||
    newItemActions.length > 0 ||
    serverActions.length > 0

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className='overflow-hidden p-0 shadow-lg sm:max-w-[560px]'>
        <Command
          shouldFilter={false}
          className='[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-muted-foreground [&_[cmdk-group]:not([hidden])_~[cmdk-group]]:pt-0 [&_[cmdk-group]]:px-2 [&_[cmdk-input-wrapper]_svg]:h-4 [&_[cmdk-input-wrapper]_svg]:w-4 [&_[cmdk-input]]:h-11 [&_[cmdk-item]]:px-2 [&_[cmdk-item]]:py-2'
        >
          <CommandInput
            placeholder='Search pages, records, actions…'
            value={query}
            onValueChange={setQuery}
          />
          <CommandList className='max-h-[380px]'>
            {!hasResults && (
              <CommandEmpty>{isFetching ? 'Searching…' : 'No results found.'}</CommandEmpty>
            )}

            {pageMatches.length > 0 && (
              <CommandGroup heading='Pages'>
                {pageMatches.map((p) => (
                  <CommandItem
                    key={`page-${p.path}`}
                    value={`page-${p.path}`}
                    onSelect={() => go(p.path)}
                  >
                    <FileText className='mr-2 h-3.5 w-3.5 text-muted-foreground' />
                    <span className='text-[13px]'>{p.label}</span>
                    <span className='ml-auto font-mono text-[11px] text-muted-foreground'>
                      {p.path}
                    </span>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}

            {records.length > 0 && (
              <>
                <CommandSeparator />
                <CommandGroup heading='Records'>
                  {records.map((r) => (
                    <CommandItem
                      key={`record-${r.collection}-${r.id}`}
                      value={`record-${r.collection}-${r.id}`}
                      onSelect={() => go(`/collections/${r.collection}/${r.id}`)}
                    >
                      <Search className='mr-2 h-3.5 w-3.5 text-nvr-cyan' />
                      <div className='min-w-0 flex-1'>
                        <div className='truncate text-[13px]'>{r.label || String(r.id)}</div>
                        {r.snippet && r.snippet !== r.label && (
                          <div className='truncate text-[11px] text-muted-foreground'>
                            {r.snippet}
                          </div>
                        )}
                      </div>
                      <span className='ml-2 shrink-0 rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground'>
                        {titleCase(r.collection)}
                      </span>
                    </CommandItem>
                  ))}
                </CommandGroup>
              </>
            )}

            {(newItemActions.length > 0 || serverActions.length > 0) && (
              <>
                <CommandSeparator />
                <CommandGroup heading='Actions'>
                  {newItemActions.map((c) => (
                    <CommandItem
                      key={`new-${c.collection}`}
                      value={`new-${c.collection}`}
                      onSelect={() => go(`/collections/${c.collection}/new`)}
                    >
                      <Plus className='mr-2 h-3.5 w-3.5 text-nvr-cyan' />
                      <span className='text-[13px]'>
                        New item in {c.display_name ?? titleCase(c.collection)}
                      </span>
                    </CommandItem>
                  ))}
                  {serverActions.map((a) => (
                    <CommandItem
                      key={`action-${a.path}-${a.label}`}
                      value={`action-${a.path}-${a.label}`}
                      onSelect={() => go(a.path)}
                    >
                      <ArrowRight className='mr-2 h-3.5 w-3.5 text-muted-foreground' />
                      <span className='text-[13px]'>{a.label}</span>
                    </CommandItem>
                  ))}
                </CommandGroup>
              </>
            )}
          </CommandList>

          {/* Footer hint row */}
          <div className='flex items-center gap-3 border-t border-border px-3 py-2 text-[11px] text-muted-foreground'>
            <span className='flex items-center gap-1'>
              <Kbd>↑</Kbd>
              <Kbd>↓</Kbd> navigate
            </span>
            <span className='flex items-center gap-1'>
              <Kbd>
                <CornerDownLeft className='h-2.5 w-2.5' />
              </Kbd>{' '}
              open
            </span>
            <span className='flex items-center gap-1'>
              <Kbd>esc</Kbd> close
            </span>
            <span className='ml-auto flex items-center gap-1'>
              <Kbd>⌘</Kbd>
              <Kbd>K</Kbd>
            </span>
          </div>
        </Command>
      </DialogContent>
    </Dialog>
  )
}
