import { Keyboard } from 'lucide-react'
import { Fragment } from 'react'
import { Button } from '../../ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '../../ui/popover'

const GROUPS: Array<{ title: string; keys: Array<[string[], string]> }> = [
  {
    title: 'Anywhere in the editor',
    keys: [
      [['S'], 'Split at the playhead'],
      [['Delete'], 'Cut the selected piece'],
      [['M'], 'Add a chapter at the playhead'],
      [['Esc'], 'Stop drawing'],
      [['Ctrl', 'Z'], 'Undo (⌘Z on a Mac)'],
      [['Shift', 'Ctrl', 'Z'], 'Redo (⇧⌘Z on a Mac)'],
      [['?'], 'Show or hide this list']
    ]
  },
  {
    title: 'When the picture has focus',
    keys: [
      [['Space'], 'Play or pause'],
      [['J', 'L'], 'Back or forward 5 seconds']
    ]
  },
  {
    title: 'On a shape selected on the picture',
    keys: [
      [['Arrows'], 'Move it (Shift: further)'],
      [['Alt', 'Arrows'], 'Resize it (an arrow: move its tip)'],
      [['Delete'], 'Remove it']
    ]
  },
  {
    title: 'On the timeline',
    keys: [
      [['←', '→'], 'Go to the previous or next item'],
      [['Alt', '←', '→'], 'Nudge it 0.1 seconds (Shift: 1 second)'],
      [['Delete'], 'Remove it']
    ]
  }
]

const kbd =
  'inline-flex h-5 min-w-[20px] items-center justify-center rounded border border-border bg-muted px-1 font-mono text-[11px] leading-none text-foreground'

/** The editor's keyboard shortcuts, opened from the toolbar or with ?. */
export function ShortcutsCard({
  open,
  onOpenChange
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <Button
          size='sm'
          variant='ghost'
          className='h-8 w-8 px-0'
          aria-label='Keyboard shortcuts'
          title='Keyboard shortcuts (?)'
          aria-keyshortcuts='?'
          data-hv-shortcuts
        >
          <Keyboard />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align='end'
        className='w-[320px] max-w-[calc(100vw-24px)] space-y-3 p-3'
        data-hv-shortcuts-card
      >
        <h3 className='text-[13px] font-semibold text-foreground'>Keyboard shortcuts</h3>
        {GROUPS.map((g) => (
          <div key={g.title} className='space-y-1.5'>
            <h4 className='text-[12px] font-medium text-muted-foreground'>{g.title}</h4>
            <dl className='grid grid-cols-[7.5rem_1fr] items-center gap-x-3 gap-y-1.5 text-[12.5px]'>
              {g.keys.map(([keys, what]) => (
                <Fragment key={`${g.title}-${what}`}>
                  <dt className='flex items-center gap-0.5'>
                    {keys.map((k) => (
                      <kbd key={k} className={kbd}>
                        {k}
                      </kbd>
                    ))}
                  </dt>
                  <dd className='text-foreground'>{what}</dd>
                </Fragment>
              ))}
            </dl>
          </div>
        ))}
      </PopoverContent>
    </Popover>
  )
}
