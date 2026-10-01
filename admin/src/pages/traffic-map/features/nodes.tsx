import { useSyncExternalStore } from 'react'
import { SimpleSelect } from '@/components/ui/simple-select'
import { register } from '../registry/registry'
import { toolbarItems } from '../registry/toolbarItems'
import { nodeFeed } from './node-merge'
import { useFrozenSnapshotId } from './snapshots'

/**
 * #1098 — Nodes: every API process combined (default) or one process. Shown only once more than
 * one process is sending frames (or a single one was picked), so a one-node deployment sees
 * nothing new. The page routes frames and snapshot URLs through `nodeFeed`.
 */
let version = 0
nodeFeed.subscribe(() => {
  version++
})
function useNodes(): { nodes: string[]; scope: typeof nodeFeed.scope } {
  useSyncExternalStore(
    (cb) => nodeFeed.subscribe(cb),
    () => version
  )
  return { nodes: nodeFeed.nodes(), scope: nodeFeed.scope }
}

export function nodeLabel(node: string, self: string): string {
  return node === self ? `${node} · this node` : node
}

export function NodeScopeControl() {
  const { nodes, scope } = useNodes()
  const frozen = useFrozenSnapshotId()
  if (frozen || (nodes.length < 2 && scope.mode === 'all')) return null
  const value = scope.mode === 'all' ? '' : scope.node
  const options = [
    { value: '', label: `All nodes (${nodes.length})` },
    ...nodes.map((n) => ({ value: n, label: nodeLabel(n, nodeFeed.self) }))
  ]
  if (value && !nodes.includes(value)) options.push({ value, label: `${value} · not sending` })
  return (
    <div className='flex items-center gap-1.5'>
      <label htmlFor='tm-nodes' className='mr-0.5 text-[12px] font-medium text-[var(--tm-muted)]'>
        Nodes
      </label>
      <SimpleSelect
        value={value}
        onChange={(v) => nodeFeed.setScope(v ? { mode: 'node', node: v } : { mode: 'all' })}
        options={options}
        triggerProps={{ id: 'tm-nodes', 'data-tm-nodes': String(nodes.length) }}
        className='h-7 min-w-[150px] max-w-[220px] border-[var(--tm-line)] bg-[var(--tm-card)] px-2.5 text-[12px] text-[var(--tm-fg-2)]'
      />
    </div>
  )
}

register(toolbarItems, { id: 'nodes', order: 10, Component: NodeScopeControl })
