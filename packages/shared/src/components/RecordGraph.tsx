import { useQueries } from '@tanstack/react-query'
import { ChevronRight, Loader2, Minimize2, Waypoints } from 'lucide-react'
import { type ReactNode, useMemo, useState } from 'react'
import { useDrilldown, useItemNavigation, useNivaroClient } from '../context'
import { get } from '../lib/commands'
import { cn } from '../lib/utils'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from './ui/sheet'

/**
 * Relationship explorer (#998). A record's neighbourhood drawn as a tree that
 * grows one hop at a time: the record, the relations it takes part in
 * (grouped — "Purchase orders · 3"), and the records behind each group. Any
 * record node expands the same way, so a workflow → its PO → the PO's
 * invoices is three clicks. Clicking a record opens it in the drill sheet
 * (or navigates when the host has none).
 *
 * Every hop is read as the viewer by GET /record-graph/:collection/:id, so
 * the picture never shows a record the viewer could not open themselves.
 */

export interface RecordGraphNode {
  collection: string
  id: string
  label: string
}

export interface RecordGraphGroup {
  key: string
  direction: 'out' | 'in' | 'm2m'
  field: string
  label: string
  collection: string
  collection_label: string
  total: number
  items: RecordGraphNode[]
}

interface GraphHop {
  node: RecordGraphNode & { collection_label: string }
  groups: RecordGraphGroup[]
}

/** Records only — system targets (people, files) show but never expand. */
function expandable(collection: string): boolean {
  return !/^(nivaro|directus)_/i.test(collection)
}

const REC_W = 236
const GRP_W = 184
const COL_GAP = 52
const REC_H = 50
const GRP_H = 34
const ROW_GAP = 10

type TreeNode =
  | {
      kind: 'record'
      path: string
      depth: number
      node: RecordGraphNode
      collectionLabel: string
      seen: boolean
      root: boolean
      expanded: boolean
      loading: boolean
      error: boolean
      children: TreeNode[]
    }
  | {
      kind: 'group'
      path: string
      depth: number
      group: RecordGraphGroup
      shown: number
      collapsed: boolean
      children: TreeNode[]
    }

interface Placed {
  t: TreeNode
  x: number
  y: number
  w: number
  h: number
}

const keyOf = (n: { collection: string; id: string }) => `${n.collection}:${n.id}`

function xOf(depth: number): number {
  const pair = Math.floor(depth / 2) * (REC_W + GRP_W + 2 * COL_GAP)
  return depth % 2 === 0 ? pair : pair + REC_W + COL_GAP
}

/** Tidy tree: each subtree gets the height of its children (or its own box),
 *  the node sits centred on them. */
function layout(root: TreeNode): { placed: Placed[]; width: number; height: number } {
  const placed: Placed[] = []
  const heightOf = (t: TreeNode): number => {
    const own = t.kind === 'record' ? REC_H : GRP_H
    if (t.children.length === 0) return own
    const sum = t.children.reduce((s, c) => s + heightOf(c), 0) + ROW_GAP * (t.children.length - 1)
    return Math.max(own, sum)
  }
  const place = (t: TreeNode, top: number) => {
    const total = heightOf(t)
    const h = t.kind === 'record' ? REC_H : GRP_H
    placed.push({
      t,
      x: xOf(t.depth),
      y: top + total / 2 - h / 2,
      w: t.kind === 'record' ? REC_W : GRP_W,
      h
    })
    let cursor = top
    const childSum =
      t.children.reduce((s, c) => s + heightOf(c), 0) + ROW_GAP * Math.max(0, t.children.length - 1)
    cursor += (total - childSum) / 2
    for (const c of t.children) {
      place(c, cursor)
      cursor += heightOf(c) + ROW_GAP
    }
  }
  place(root, 0)
  const width = Math.max(...placed.map((p) => p.x + p.w))
  const height = Math.max(...placed.map((p) => p.y + p.h))
  return { placed, width, height }
}

export function RecordGraphExplorer({
  collection,
  itemId,
  className
}: {
  collection: string
  itemId: string
  className?: string
}) {
  const client = useNivaroClient()
  const drill = useDrilldown()
  const nav = useItemNavigation()
  const rootPath = keyOf({ collection, id: String(itemId) })
  // Record paths that are open; the root starts open.
  const [open, setOpen] = useState<Set<string>>(() => new Set([rootPath]))
  // Group paths that are folded.
  const [folded, setFolded] = useState<Set<string>>(() => new Set())

  // Which records' hops are needed = every open record path's record.
  const wanted = useMemo(() => {
    const m = new Map<string, { collection: string; id: string }>()
    for (const p of open) {
      const last = p.split('/').pop() as string
      const i = last.indexOf(':')
      m.set(last, { collection: last.slice(0, i), id: last.slice(i + 1) })
    }
    return [...m.values()]
  }, [open])

  const hops = useQueries({
    queries: wanted.map((r) => ({
      queryKey: ['record-graph', r.collection, r.id],
      queryFn: () =>
        client
          .request<{ data: GraphHop }>(get(`/record-graph/${r.collection}/${r.id}`))
          .then((res) => res.data),
      staleTime: 60_000,
      retry: false
    }))
  })
  const hopByKey = new Map<string, { data?: GraphHop; loading: boolean; error: boolean }>()
  wanted.forEach((r, i) => {
    hopByKey.set(keyOf(r), {
      data: hops[i]?.data,
      loading: !!hops[i]?.isLoading,
      error: !!hops[i]?.isError
    })
  })
  const rootHop = hopByKey.get(rootPath)

  // hopByKey is rebuilt every render from `hops` — `hops` is the dependency.
  // biome-ignore lint/correctness/useExhaustiveDependencies: hopByKey derives from hops
  const tree = useMemo((): TreeNode => {
    const build = (
      node: RecordGraphNode,
      collectionLabel: string,
      path: string,
      depth: number,
      ancestors: Set<string>
    ): TreeNode => {
      const k = keyOf(node)
      const seen = ancestors.has(k)
      const isOpen = !seen && open.has(path)
      const hop = isOpen ? hopByKey.get(k) : undefined
      const children: TreeNode[] = []
      if (isOpen && hop?.data) {
        const next = new Set(ancestors)
        next.add(k)
        for (const g of hop.data.groups) {
          // The record we came from reads as a back-edge — leave it out.
          const items = g.items.filter((n) => !ancestors.has(keyOf(n)))
          if (items.length === 0) continue
          const gPath = `${path}/${g.key}`
          const collapsed = folded.has(gPath)
          children.push({
            kind: 'group',
            path: gPath,
            depth: depth + 1,
            group: g,
            shown: items.length,
            collapsed,
            children: collapsed
              ? []
              : items.map((n) =>
                  build(n, g.collection_label, `${gPath}/${keyOf(n)}`, depth + 2, next)
                )
          })
        }
      }
      return {
        kind: 'record',
        path,
        depth,
        node,
        collectionLabel,
        seen,
        root: depth === 0,
        expanded: isOpen,
        loading: isOpen && !!hop?.loading,
        error: isOpen && !!hop?.error,
        children
      }
    }
    const rootNode = rootHop?.data?.node ?? {
      collection,
      id: String(itemId),
      label: `#${itemId}`,
      collection_label: collection
    }
    return build(
      rootNode,
      rootHop?.data?.node.collection_label ?? collection,
      rootPath,
      0,
      new Set()
    )
  }, [open, folded, hops, rootHop?.data, collection, itemId, rootPath])

  const { placed, width, height } = useMemo(() => layout(tree), [tree])
  const byPath = new Map(placed.map((p) => [p.t.path, p]))

  const toggleOpen = (path: string) =>
    setOpen((prev) => {
      const next = new Set(prev)
      if (next.has(path)) {
        // Closing a record closes everything beneath it too.
        for (const p of prev) if (p === path || p.startsWith(`${path}/`)) next.delete(p)
      } else next.add(path)
      return next
    })
  const toggleFold = (path: string) =>
    setFolded((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })

  const openRecord = (n: RecordGraphNode) => {
    if (!expandable(n.collection)) return
    if (drill) drill.open({ collection: n.collection, itemId: n.id, title: n.label })
    else nav.open({ collection: n.collection, itemId: n.id })
  }

  if (rootHop?.error) {
    return (
      <p className='p-6 text-sm text-muted-foreground' data-record-graph-error>
        This record's relationships could not be loaded — you may not have access to it.
      </p>
    )
  }

  const edges: ReactNode[] = []
  for (const p of placed) {
    for (const c of p.t.children) {
      const q = byPath.get(c.path)
      if (!q) continue
      const x1 = p.x + p.w
      const y1 = p.y + p.h / 2
      const x2 = q.x
      const y2 = q.y + q.h / 2
      const mx = (x1 + x2) / 2
      edges.push(
        <path
          key={`${p.t.path}>${c.path}`}
          d={`M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`}
          className='fill-none stroke-[#cbd5e1] dark:stroke-[#475569]'
          strokeWidth={1.25}
        />
      )
    }
  }

  const openCount = open.size

  return (
    <div className={cn('flex min-h-0 flex-1 flex-col', className)} data-record-graph>
      <div className='flex shrink-0 items-center gap-3 border-b border-border px-4 py-2 text-[12px] text-muted-foreground'>
        <span>
          Click a record to open it · <ChevronRight className='inline h-3 w-3' /> shows what it
          connects to
        </span>
        {openCount > 1 && (
          <button
            type='button'
            className='ml-auto inline-flex items-center gap-1 rounded-md px-2 py-1 hover:bg-muted hover:text-foreground'
            onClick={() => {
              setOpen(new Set([rootPath]))
              setFolded(new Set())
            }}
            data-record-graph-reset
          >
            <Minimize2 className='h-3.5 w-3.5' />
            Collapse all
          </button>
        )}
      </div>
      <div className='min-h-0 flex-1 overflow-auto p-6'>
        <div className='relative' style={{ width, height }}>
          <svg
            className='pointer-events-none absolute inset-0'
            width={width}
            height={height}
            aria-hidden='true'
          >
            {edges}
          </svg>
          {placed.map((p) =>
            p.t.kind === 'group' ? (
              <GroupBox key={p.t.path} p={p} onToggle={() => toggleFold(p.t.path)} />
            ) : (
              <RecordBox
                key={p.t.path}
                p={p}
                onOpen={() => openRecord((p.t as Extract<TreeNode, { kind: 'record' }>).node)}
                onToggle={() => toggleOpen(p.t.path)}
              />
            )
          )}
        </div>
        {rootHop?.data && rootHop.data.groups.length === 0 && (
          <p className='mt-4 text-sm text-muted-foreground' data-record-graph-empty>
            Nothing you can see is linked to this record.
          </p>
        )}
      </div>
    </div>
  )
}

function RecordBox({
  p,
  onOpen,
  onToggle
}: {
  p: Placed
  onOpen: () => void
  onToggle: () => void
}) {
  const t = p.t as Extract<TreeNode, { kind: 'record' }>
  const canExpand = !t.seen && expandable(t.node.collection)
  const clickable = expandable(t.node.collection)
  return (
    <div
      className={cn(
        'absolute flex items-stretch overflow-hidden rounded-lg border bg-card shadow-sm',
        t.root ? 'border-nvr-cyan ring-2 ring-nvr-cyan/20' : 'border-border',
        t.seen && 'opacity-60'
      )}
      style={{ left: p.x, top: p.y, width: p.w, height: p.h }}
      data-record-graph-node={`${t.node.collection}:${t.node.id}`}
      data-record-graph-root={t.root || undefined}
    >
      <button
        type='button'
        onClick={onOpen}
        disabled={!clickable}
        className={cn(
          'min-w-0 flex-1 px-3 py-1.5 text-left',
          clickable ? 'hover:bg-muted' : 'cursor-default'
        )}
        data-tip={`${t.collectionLabel}: ${t.node.label}${t.seen ? ' (already shown above)' : ''}`}
      >
        <span className='block truncate text-[10px] font-medium uppercase tracking-wide text-muted-foreground'>
          {t.collectionLabel}
        </span>
        <span className='block truncate text-[13px] font-medium text-foreground'>
          {t.node.label}
        </span>
      </button>
      {canExpand && (
        <button
          type='button'
          onClick={onToggle}
          aria-label={t.expanded ? 'Hide what this links to' : 'Show what this links to'}
          aria-expanded={t.expanded}
          className='flex w-8 shrink-0 items-center justify-center border-l border-border text-muted-foreground hover:bg-muted hover:text-foreground'
          data-record-graph-expand
        >
          {t.loading ? (
            <Loader2 className='h-3.5 w-3.5 animate-spin' />
          ) : (
            <ChevronRight
              className={cn('h-4 w-4 transition-transform', t.expanded && 'rotate-180')}
            />
          )}
        </button>
      )}
    </div>
  )
}

function GroupBox({ p, onToggle }: { p: Placed; onToggle: () => void }) {
  const t = p.t as Extract<TreeNode, { kind: 'group' }>
  const g = t.group
  const more = g.total > t.shown
  return (
    <button
      type='button'
      onClick={onToggle}
      className='absolute flex items-center gap-1.5 rounded-full border border-border bg-muted/60 px-3 text-left text-[12px] text-foreground hover:bg-muted'
      style={{ left: p.x, top: p.y, width: p.w, height: p.h }}
      aria-expanded={!t.collapsed}
      data-record-graph-group={g.key}
      data-tip={
        more
          ? `${g.label}: showing the newest ${t.shown} of ${g.total}`
          : `${g.label} (${g.collection_label})`
      }
    >
      <ChevronRight
        className={cn(
          'h-3 w-3 shrink-0 text-muted-foreground transition-transform',
          !t.collapsed && 'rotate-90'
        )}
      />
      <span className='min-w-0 flex-1 truncate font-medium'>{g.label}</span>
      <span className='shrink-0 tabular-nums text-muted-foreground'>
        {more ? `${t.shown} of ${g.total}` : g.total}
      </span>
    </button>
  )
}

/** Right sheet hosting the explorer — hosts mount it beside the record form. */
export function RecordGraphSheet({
  collection,
  itemId,
  open,
  onOpenChange
}: {
  collection: string
  itemId: string
  open: boolean
  onOpenChange: (v: boolean) => void
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side='right'
        className='flex w-[92vw] max-w-[1400px] flex-col gap-0 p-0 sm:max-w-[1400px]'
      >
        <SheetHeader className='shrink-0 border-b border-border px-4 py-3'>
          <SheetTitle className='flex items-center gap-2 text-base'>
            <Waypoints className='h-4 w-4 text-muted-foreground' />
            Relationships
          </SheetTitle>
        </SheetHeader>
        {open && <RecordGraphExplorer collection={collection} itemId={itemId} />}
      </SheetContent>
    </Sheet>
  )
}
