import { FilePlus2 } from 'lucide-react'
import { cn } from '../../../lib/utils'
import { useFormFromRecord } from './useFormFromRecord'

/** "New form from this record" (#2585) — beside a tested record on the overview. */
export function FormFromRecordButton({
  collection,
  recordId,
  recordLabel,
  onMade,
  className
}: {
  collection: string
  recordId: string | number
  recordLabel: string
  onMade: (layoutId: number) => void
  className?: string
}) {
  const { make, busy, ready } = useFormFromRecord(collection)
  return (
    <button
      type='button'
      data-form-from-record=''
      disabled={busy || !ready}
      data-tip='A new form with one section holding the fields this record has filled in'
      onClick={async () => {
        const id = await make(recordId, recordLabel)
        if (id != null) onMade(id)
      }}
      className={cn(
        'inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-slate-200 bg-white px-2 text-[12px] font-medium text-slate-700 transition-colors hover:bg-slate-50 disabled:opacity-50 dark:border-border dark:bg-card dark:text-foreground dark:hover:bg-muted',
        className
      )}
    >
      <FilePlus2 className='h-3.5 w-3.5' />
      {busy ? 'Making…' : 'New form from this record'}
    </button>
  )
}
