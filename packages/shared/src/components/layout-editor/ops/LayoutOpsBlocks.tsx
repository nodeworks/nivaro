import { ChevronRight } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { cn } from '../../../lib/utils'
import { labelText } from '../panel-style'
import { quietText } from '../settings/controls'
import { ChangeRequestsPanel } from './ChangeRequestsPanel'
import { DependencyDiagram } from './DependencyDiagram'
import { useChangeRequests } from './ops-api'
import { PromotePanel } from './PromotePanel'

/**
 * Form settings → Tools: changes people suggested for this form (#2609), what
 * relies on it (#2613) and comparing it with another environment (#2593).
 * Each opens in place; the suggestions open by themselves when there are
 * some, and when they could not be read (so the failure is seen, not an
 * empty count).
 */
export function LayoutOpsBlocks({
  collection,
  layoutId,
  name
}: {
  collection: string
  layoutId: number
  name: string
}) {
  const { data: requests = [], isError } = useChangeRequests(collection)
  const mine = requests.filter((r) => r.layout_id === layoutId).length
  return (
    <>
      <Block
        id='change_requests'
        label='Suggested changes · from people'
        count={mine}
        effect='What people asked to change on this form, from a record’s More menu.'
        defaultOpen={mine > 0 || isError}
      >
        <ChangeRequestsPanel collection={collection} layoutId={layoutId} />
      </Block>
      <Block
        id='dependencies'
        label='What relies on this form'
        effect='Queues, grids, links, forms, files and extension code that open this form.'
      >
        <DependencyDiagram layoutId={layoutId} compact />
      </Block>
      <Block
        id='promote'
        label='Compare with another environment'
        effect='Bring another environment’s copy of this form here, after seeing what changes.'
      >
        <PromotePanel layoutId={layoutId} layoutName={name} />
      </Block>
    </>
  )
}

function Block({
  id,
  label,
  effect,
  count,
  defaultOpen,
  children
}: {
  id: string
  label: string
  effect: string
  count?: number
  defaultOpen?: boolean
  children: ReactNode
}) {
  const [open, setOpen] = useState(!!defaultOpen)
  // The count arrives after the first render: open once when there turn out to be some.
  const [autoOpened, setAutoOpened] = useState(false)
  if (defaultOpen && !open && !autoOpened) {
    setAutoOpened(true)
    setOpen(true)
  }
  return (
    <div data-layout-tool={id} className='space-y-1.5'>
      <button
        type='button'
        aria-expanded={open}
        onClick={() => {
          setAutoOpened(true)
          setOpen((o) => !o)
        }}
        className={cn(labelText, 'flex w-full items-center gap-1 text-left')}
      >
        <ChevronRight
          className={cn('h-3.5 w-3.5 shrink-0 transition-transform', open && 'rotate-90')}
        />
        {label}
        {count ? (
          <span
            className='ml-1 rounded-full bg-nvr-cyan/10 px-1.5 text-[11px] font-semibold text-nvr-navy dark:text-nvr-cyan'
            data-count
          >
            {count}
          </span>
        ) : null}
      </button>
      {open ? children : <p className={quietText}>{effect}</p>}
    </div>
  )
}
