import { useQuery } from '@tanstack/react-query'
import { Download, FileCode2, ServerCog } from 'lucide-react'
import { useState } from 'react'
import { api } from '@/lib/api'

/**
 * API reference + developer downloads: generated TypeScript definitions, the
 * instance-typed SDK client (#164), the schema-driven mock server (#345), and
 * the REST/GraphQL surface changelogs (#163/#315).
 */
export function ApiDocsPage() {
  const [showChangelog, setShowChangelog] = useState(false)

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
        <ToolButton
          icon={Download}
          label='openapi.json'
          tip='OpenAPI 3 spec'
          onClick={() => download('/dev-tools/openapi.json', 'openapi.json')}
        />
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
