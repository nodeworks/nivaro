import { Download } from 'lucide-react'
import { useState } from 'react'
import { useApiFetchConfig } from '../../../context'
import { Popover, PopoverContent, PopoverTrigger } from '../../ui/popover'
import type { DownloadUrls } from '../types'

// Download to the desktop. The server decides which file a link hands over
// (the current render, or the original only when nothing is hidden) and
// whether this person may download at all; this only offers the links.

export type DownloadChoice = { key: string; label: string; hint: string; href: string }

/** The files on offer, in order. `original` adds the author-only original
 *  recording (`source=1`). */
export function downloadChoices(urls: DownloadUrls, opts: { original?: boolean } = {}) {
  const out: DownloadChoice[] = [{ key: 'video', label: 'Video', hint: '', href: urls.video }]
  if (opts.original) {
    out.push({
      key: 'original',
      label: 'Original recording',
      hint: 'Uncut, nothing blurred',
      href: `${urls.video}&source=1`
    })
  }
  if (urls.captions_vtt) {
    out.push({ key: 'vtt', label: 'Captions', hint: '.vtt', href: urls.captions_vtt })
  }
  if (urls.captions_srt) {
    out.push({ key: 'srt', label: 'Captions', hint: '.srt', href: urls.captions_srt })
  }
  return out
}

const row =
  'flex w-full items-center justify-between gap-3 rounded-sm px-2.5 py-1.5 text-left text-[13px] text-foreground transition-colors duration-150 hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-nvr-cyan motion-reduce:transition-none'

export function DownloadMenu({
  urls,
  ready = true,
  original = false,
  variant = 'button',
  label = 'Download',
  where,
  triggerClassName
}: {
  urls: DownloadUrls
  /** False while a viewer would get "still being prepared". */
  ready?: boolean
  original?: boolean
  variant?: 'icon' | 'button'
  label?: string
  /** data-hv-download value: where the control sits (player, sheet, versions). */
  where: string
  triggerClassName?: string
}) {
  const { apiBase } = useApiFetchConfig()
  const origin = apiBase.replace(/\/api$/, '')
  const [open, setOpen] = useState(false)
  const choices = downloadChoices(urls, { original })

  if (!ready) {
    if (variant === 'icon') return null
    return (
      <span
        className='inline-flex items-center gap-1.5 text-[12px] text-muted-foreground'
        data-hv-download={where}
        data-hv-download-waiting=''
      >
        <Download className='h-3.5 w-3.5' aria-hidden />
        It can be downloaded once it's ready.
      </span>
    )
  }

  const trigger =
    variant === 'icon' ? (
      <>
        <Download className='h-4 w-4' aria-hidden />
        <span className='sr-only'>{label}</span>
      </>
    ) : (
      <>
        <Download className='h-3.5 w-3.5' aria-hidden />
        {label}
      </>
    )
  const triggerCls =
    triggerClassName ??
    'inline-flex h-8 items-center gap-1.5 rounded-md border border-input bg-background px-2.5 text-[12.5px] text-foreground transition-colors duration-150 hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan motion-reduce:transition-none'

  // One file only: a plain link, no menu.
  if (choices.length === 1) {
    return (
      <a
        href={`${origin}${choices[0].href}`}
        download
        className={triggerCls}
        aria-label={variant === 'icon' ? label : undefined}
        data-tip={variant === 'icon' ? label : undefined}
        data-hv-download={where}
        data-hv-download-choice='video'
      >
        {trigger}
      </a>
    )
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type='button'
          className={triggerCls}
          aria-label={variant === 'icon' ? label : undefined}
          data-tip={variant === 'icon' ? label : undefined}
          data-hv-download={where}
        >
          {trigger}
        </button>
      </PopoverTrigger>
      <PopoverContent align='end' className='w-60 p-1' data-hv-download-menu={where}>
        <ul className='flex flex-col'>
          {choices.map((c) => (
            <li key={c.key}>
              <a
                href={`${origin}${c.href}`}
                download
                className={row}
                onClick={() => setOpen(false)}
                data-hv-download-choice={c.key}
              >
                <span>{c.label}</span>
                <span className='text-[12px] text-muted-foreground'>{c.hint}</span>
              </a>
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  )
}
