import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, Copy, FileCode2, Plus, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { Textarea } from '@/components/ui/textarea'
import { api } from '@/lib/api'
import { cn, formatRelative } from '@/lib/utils'

interface PersistedQuery {
  id: number
  hash: string
  name: string
  query: string
  created_by: string | null
  created_at: string
}

export function PersistedQueriesPage() {
  const queryClient = useQueryClient()
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [newQuery, setNewQuery] = useState('')
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [copied, setCopied] = useState(false)

  const { data: queries, isLoading } = useQuery({
    queryKey: ['persisted-queries'],
    queryFn: () =>
      api.get<{ data: PersistedQuery[] }>('/persisted-queries').then((r) => r.data.data)
  })

  const selected = queries?.find((q) => q.id === selectedId) ?? null

  const createMut = useMutation({
    mutationFn: () =>
      api
        .post<{ data: PersistedQuery }>('/persisted-queries', {
          name: newName.trim(),
          query: newQuery
        })
        .then((r) => r.data.data),
    onSuccess: (row) => {
      queryClient.invalidateQueries({ queryKey: ['persisted-queries'] })
      setCreating(false)
      setNewName('')
      setNewQuery('')
      setSelectedId(row.id)
      toast.success('Persisted query created')
    },
    onError: (err: unknown) => {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error
      toast.error(msg ?? 'Failed to create persisted query')
    }
  })

  const deleteMut = useMutation({
    mutationFn: (id: number) => api.delete(`/persisted-queries/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['persisted-queries'] })
      setSelectedId(null)
      setConfirmDelete(false)
      toast.success('Persisted query deleted')
    },
    onError: () => toast.error('Failed to delete persisted query')
  })

  const copyHash = (hash: string) => {
    navigator.clipboard.writeText(hash).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }

  return (
    <div className='flex flex-1 min-h-0 flex-col'>
      {/* Page header */}
      <header className='sticky top-0 z-10 shrink-0 border-b border-slate-200 bg-white px-6 py-4 dark:border-border dark:bg-card'>
        <div className='flex items-center justify-between'>
          <div>
            <h1 className='text-[17px] font-semibold tracking-[-0.01em] text-slate-900 dark:text-foreground'>
              Persisted Queries
            </h1>
            <p className='mt-0.5 text-[12px] text-slate-400 dark:text-muted-foreground'>
              Pre-registered GraphQL queries executed by hash — smaller requests, locked-down
              surface.
            </p>
          </div>
          <Button
            size='sm'
            onClick={() => {
              setCreating(true)
              setSelectedId(null)
              setConfirmDelete(false)
            }}
          >
            <Plus className='mr-1.5 h-3.5 w-3.5' />
            New query
          </Button>
        </div>
      </header>

      <div className='flex flex-1 min-h-0 overflow-hidden'>
        {/* Left list */}
        <aside className='w-[272px] shrink-0 overflow-y-auto border-r border-slate-200 bg-white dark:border-border dark:bg-card'>
          {isLoading ? (
            <div className='space-y-2 p-3'>
              {[1, 2, 3].map((k) => (
                <Skeleton key={k} className='h-12 rounded-lg' />
              ))}
            </div>
          ) : (queries ?? []).length === 0 ? (
            <p className='px-4 py-6 text-center text-[12px] text-slate-400'>
              No persisted queries yet
            </p>
          ) : (
            <div className='py-2'>
              {(queries ?? []).map((q) => (
                <button
                  key={q.id}
                  type='button'
                  onClick={() => {
                    setSelectedId(q.id)
                    setCreating(false)
                    setConfirmDelete(false)
                  }}
                  className={cn(
                    'block w-full px-4 py-2.5 text-left transition-colors',
                    selectedId === q.id && !creating
                      ? 'bg-[#00ceff]/10'
                      : 'hover:bg-slate-50 dark:hover:bg-muted/50'
                  )}
                >
                  <span className='block truncate text-[13px] font-medium text-slate-800 dark:text-foreground'>
                    {q.name}
                  </span>
                  <span className='block font-mono text-[11px] text-slate-400'>
                    {q.hash.slice(0, 12)}…
                  </span>
                </button>
              ))}
            </div>
          )}
        </aside>

        {/* Right detail */}
        <div className='flex-1 overflow-y-auto bg-slate-50 dark:bg-background'>
          {creating ? (
            <div className='p-8'>
              <div className='max-w-2xl space-y-4'>
                <h2 className='text-[15px] font-semibold text-slate-900 dark:text-foreground'>
                  New persisted query
                </h2>
                <div className='space-y-1.5'>
                  <Label className='text-[12px]'>Name</Label>
                  <Input
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    placeholder='e.g. Dashboard article feed'
                    className='h-8 text-[13px]'
                    autoFocus
                  />
                </div>
                <div className='space-y-1.5'>
                  <Label className='text-[12px]'>GraphQL query</Label>
                  <Textarea
                    value={newQuery}
                    onChange={(e) => setNewQuery(e.target.value)}
                    rows={12}
                    spellCheck={false}
                    placeholder={
                      'query Articles {\n  articles(limit: 10) {\n    id\n    title\n  }\n}'
                    }
                    className='font-mono text-[12px]'
                  />
                  <p className='text-[11px] text-slate-400'>
                    The sha256 hash is computed server-side from the exact query text.
                  </p>
                </div>
                <div className='flex gap-2'>
                  <Button
                    size='sm'
                    disabled={!newName.trim() || !newQuery.trim() || createMut.isPending}
                    onClick={() => createMut.mutate()}
                  >
                    {createMut.isPending ? 'Creating…' : 'Create'}
                  </Button>
                  <Button size='sm' variant='outline' onClick={() => setCreating(false)}>
                    Cancel
                  </Button>
                </div>
              </div>
            </div>
          ) : selected ? (
            <div className='p-8'>
              <div className='max-w-3xl space-y-5'>
                <div className='flex items-start justify-between gap-4'>
                  <div>
                    <h2 className='text-[15px] font-semibold text-slate-900 dark:text-foreground'>
                      {selected.name}
                    </h2>
                    <p className='mt-0.5 text-[12px] text-slate-400'>
                      Created {formatRelative(selected.created_at)}
                    </p>
                  </div>
                  {confirmDelete ? (
                    <div className='flex shrink-0 items-center gap-2'>
                      <span className='text-[12px] text-slate-500'>Delete this query?</span>
                      <Button
                        size='sm'
                        variant='destructive'
                        className='h-7 text-[12px]'
                        disabled={deleteMut.isPending}
                        onClick={() => deleteMut.mutate(selected.id)}
                      >
                        {deleteMut.isPending ? 'Deleting…' : 'Confirm'}
                      </Button>
                      <Button
                        size='sm'
                        variant='outline'
                        className='h-7 text-[12px]'
                        onClick={() => setConfirmDelete(false)}
                      >
                        Cancel
                      </Button>
                    </div>
                  ) : (
                    <Button
                      size='sm'
                      variant='outline'
                      className='h-7 shrink-0 text-[12px] text-red-500 hover:text-red-600'
                      onClick={() => setConfirmDelete(true)}
                    >
                      <Trash2 className='mr-1 h-3.5 w-3.5' />
                      Delete
                    </Button>
                  )}
                </div>

                {/* Hash */}
                <div className='space-y-1.5'>
                  <Label className='text-[12px]'>sha256 hash</Label>
                  <div className='flex items-center gap-2'>
                    <code className='flex-1 truncate rounded-md border border-slate-200 bg-white px-3 py-2 font-mono text-[12px] text-slate-700 dark:border-border dark:bg-card dark:text-slate-300'>
                      {selected.hash}
                    </code>
                    <Button
                      size='sm'
                      variant='outline'
                      className='h-8 shrink-0'
                      onClick={() => copyHash(selected.hash)}
                    >
                      {copied ? (
                        <Check className='h-3.5 w-3.5 text-emerald-500' />
                      ) : (
                        <Copy className='h-3.5 w-3.5' />
                      )}
                    </Button>
                  </div>
                </div>

                {/* Query text */}
                <div className='space-y-1.5'>
                  <Label className='text-[12px]'>Query</Label>
                  <pre className='overflow-x-auto rounded-md border border-slate-200 bg-white p-3 font-mono text-[12px] leading-relaxed text-slate-700 dark:border-border dark:bg-card dark:text-slate-300'>
                    {selected.query}
                  </pre>
                </div>

                {/* Usage hint */}
                <div className='rounded-lg border border-nvr-cyan/30 bg-nvr-cyan/[0.04] p-4'>
                  <p className='text-[12px] font-medium text-slate-700 dark:text-foreground'>
                    Usage
                  </p>
                  <p className='mt-1 text-[12px] text-slate-500 dark:text-muted-foreground'>
                    Execute this query by hash instead of sending the full query text:
                  </p>
                  <pre className='mt-2 overflow-x-auto rounded-md bg-slate-900 p-3 font-mono text-[11px] leading-relaxed text-slate-100'>
                    {`POST /api/graphql\n{ "id": "${selected.hash}" }`}
                  </pre>
                  <p className='mt-2 text-[11px] text-slate-400'>
                    APQ-style is also supported:{' '}
                    <code className='font-mono'>
                      {'{ "extensions": { "persistedQuery": { "sha256Hash": "…" } } }'}
                    </code>
                  </p>
                </div>
              </div>
            </div>
          ) : (
            <div className='flex h-full flex-col items-center justify-center gap-2 text-center'>
              <FileCode2 className='h-8 w-8 text-slate-300' />
              <p className='text-[13px] text-slate-400'>
                Select a persisted query, or create a new one
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
