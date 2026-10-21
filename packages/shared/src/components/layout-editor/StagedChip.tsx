import { PencilLine } from 'lucide-react'
import { formatRelative } from '../../lib/utils'
import type { StagedOther } from './staged-api'

/**
 * Who else has unsaved changes staged on this layout (#2589), beside the
 * presence avatars: names and counts, never the changes. A Save by anyone
 * leaves the others' drafts to be folded onto the new layout when they return.
 */
export function StagedByOthers({ others }: { others: StagedOther[] }) {
  if (others.length === 0) return null
  const changes = (o: StagedOther) =>
    `${o.step_count} unsaved ${o.step_count === 1 ? 'change' : 'changes'}`
  const lines = others.map((o) => `${o.name}: ${changes(o)}, ${formatRelative(o.saved_at)}`)
  const label =
    others.length === 1
      ? `${others[0].name.split(' ')[0]} is drafting`
      : `${others.length} people are drafting`
  return (
    <span
      data-staged-others={others.length}
      data-tip={`${lines.join(' · ')}. Only they see those changes until they save.`}
      className='inline-flex h-6 shrink-0 items-center gap-1 whitespace-nowrap rounded-full bg-slate-100 px-2 text-[11px] font-medium text-slate-600 dark:bg-muted dark:text-muted-foreground'
    >
      <PencilLine className='h-3 w-3' />
      {label}
    </span>
  )
}
