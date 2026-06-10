import { useQuery } from '@tanstack/react-query'
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  Network,
  Plus,
  RefreshCw
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'

// ─── Types ──────────────────────────────────────────────────────────────────

interface HierarchyLevel {
  collection: string
  label_field: string
  parent_fk: string | null
}

interface HierarchyConfig {
  id: number
  name: string
  description: string | null
  levels: HierarchyLevel[]
  created_at: string
  created_by: number | null
}

interface HierarchyNode {
  id: number | string
  collection: string
  label: string
  level_index: number
  parent_id: number | string | null
  parent_collection: string | null
  raw: Record<string, unknown>
  children: HierarchyNode[]
}

// ─── Level colors ─────────────────────────────────────────────────────────────

const LEVEL_DOT_COLORS = ['bg-nvr-cyan', 'bg-purple-500', 'bg-amber-500', 'bg-green-500'] as const

function levelColor(levelIndex: number): string {
  return LEVEL_DOT_COLORS[levelIndex % LEVEL_DOT_COLORS.length]
}

// ─── Tree node row ────────────────────────────────────────────────────────────

function collectAllIds(nodes: HierarchyNode[], acc: Set<string>): Set<string> {
  for (const n of nodes) {
    acc.add(`${n.id}:${n.collection}`)
    if (n.children?.length) collectAllIds(n.children, acc)
  }
  return acc
}

function TreeNodeRow({
  node,
  expanded,
  onToggle,
  config
}: {
  node: HierarchyNode
  expanded: Set<string>
  onToggle: (key: string) => void
  config: HierarchyConfig
}) {
  const navigate = useNavigate()
  const key = `${node.id}:${node.collection}`
  const hasChildren = (node.children?.length ?? 0) > 0
  const isOpen = expanded.has(key)
  const isRoot = node.level_index === 0

  const levels = config.levels ?? []
  const lastLevelIndex = levels.length - 1
  const isLastLevel = node.level_index >= lastLevelIndex
  const childLevel = levels[node.level_index + 1]

  return (
    <div>
      <div
        className='group flex h-10 items-center gap-2 rounded-md pr-2 hover:bg-slate-100 dark:hover:bg-muted/50'
        style={{ paddingLeft: `${node.level_index * 20 + 4}px` }}
      >
        {hasChildren ? (
          <button
            type='button'
            onClick={() => onToggle(key)}
            className='flex h-5 w-5 shrink-0 items-center justify-center rounded text-slate-400 hover:text-slate-700 dark:hover:text-slate-200'
            aria-label={isOpen ? 'Collapse' : 'Expand'}
          >
            {isOpen ? <ChevronDown className='h-4 w-4' /> : <ChevronRight className='h-4 w-4' />}
          </button>
        ) : (
          <span className='w-5 shrink-0' />
        )}

        <span className={cn('h-2.5 w-2.5 shrink-0 rounded-full', levelColor(node.level_index))} />

        <span
          className={cn(
            'truncate text-[13px]',
            isRoot
              ? 'font-semibold text-slate-900 dark:text-foreground'
              : 'font-normal text-slate-700 dark:text-slate-300'
          )}
        >
          {node.label || `#${node.id}`}
        </span>

        <span className='shrink-0 font-mono text-[11px] text-slate-400 dark:text-muted-foreground'>
          {node.collection}
        </span>

        <div className='ml-auto flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100'>
          <Button
            size='sm'
            variant='ghost'
            className='h-7 px-2 text-[12px]'
            onClick={() => navigate(`/collections/${node.collection}/${node.id}`)}
          >
            <ExternalLink className='mr-1 h-3.5 w-3.5' /> Open
          </Button>
          {!isLastLevel && childLevel && (
            <Button
              size='sm'
              variant='ghost'
              className='h-7 px-2 text-[12px]'
              onClick={() =>
                navigate(
                  `/collections/${childLevel.collection}/new?parentField=${encodeURIComponent(
                    childLevel.parent_fk ?? ''
                  )}&parentId=${encodeURIComponent(String(node.id))}`
                )
              }
            >
              <Plus className='mr-1 h-3.5 w-3.5' /> Add Child
            </Button>
          )}
        </div>
      </div>

      {hasChildren && isOpen && (
        <div>
          {node.children.map((child) => (
            <TreeNodeRow
              key={`${child.id}:${child.collection}`}
              node={child}
              expanded={expanded}
              onToggle={onToggle}
              config={config}
            />
          ))}
        </div>
      )}
    </div>
  )
}

// ─── Main page ────────────────────────────────────────────────────────────────

export function HierarchyViewPage() {
  const { id } = useParams<{ id: string }>()
  const configId = id ? Number(id) : null

  const {
    data: config,
    isLoading: configLoading,
    isError: configError
  } = useQuery({
    queryKey: ['hierarchy-config', configId],
    queryFn: () =>
      api.get<{ data: HierarchyConfig }>(`/hierarchy-configs/${configId}`).then((r) => r.data.data),
    enabled: configId != null
  })

  const {
    data: tree,
    isLoading: treeLoading,
    isError: treeError,
    refetch,
    isFetching
  } = useQuery({
    queryKey: ['hierarchy-tree', configId],
    queryFn: () =>
      api.get<{ data: HierarchyNode[] }>(`/hierarchy/${configId}/tree`).then((r) => r.data.data),
    enabled: configId != null
  })

  const allKeys = useMemo(() => collectAllIds(tree ?? [], new Set<string>()), [tree])
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  // Expand all by default whenever the tree data changes
  useEffect(() => {
    setExpanded(new Set(allKeys))
  }, [allKeys])

  function toggle(key: string) {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const isLoading = configLoading || treeLoading
  const isError = configError || treeError
  const nodes = tree ?? []

  return (
    <div className='flex flex-1 min-h-0 flex-col'>
      <header className='shrink-0 border-b border-slate-200 bg-white px-6 py-4 dark:border-border dark:bg-card'>
        <Link
          to={configId != null ? `/hierarchies/${configId}` : '/hierarchies'}
          className='mb-1 inline-flex items-center gap-1 text-[12px] text-slate-400 transition-colors hover:text-nvr-cyan dark:text-muted-foreground'
        >
          <ChevronLeft className='h-3.5 w-3.5' />
          {config?.name ?? 'Back'}
        </Link>
        <div className='flex items-center justify-between'>
          <div className='flex items-center gap-2.5'>
            <div className='flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-nvr-navy'>
              <Network className='h-3.5 w-3.5 text-nvr-cyan' />
            </div>
            <div>
              <h1 className='text-[17px] font-semibold tracking-[-0.01em] text-slate-900 dark:text-foreground'>
                {config?.name ?? 'Hierarchy'}{' '}
                <span className='font-normal text-slate-400'>Tree View</span>
              </h1>
              {config?.description && (
                <p className='text-[12px] text-slate-400 dark:text-muted-foreground'>
                  {config.description}
                </p>
              )}
            </div>
          </div>
          <Button
            size='sm'
            variant='outline'
            onClick={() => refetch()}
            disabled={isFetching || configId == null}
          >
            <RefreshCw className={cn('mr-1.5 h-3.5 w-3.5', isFetching && 'animate-spin')} />
            Refresh
          </Button>
        </div>
      </header>

      <div className='flex-1 overflow-y-auto p-6'>
        {isLoading ? (
          <div className='space-y-1.5'>
            {[...Array(8)].map((_, i) => (
              <Skeleton
                // biome-ignore lint/suspicious/noArrayIndexKey: skeleton placeholders
                key={i}
                className='h-10'
                style={{ marginLeft: `${(i % 4) * 20}px`, width: `${60 - (i % 4) * 8}%` }}
              />
            ))}
          </div>
        ) : isError || !config ? (
          <div className='flex flex-col items-center justify-center py-20 text-center'>
            <div className='flex h-12 w-12 items-center justify-center rounded-xl bg-slate-100 dark:bg-muted'>
              <Network className='h-5 w-5 text-slate-400' />
            </div>
            <p className='mt-3 text-[13px] font-medium text-slate-600 dark:text-foreground'>
              {configError ? 'Hierarchy not found' : 'Failed to load tree'}
            </p>
            <Link to='/hierarchies' className='mt-2 text-[11px] text-nvr-cyan hover:underline'>
              Back to hierarchies
            </Link>
          </div>
        ) : nodes.length === 0 ? (
          <div className='flex flex-col items-center justify-center py-20 text-center'>
            <div className='flex h-12 w-12 items-center justify-center rounded-xl bg-slate-100 dark:bg-muted'>
              <Network className='h-5 w-5 text-slate-400' />
            </div>
            <p className='mt-3 text-[13px] font-medium text-slate-600 dark:text-foreground'>
              No nodes in this hierarchy yet
            </p>
            <p className='mt-1 text-[11px] text-slate-400 dark:text-muted-foreground'>
              Add records to the root collection to populate the tree.
            </p>
          </div>
        ) : (
          <div className='mx-auto max-w-3xl space-y-0.5'>
            {nodes.map((node) => (
              <TreeNodeRow
                key={`${node.id}:${node.collection}`}
                node={node}
                expanded={expanded}
                onToggle={toggle}
                config={config}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
