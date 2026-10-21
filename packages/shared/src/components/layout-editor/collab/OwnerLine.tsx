import { UserRound } from 'lucide-react'
import { useLayoutOwners } from './collab-api'

/** The overview row's "Owner: …" line (#2656); nothing when the form has no owner. */
export function OwnerLine({ layoutId }: { layoutId: number }) {
  const { data } = useLayoutOwners()
  const owner = data?.[String(layoutId)]
  if (!owner) return null
  return (
    <div
      data-layout-owner={owner.id}
      className='mt-0.5 flex items-center gap-1 text-[12px] text-slate-500 dark:text-muted-foreground'
    >
      <UserRound className='h-3 w-3 shrink-0' />
      Owner: <span className='text-slate-700 dark:text-foreground'>{owner.name}</span>
    </div>
  )
}
