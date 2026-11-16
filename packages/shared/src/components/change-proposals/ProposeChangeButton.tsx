import { GitPullRequestArrow } from 'lucide-react'
import { useState } from 'react'
import { useRecordProposals } from './ChangeProposalsPanel'
import { ProposeChangeDialog } from './ProposeChangeDialog'

/**
 * "Propose change" beside Request help on a record locked after approval, on
 * a collection with proposals turned on. Renders nothing unless the server
 * says this person may propose here (and there is a field they could change).
 */
export function ProposeChangeButton({
  collection,
  itemId,
  enabled,
  recordLabel
}: {
  collection: string
  itemId: string | null
  enabled: boolean
  recordLabel?: string | null
}) {
  const { data } = useRecordProposals(collection, itemId, enabled)
  const [open, setOpen] = useState(false)
  if (!data?.enabled || !data.can_propose || !itemId) return null
  return (
    <>
      <button
        type='button'
        data-tip='Suggest new values — the owners of this step accept or decline them'
        data-propose-change-button
        onClick={() => setOpen(true)}
        // Outline like Request help beside it: a tinted fill read as a toggled-on button.
        className='inline-flex h-9 shrink-0 items-center gap-1.5 rounded-md border border-input bg-background px-3 text-sm font-medium shadow-sm transition-colors hover:bg-accent hover:text-accent-foreground'
      >
        <GitPullRequestArrow
          className='h-3.5 w-3.5 text-[#0e7490] dark:text-[#67e8f9]'
          aria-hidden
        />
        Propose change
      </button>
      <ProposeChangeDialog
        open={open}
        onOpenChange={setOpen}
        collection={collection}
        item={itemId}
        recordLabel={recordLabel}
        step={data.step}
        fields={data.fields ?? []}
      />
    </>
  )
}
