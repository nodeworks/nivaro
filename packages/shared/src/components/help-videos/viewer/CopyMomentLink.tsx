import { Link2 } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { useNavigation } from '../../../context'
import { Popover, PopoverContent, PopoverTrigger } from '../../ui/popover'
import { formatDuration } from './format'
import { momentLink } from './moments'

// "Copy link" (#1501): a link to the video at the current time, at the chapter
// playing now, or from the start. Links open the host's videos page with
// ?watch=<id>&t=<seconds> (&c=<chapter>), the contract every host reads.

const row =
  'flex w-full items-center justify-between gap-3 rounded-sm px-2.5 py-1.5 text-left text-[13px] text-foreground transition-colors duration-150 hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-nvr-cyan motion-reduce:transition-none'

async function copy(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
    toast.success('Link copied')
  } catch {
    // Clipboard refused (no permission, insecure origin): show the link to copy by hand.
    toast(text, { description: 'Copy this link', duration: 15_000 })
  }
}

export function CopyMomentLink({
  videoId,
  chapters,
  currentMs
}: {
  videoId: string
  chapters: Array<{ id: string; title: string; edited_ms: number }>
  /** The player's position now (edited time), read when the menu opens. */
  currentMs: () => number
}) {
  const nav = useNavigation()
  const [open, setOpen] = useState(false)
  const [at, setAt] = useState(0)
  const origin = typeof window === 'undefined' ? '' : window.location.origin
  const path = nav.helpVideosPath ?? '/help-videos'
  let chapter: (typeof chapters)[number] | null = null
  for (const c of chapters) if (c.edited_ms <= at) chapter = c
  const options = [
    ...(at >= 1000
      ? [
          {
            key: 'now',
            label: 'At the current time',
            hint: formatDuration(Math.floor(at / 1000) * 1000),
            url: momentLink(origin, path, videoId, { atMs: at })
          }
        ]
      : []),
    ...(chapter
      ? [
          {
            key: 'chapter',
            label: `Chapter: ${chapter.title}`,
            hint: formatDuration(chapter.edited_ms),
            url: momentLink(origin, path, videoId, {
              atMs: chapter.edited_ms,
              chapterId: chapter.id
            })
          }
        ]
      : []),
    { key: 'start', label: 'From the start', hint: '', url: momentLink(origin, path, videoId) }
  ]
  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        if (o) setAt(Math.max(0, currentMs()))
        setOpen(o)
      }}
    >
      <PopoverTrigger asChild>
        <button
          type='button'
          className='inline-flex h-8 items-center gap-1.5 rounded-md border border-input bg-background px-2.5 text-[12.5px] text-foreground transition-colors duration-150 hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan motion-reduce:transition-none'
          data-hv-copy-link
        >
          <Link2 className='h-3.5 w-3.5' aria-hidden />
          Copy link
        </button>
      </PopoverTrigger>
      <PopoverContent align='end' className='w-72 p-1' data-hv-copy-link-menu>
        <ul className='flex flex-col'>
          {options.map((o) => (
            <li key={o.key}>
              <button
                type='button'
                className={row}
                onClick={() => {
                  setOpen(false)
                  void copy(o.url)
                }}
                data-hv-copy-link-choice={o.key}
                data-hv-copy-link-url={o.url}
              >
                <span className='min-w-0 truncate'>{o.label}</span>
                <span className='shrink-0 text-[12px] tabular-nums text-muted-foreground'>
                  {o.hint}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  )
}
