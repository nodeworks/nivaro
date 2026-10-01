import { Check, Link2 } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { getCanvasView, setCanvasView, subscribeCanvasView } from '../canvasView'
import { register } from '../registry/registry'
import { toolbarItems } from '../registry/toolbarItems'
import { viewParams } from '../registry/viewParams'
import { conflictLens } from './conflicts'
import { inferredShown, setInferredShown, subscribeInferred } from './correlations'
import { nodeFeed } from './node-merge'
import { pinsOnlyOn, setPinsOnly, subscribePinsOnly } from './pins'
import { BTN } from './shared'
import { workspaceFocus } from './workspaces'

/**
 * #1166 — whole-view links. Registers the view state other features own (lenses, workspace,
 * node scope, canvas zoom and edges) as URL params, and a "Copy view link" button. Filters,
 * selection and the rewind position are encoded by the page itself (viewUrl.ts).
 */
const cv = getCanvasView
register(viewParams, {
  id: 'zoom',
  param: 'zoom',
  get: () => (cv().zoom === 1 ? null : String(cv().zoom)),
  set: (v) => setCanvasView({ zoom: v === '0' ? 0 : v === '2' ? 2 : 1 }),
  subscribe: subscribeCanvasView
})
register(viewParams, {
  id: 'edge-scale',
  param: 'edges',
  get: () => (cv().scale === 'sqrt' ? null : cv().scale),
  set: (v) => setCanvasView({ scale: v === 'log' || v === 'linear' ? v : 'sqrt' }),
  subscribe: subscribeCanvasView
})
register(viewParams, {
  id: 'edge-labels',
  param: 'rates',
  get: () => (cv().labels ? '1' : null),
  set: (v) => setCanvasView({ labels: v === '1' }),
  subscribe: subscribeCanvasView
})
register(viewParams, {
  id: 'group-apps',
  param: 'group',
  get: () => (cv().groupApps ? (cv().expanded ?? '1') : null),
  set: (v) =>
    setCanvasView({
      groupApps: !!v,
      expanded: v?.startsWith('app:') ? v.slice(0, 40) : null
    }),
  subscribe: subscribeCanvasView
})
register(viewParams, {
  id: 'conflicts',
  param: 'conflicts',
  // the conflicts lens is on by default
  get: () => (conflictLens.get() ? null : '0'),
  set: (v) => conflictLens.set(v !== '0'),
  subscribe: conflictLens.subscribe
})
register(viewParams, {
  id: 'workspace',
  param: 'ws',
  get: () => workspaceFocus.get() || null,
  set: (v) => workspaceFocus.set(v && /^[A-Za-z0-9_-]{1,64}$/.test(v) ? v : ''),
  subscribe: workspaceFocus.subscribe
})
register(viewParams, {
  id: 'node',
  param: 'node',
  get: () => (nodeFeed.scope.mode === 'node' ? nodeFeed.scope.node : null),
  set: (v) => {
    const next =
      v && v.length <= 120 ? { mode: 'node' as const, node: v } : { mode: 'all' as const }
    const cur = nodeFeed.scope
    if (
      cur.mode === next.mode &&
      (cur.mode === 'all' || cur.node === (next as { node?: string }).node)
    )
      return
    nodeFeed.setScope(next)
  },
  subscribe: (fn) => nodeFeed.subscribe(fn)
})
register(viewParams, {
  id: 'pins',
  param: 'pins',
  get: () => (pinsOnlyOn() ? '1' : null),
  set: (v) => setPinsOnly(v === '1'),
  subscribe: subscribePinsOnly
})
register(viewParams, {
  id: 'inferred',
  param: 'inferred',
  get: () => (inferredShown() ? null : '0'),
  set: (v) => setInferredShown(v !== '0'),
  subscribe: subscribeInferred
})

function CopyViewLink() {
  const [copied, setCopied] = useState(false)
  return (
    <button
      type='button'
      id='tm-copy-view'
      className={BTN}
      title='A link that opens exactly this view: filters, selection, lenses, zoom and the rewind position'
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(window.location.href)
          setCopied(true)
          setTimeout(() => setCopied(false), 1500)
        } catch {
          toast.error('Could not copy; the address bar has the link')
        }
      }}
    >
      {copied ? (
        <Check className='h-3.5 w-3.5' aria-hidden='true' />
      ) : (
        <Link2 className='h-3.5 w-3.5' aria-hidden='true' />
      )}
      {copied ? 'Copied' : 'Copy view link'}
    </button>
  )
}

register(toolbarItems, { id: 'copy-view', order: 85, Component: CopyViewLink })
