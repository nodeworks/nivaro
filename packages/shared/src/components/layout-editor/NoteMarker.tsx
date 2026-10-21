import { StickyNote } from 'lucide-react'
import { useState } from 'react'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'
import { type EditorNote, noteByline } from './editor-notes'

/**
 * #2608 — the sticky-note marker on a canvas node that carries an editor
 * note. A click selects the node (DesignNode, data-design-pass lets the click
 * through) and opens the note beside it; the note is edited in the inspector.
 */
export function NoteMarker({ note }: { note: EditorNote }) {
  const [open, setOpen] = useState(false)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type='button'
          data-design-pass=''
          data-editor-note-marker=''
          aria-label='Note for editors'
          data-tip={note.text.length > 80 ? `${note.text.slice(0, 80)}…` : note.text}
          className='absolute -top-2 left-1 z-20 inline-flex h-5 w-5 items-center justify-center rounded bg-amber-100 text-amber-700 shadow-sm ring-1 ring-amber-300 transition-colors hover:bg-amber-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan dark:bg-amber-500/20 dark:text-amber-200 dark:ring-amber-500/40 dark:hover:bg-amber-500/30'
        >
          <StickyNote aria-hidden className='h-3 w-3' />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align='start'
        side='top'
        className='w-[280px] space-y-2 border-amber-200 bg-amber-50 p-3 dark:border-amber-500/30 dark:bg-[#2a2414]'
      >
        <p className='whitespace-pre-wrap text-[12.5px] leading-snug text-slate-800 dark:text-amber-50'>
          {note.text}
        </p>
        <p className='text-[11.5px] text-slate-500 dark:text-amber-200/70'>{noteByline(note)}</p>
        <p className='text-[11.5px] text-slate-500 dark:text-amber-200/70'>
          Only people editing this form see this note.
        </p>
      </PopoverContent>
    </Popover>
  )
}
