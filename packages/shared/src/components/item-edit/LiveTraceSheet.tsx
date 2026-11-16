import { LiveTraceView } from '../LiveTraceView'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '../ui/sheet'

/**
 * Admin-only side sheet on a record: "Why didn't this page update?" — what the server sent
 * live for this record, what was written, who was listening. Read-only, no values.
 */
export function LiveTraceSheet({
  collection,
  itemId,
  open,
  onClose
}: {
  collection: string
  itemId: string
  open: boolean
  onClose: () => void
}) {
  return (
    <Sheet open={open} onOpenChange={(next) => !next && onClose()}>
      <SheetContent
        side='right'
        className='w-full overflow-y-auto sm:max-w-2xl'
        data-live-trace-sheet
        // Focus the sheet itself, not the first control: the window picker opened with a heavy
        // ring that read as selected or in error (rt2 review). Keyboard users tab on from here.
        onOpenAutoFocus={(e) => {
          e.preventDefault()
          ;(e.currentTarget as HTMLElement | null)?.focus()
        }}
        tabIndex={-1}
      >
        <SheetHeader>
          <SheetTitle>Why didn't this page update?</SheetTitle>
        </SheetHeader>
        <p className='mt-1 text-[12px] text-slate-500 dark:text-slate-400'>
          What the server sent live for this record, the writes it saw, and who was listening.
        </p>
        {open && <LiveTraceView collection={collection} item={itemId} className='mt-4' />}
      </SheetContent>
    </Sheet>
  )
}
