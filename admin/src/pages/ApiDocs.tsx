import { useQuery } from '@tanstack/react-query'
import { Check, ChevronsUpDown, Download, FileCode2, ServerCog } from 'lucide-react'
import { useState } from 'react'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList
} from '@/components/ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'

/**
 * API reference + developer downloads: generated TypeScript definitions, the
 * instance-typed SDK client (#164), the schema-driven mock server (#345), and
 * the REST/GraphQL surface changelogs (#163/#315).
 */
export function ApiDocsPage() {
  const [showChangelog, setShowChangelog] = useState(false)
  const [specRole, setSpecRole] = useState<{ id: string; name: string } | null>(null)

  const download = (path: string, filename: string) => {
    void api.get(path, { responseType: 'blob' }).then((r) => {
      const url = URL.createObjectURL(r.data as Blob)
      const a = document.createElement('a')
      a.href = url
      a.download = filename
      a.click()
      URL.revokeObjectURL(url)
    })
  }

  return (
    <div className='flex flex-1 min-h-0 flex-col'>
      <div className='flex shrink-0 flex-wrap items-center gap-2 border-b border-slate-200 bg-white px-4 py-2 dark:border-border dark:bg-card'>
        <span className='mr-1 text-[11px] font-semibold uppercase tracking-wide text-slate-400'>
          Developer downloads
        </span>
        <ToolButton
          icon={FileCode2}
          label='types.ts'
          tip='TypeScript interfaces for every collection'
          onClick={() => download('/dev-tools/types.ts', 'types.ts')}
        />
        <ToolButton
          icon={FileCode2}
          label='typed-client.ts'
          tip='Typed @nivaro/sdk wrapper — item reads/writes autocomplete against this instance'
          onClick={() => download('/dev-tools/typed-client.ts', 'typed-client.ts')}
        />
        <ToolButton
          icon={ServerCog}
          label='mock-server.mjs'
          tip='Dependency-free mock API generated from this schema — offline frontend dev'
          onClick={() => download('/dev-tools/mock-server.mjs', 'mock-server.mjs')}
        />
        <div className='inline-flex items-center gap-1' data-openapi-role>
          <ToolButton
            icon={Download}
            label='openapi.json'
            tip={
              specRole
                ? `OpenAPI 3 spec narrowed to what the ${specRole.name} role can read and write`
                : 'OpenAPI 3 spec — every collection'
            }
            onClick={() =>
              specRole
                ? download(
                    `/dev-tools/openapi.json?role=${encodeURIComponent(specRole.id)}`,
                    `openapi.${slug(specRole.name)}.json`
                  )
                : download('/dev-tools/openapi.json', 'openapi.json')
            }
          />
          <RolePicker value={specRole} onChange={setSpecRole} />
        </div>
        <button
          type='button'
          onClick={() => setShowChangelog((v) => !v)}
          className='ml-auto rounded-md border border-slate-200 px-2.5 py-1 text-[12px] text-slate-600 hover:bg-muted dark:border-border dark:text-slate-300'
        >
          {showChangelog ? 'Hide' : 'Show'} API changelog
        </button>
      </div>
      {showChangelog && <ChangelogPanel />}
      <iframe src='/api/schema' className='flex-1 w-full border-0 min-h-0' title='API Reference' />
    </div>
  )
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '') || 'role'

/** Which role the OpenAPI download is narrowed to (#1283); none = the full spec. */
function RolePicker({
  value,
  onChange
}: {
  value: { id: string; name: string } | null
  onChange: (v: { id: string; name: string } | null) => void
}) {
  const [open, setOpen] = useState(false)
  const { data: roles = [] } = useQuery<Array<{ id: string; name: string }>>({
    queryKey: ['api-docs-roles'],
    queryFn: () => api.get('/roles').then((r) => r.data.data),
    enabled: open || !!value
  })
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type='button'
          data-openapi-role-picker
          data-tip='Narrow the spec to one role — its readable and writable fields, row filters and User Scope notes'
          className='inline-flex items-center gap-1 rounded-md border border-slate-200 px-2 py-1 text-[11.5px] text-slate-600 hover:bg-muted dark:border-border dark:text-slate-300'
        >
          <span className='max-w-[160px] truncate'>
            {value ? `As ${value.name}` : 'Every role'}
          </span>
          <ChevronsUpDown className='h-3 w-3 text-slate-400' />
        </button>
      </PopoverTrigger>
      <PopoverContent className='w-[260px] p-0' align='start'>
        <Command>
          <CommandInput placeholder='Find a role…' />
          <CommandList>
            <CommandEmpty>No roles.</CommandEmpty>
            <CommandGroup>
              <CommandItem
                value='__all__ every role full spec'
                onSelect={() => {
                  onChange(null)
                  setOpen(false)
                }}
                className='gap-2 text-[12px]'
              >
                <Check className={cn('h-3.5 w-3.5', value ? 'opacity-0' : 'opacity-100')} />
                Full spec (every collection)
              </CommandItem>
              {roles.map((r) => (
                <CommandItem
                  key={r.id}
                  value={`${r.name} ${r.id}`}
                  data-openapi-role-option={r.id}
                  onSelect={() => {
                    onChange({ id: r.id, name: r.name })
                    setOpen(false)
                  }}
                  className='gap-2 text-[12px]'
                >
                  <Check
                    className={cn('h-3.5 w-3.5', value?.id === r.id ? 'opacity-100' : 'opacity-0')}
                  />
                  <span className='truncate'>{r.name}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

function ToolButton({
  icon: Icon,
  label,
  tip,
  onClick
}: {
  icon: typeof Download
  label: string
  tip: string
  onClick: () => void
}) {
  return (
    <button
      type='button'
      onClick={onClick}
      data-tip={tip}
      className='inline-flex items-center gap-1.5 rounded-md border border-slate-200 px-2.5 py-1 font-mono text-[11.5px] text-slate-600 hover:bg-muted dark:border-border dark:text-slate-300'
    >
      <Icon className='h-3.5 w-3.5 text-nvr-cyan' />
      {label}
    </button>
  )
}

function ChangelogPanel() {
  const { data: rest = [] } = useQuery<
    Array<{ id: number; version: string; at: string; diff: string | null; breaking: boolean }>
  >({
    queryKey: ['api-changelog'],
    queryFn: () => api.get('/dev-tools/api-changelog').then((r) => r.data.data)
  })
  const { data: gql = [] } = useQuery<
    Array<{ id: number; at: string; diff: string | null; breaking: boolean }>
  >({
    queryKey: ['graphql-changelog'],
    queryFn: () => api.get('/dev-tools/graphql-changelog').then((r) => r.data.data)
  })
  return (
    <div className='grid max-h-[300px] shrink-0 grid-cols-1 gap-4 overflow-y-auto border-b border-slate-200 bg-slate-50 p-4 sm:grid-cols-2 dark:border-border dark:bg-background'>
      <section>
        <h2 className='mb-1.5 text-[12px] font-semibold'>REST routes per release</h2>
        {rest.length === 0 ? (
          <p className='text-[12px] text-slate-400'>No releases recorded yet.</p>
        ) : (
          rest.map((r) => (
            <div key={r.id} className='mb-2'>
              <p className='text-[12px] font-medium'>
                {r.version}{' '}
                <span className='text-[10.5px] text-slate-400'>
                  {new Date(r.at).toLocaleDateString()}
                </span>
                {r.breaking && (
                  <span className='ml-1.5 rounded bg-red-100 px-1.5 py-px text-[10px] font-semibold text-red-700 dark:bg-red-500/15 dark:text-red-300'>
                    breaking
                  </span>
                )}
              </p>
              {r.diff && (
                <pre className='mt-0.5 max-h-28 overflow-y-auto whitespace-pre-wrap rounded bg-white p-2 font-mono text-[10.5px] text-slate-600 dark:bg-card dark:text-slate-300'>
                  {r.diff}
                </pre>
              )}
            </div>
          ))
        )}
      </section>
      <section>
        <h2 className='mb-1.5 text-[12px] font-semibold'>GraphQL schema changes</h2>
        {gql.length === 0 ? (
          <p className='text-[12px] text-slate-400'>No schema changes recorded yet.</p>
        ) : (
          gql.map((g) => (
            <div key={g.id} className='mb-2'>
              <p className='text-[12px] font-medium'>
                {new Date(g.at).toLocaleString()}
                {g.breaking && (
                  <span className='ml-1.5 rounded bg-red-100 px-1.5 py-px text-[10px] font-semibold text-red-700 dark:bg-red-500/15 dark:text-red-300'>
                    breaking
                  </span>
                )}
              </p>
              {g.diff && (
                <pre className='mt-0.5 max-h-28 overflow-y-auto whitespace-pre-wrap rounded bg-white p-2 font-mono text-[10.5px] text-slate-600 dark:bg-card dark:text-slate-300'>
                  {g.diff}
                </pre>
              )}
            </div>
          ))
        )}
      </section>
    </div>
  )
}
