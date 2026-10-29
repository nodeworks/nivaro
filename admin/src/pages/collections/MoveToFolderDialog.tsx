import { useQueryClient } from '@tanstack/react-query'
import { Check, Folder, FolderX, Loader2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList
} from '@/components/ui/command'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { moveCollections } from './overview-data'
import type { FolderOption } from './types'

const NONE = '__none__'

export function MoveToFolderDialog(props: {
  open: boolean
  onOpenChange: (o: boolean) => void
  names: string[]
  folders: FolderOption[]
  onMoved: () => void
}) {
  const { open, onOpenChange, names, folders, onMoved } = props
  const qc = useQueryClient()
  const [choice, setChoice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const n = names.length

  useEffect(() => {
    if (open) setChoice(null)
  }, [open])

  async function confirm() {
    if (choice === null) return
    const target = choice === NONE ? null : (folders.find((f) => f.key === choice) ?? null)
    setBusy(true)
    try {
      await moveCollections(names, target ? target.key : null)
      const what = `${n} ${n === 1 ? 'collection' : 'collections'}`
      toast.success(target ? `Moved ${what} to ${target.label}` : `Moved ${what} out of folders`)
      await qc.invalidateQueries({ queryKey: ['collections'] })
      onOpenChange(false)
      onMoved()
    } catch (e: any) {
      toast.error(e?.response?.data?.errors?.[0]?.message ?? e?.message ?? 'Could not move')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => (busy ? undefined : onOpenChange(o))}>
      <DialogContent className='max-w-md'>
        <DialogHeader>
          <DialogTitle>Move to folder</DialogTitle>
          <DialogDescription>
            Pick a folder for {n} {n === 1 ? 'collection' : 'collections'}.
          </DialogDescription>
        </DialogHeader>
        <Command className='rounded-md border border-slate-200 dark:border-border'>
          <CommandInput placeholder='Search folders…' />
          <CommandList className='max-h-64'>
            <CommandEmpty>No folder matches.</CommandEmpty>
            <CommandGroup>
              <CommandItem value='no folder' onSelect={() => setChoice(NONE)}>
                <FolderX className='mr-2 h-4 w-4 text-slate-400' />
                No folder
                {choice === NONE && <Check className='ml-auto h-4 w-4' />}
              </CommandItem>
              {folders.map((f) => (
                <CommandItem
                  key={f.key}
                  value={`${f.label} ${f.key}`}
                  onSelect={() => setChoice(f.key)}
                >
                  <Folder
                    className='mr-2 h-4 w-4 text-slate-400'
                    style={f.color ? { color: f.color } : undefined}
                  />
                  {f.label}
                  {choice === f.key && <Check className='ml-auto h-4 w-4' />}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
        <DialogFooter>
          <Button variant='ghost' disabled={busy} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={busy || choice === null || n === 0} onClick={confirm}>
            {busy ? <Loader2 className='mr-1.5 h-3.5 w-3.5 animate-spin' /> : null}
            Move {n} {n === 1 ? 'collection' : 'collections'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
