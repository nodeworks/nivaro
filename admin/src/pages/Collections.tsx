import { useQuery } from '@tanstack/react-query'
import { ChevronRight, Database, EyeOff, FolderOpen, Search } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { api, type Collection } from '@/lib/api'
import { formatNumber, titleCase } from '@/lib/utils'

// ─── Sub-components ────────────────────────────────────────────────────────────

function CollectionAvatar({ color, name }: { color: string | null; name: string }) {
  return (
    <div
      className='flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-[13px] font-bold text-white select-none'
      style={{ backgroundColor: color ?? '#94a3b8' }}
      aria-hidden='true'
    >
      {name.charAt(0).toUpperCase()}
    </div>
  )
}

function Chip({ label, icon }: { label: string; icon?: React.ReactNode }) {
  return (
    <span className='inline-flex items-center gap-1 rounded px-1.5 py-px text-[10px] font-medium bg-slate-100 text-slate-500 dark:bg-white/10 dark:text-slate-400'>
      {icon}
      {label}
    </span>
  )
}

function CollectionRow({ col }: { col: Collection }) {
  const displayName = col.display_name ?? titleCase(col.collection)
  return (
    <Link
      to={`/collections/${col.collection}`}
      className='group flex items-center gap-3.5 px-4 py-3 transition-colors duration-150 hover:bg-[#00ceff]/[0.04] focus-visible:outline-none focus-visible:bg-[#00ceff]/[0.04] dark:hover:bg-[#00ceff]/[0.06]'
    >
      <CollectionAvatar color={col.color} name={displayName} />

      <div className='min-w-0 flex-1'>
        <p className='truncate text-[13px] font-semibold tracking-[-0.003em] text-slate-800 group-hover:text-slate-900 dark:text-slate-200 dark:group-hover:text-slate-100'>
          {displayName}
        </p>
        <p className='mt-0.5 truncate font-mono text-[11px] text-slate-400 dark:text-slate-500'>
          {col.collection}
        </p>
      </div>

      {col.note && (
        <p className='hidden w-52 shrink-0 truncate text-[12px] text-slate-400 dark:text-slate-500 xl:block'>
          {col.note}
        </p>
      )}

      {(col.hidden || col.singleton) && (
        <div className='flex shrink-0 items-center gap-1.5'>
          {col.hidden && <Chip label='hidden' icon={<EyeOff className='h-2.5 w-2.5' />} />}
          {col.singleton && <Chip label='singleton' />}
        </div>
      )}

      <ChevronRight className='h-3.5 w-3.5 shrink-0 text-slate-300 transition-transform duration-150 group-hover:translate-x-0.5 group-hover:text-slate-400 dark:text-slate-600 dark:group-hover:text-slate-500' />
    </Link>
  )
}

function GroupSection({
  group,
  cols,
  folderMap
}: {
  group: string
  cols: Collection[]
  folderMap: Map<string, Collection>
}) {
  const folder = folderMap.get(group)
  const groupLabel = folder?.display_name ?? titleCase(group)
  const groupColor = folder?.color ?? '#94a3b8'
  const sorted = [...cols].sort((a, b) => (a.sort ?? 999) - (b.sort ?? 999))

  return (
    <div className='overflow-hidden rounded-lg border border-slate-200 bg-white dark:border-white/[0.08] dark:bg-white/[0.03]'>
      <div className='flex items-center gap-2.5 border-b border-slate-100 bg-slate-50/80 px-4 py-2.5 dark:border-white/[0.06] dark:bg-white/[0.02]'>
        <div
          className='flex h-5 w-5 items-center justify-center rounded'
          style={{ backgroundColor: `${groupColor}22` }}
        >
          <FolderOpen className='h-3 w-3' style={{ color: groupColor }} />
        </div>
        <span className='text-[12px] font-semibold text-slate-700 dark:text-slate-300'>
          {groupLabel}
        </span>
        <span className='ml-auto rounded-full bg-slate-200/70 px-1.5 py-px text-[10px] font-semibold tabular-nums text-slate-500 dark:bg-white/10 dark:text-slate-400'>
          {sorted.length}
        </span>
      </div>
      <div className='divide-y divide-slate-100 dark:divide-white/[0.05]'>
        {sorted.map((col) => (
          <CollectionRow key={col.collection} col={col} />
        ))}
      </div>
    </div>
  )
}

function RootSection({ cols }: { cols: Collection[] }) {
  const sorted = [...cols].sort((a, b) => (a.sort ?? 999) - (b.sort ?? 999))
  return (
    <div className='overflow-hidden rounded-lg border border-slate-200 bg-white dark:border-white/[0.08] dark:bg-white/[0.03]'>
      <div className='divide-y divide-slate-100 dark:divide-white/[0.05]'>
        {sorted.map((col) => (
          <CollectionRow key={col.collection} col={col} />
        ))}
      </div>
    </div>
  )
}

function LoadingSkeleton() {
  return (
    <div className='space-y-4'>
      <div className='overflow-hidden rounded-lg border border-slate-200 bg-white dark:border-white/[0.08]'>
        {[...Array(6)].map((_, i) => (
          <div
            key={i}
            className='flex items-center gap-3.5 border-b border-slate-100 px-4 py-3 last:border-0 dark:border-white/[0.05]'
          >
            <Skeleton className='h-8 w-8 rounded-md' />
            <div className='flex-1 space-y-1.5'>
              <Skeleton className='h-3.5 w-40' />
              <Skeleton className='h-3 w-28' />
            </div>
            <Skeleton className='h-3.5 w-3.5 rounded' />
          </div>
        ))}
      </div>
    </div>
  )
}

function EmptySearch({ filter }: { filter: string }) {
  return (
    <div className='py-20 text-center'>
      <p className='text-[13px] text-slate-500 dark:text-slate-400'>
        No collections match{' '}
        <span className='font-semibold text-slate-700 dark:text-slate-300'>"{filter}"</span>
      </p>
    </div>
  )
}

function EmptyState() {
  return (
    <div className='flex flex-col items-center py-24 text-center'>
      <div className='mb-4 flex h-12 w-12 items-center justify-center rounded-xl border border-slate-200 bg-slate-50 dark:border-white/[0.08] dark:bg-white/[0.03]'>
        <Database className='h-5 w-5 text-slate-400' />
      </div>
      <p className='text-[13px] font-semibold text-slate-700 dark:text-slate-300'>
        No collections registered yet
      </p>
      <p className='mt-1.5 text-[12px] text-slate-400 dark:text-slate-500'>
        Register collections in the Data Model to browse them here.
      </p>
    </div>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export function CollectionsPage() {
  const [filter, setFilter] = useState('')

  const { data, isLoading } = useQuery<Collection[]>({
    queryKey: ['collections'],
    queryFn: () => api.get('/collections').then((r) => r.data.data)
  })

  const folderNames = new Set(
    data?.map((col) => col.group).filter((g): g is string => g !== null) ?? []
  )

  const folderMap = new Map(
    data?.filter((col) => folderNames.has(col.collection)).map((col) => [col.collection, col]) ?? []
  )

  const realCollections = data?.filter((col) => !folderNames.has(col.collection)) ?? []
  const realCount = realCollections.length

  const filtered = realCollections.filter((col) => {
    if (!filter) return true
    const q = filter.toLowerCase()
    return (
      col.collection.toLowerCase().includes(q) || (col.display_name ?? '').toLowerCase().includes(q)
    )
  })

  const grouped = filtered.reduce<Record<string, Collection[]>>((acc, col) => {
    const group = col.group ?? '__root__'
    acc[group] ??= []
    acc[group].push(col)
    return acc
  }, {})

  const rootItems = grouped.__root__ ?? []
  const namedGroups = Object.entries(grouped)
    .filter(([g]) => g !== '__root__')
    .sort(([a], [b]) => a.localeCompare(b))

  return (
    <>
      {/* Page header */}
      <div className='sticky top-0 z-10 border-b border-slate-200 bg-white px-8 py-5 dark:border-white/[0.08] dark:bg-[#0f1923]'>
        <div className='flex items-center gap-3'>
          <h1 className='text-[18px] font-semibold tracking-[-0.01em] text-slate-900 dark:text-slate-100'>
            Collections
          </h1>
          {data && (
            <span className='rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold tabular-nums text-slate-500 dark:bg-white/10 dark:text-slate-400'>
              {formatNumber(realCount)}
            </span>
          )}
          <div className='relative ml-auto'>
            <Search className='absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400' />
            <Input
              className='h-8 w-56 border-slate-200 bg-slate-50 pl-8 text-[13px] placeholder:text-slate-400 focus-visible:ring-nvr-cyan dark:border-white/[0.08] dark:bg-white/[0.05] dark:text-slate-200 dark:placeholder:text-slate-500'
              placeholder='Filter collections…'
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
          </div>
        </div>
      </div>

      {/* Content */}
      <div className='p-8'>
        {isLoading ? (
          <LoadingSkeleton />
        ) : filtered.length === 0 && filter ? (
          <EmptySearch filter={filter} />
        ) : realCount === 0 ? (
          <EmptyState />
        ) : (
          <div className='space-y-4'>
            {rootItems.length > 0 && <RootSection cols={rootItems} />}

            {namedGroups.length > 0 && (
              <div
                className={
                  namedGroups.length === 1
                    ? 'space-y-4'
                    : 'grid grid-cols-1 items-start gap-4 lg:grid-cols-2'
                }
              >
                {namedGroups.map(([group, cols]) => (
                  <GroupSection key={group} group={group} cols={cols} folderMap={folderMap} />
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </>
  )
}
