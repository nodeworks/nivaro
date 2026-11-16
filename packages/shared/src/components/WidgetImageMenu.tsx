import { Download, ImageIcon, Loader2, MoreHorizontal } from 'lucide-react'
import { useRef, useState } from 'react'
import { toast } from 'sonner'
import { toastError } from '../lib/error-toast'
import { cn } from '../lib/utils'
import {
  buildWidgetImageLabel,
  type WidgetImageInput,
  type WidgetImageLabel,
  widgetImageFileName
} from '../lib/widget-image'
import {
  copyPngOrSave,
  downloadBlob,
  renderWidgetImage,
  WIDGET_IMAGE_IGNORE_ATTR
} from '../lib/widget-image-render'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from './ui/dropdown-menu'

/**
 * The ⋯ menu on a dashboard / report widget: "Copy as image" and "Download
 * PNG". The picture is the widget as it is on screen, in the light theme on
 * white, with the title, "As of <time>" and the filters in effect printed on
 * top — ready for an email or Teams message.
 *
 * `getTarget` returns the widget card element; the host marks its own chrome
 * (title row, buttons) with `data-widget-image-ignore` so it is left out.
 * `label` is read when the item is chosen, so it always carries the filters
 * in effect right then.
 */
export function WidgetImageMenu({
  getTarget,
  label,
  className,
  align = 'end',
  loading
}: {
  getTarget: () => HTMLElement | null
  label: WidgetImageInput | (() => WidgetImageInput)
  className?: string
  align?: 'start' | 'center' | 'end'
  /** The host knows its widget is (re)loading: the picture would show a spinner. */
  loading?: boolean
}) {
  const [busy, setBusy] = useState(false)
  const [notReady, setNotReady] = useState(false)
  const lock = useRef(false)
  const waiting = loading || notReady

  const resolveLabel = (): WidgetImageLabel =>
    buildWidgetImageLabel(typeof label === 'function' ? label() : label)

  const run = (mode: 'copy' | 'download') => {
    const el = getTarget()
    if (!el || lock.current) return
    lock.current = true
    setBusy(true)
    const made = resolveLabel()
    const fileName = widgetImageFileName(made.title)
    const png = renderWidgetImage(el, made)
    const done = () => {
      lock.current = false
      setBusy(false)
    }
    if (mode === 'copy') {
      copyPngOrSave(png, fileName)
        .then((r) => {
          if (r === 'copied') toast.success('Copied the picture. Paste it into an email or Teams.')
          else toast.info(`Your browser would not copy a picture, so it was saved as ${fileName}.`)
        })
        .catch((err) => toastError(err, 'Could not make the picture.'))
        .finally(done)
    } else {
      png
        .then((blob) => {
          downloadBlob(blob, fileName)
          toast.success('Saved the picture.')
        })
        .catch((err) => toastError(err, 'Could not make the picture.'))
        .finally(done)
    }
  }

  return (
    <DropdownMenu onOpenChange={(open) => open && setNotReady(widgetIsLoading(getTarget()))}>
      <DropdownMenuTrigger asChild>
        <button
          type='button'
          {...{ [WIDGET_IMAGE_IGNORE_ATTR]: '' }}
          aria-label='Widget options'
          data-tip='Copy or save as a picture'
          disabled={busy}
          className={cn(
            // The hit area reaches past the 24 px glyph box (finger-sized on a phone) without
            // changing its look.
            'relative inline-flex h-6 w-6 items-center before:absolute before:-inset-1 justify-center rounded text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan disabled:opacity-60 data-[state=open]:bg-slate-100 data-[state=open]:text-slate-700 dark:text-slate-500 dark:hover:bg-white/[0.06] dark:hover:text-slate-200 dark:data-[state=open]:bg-white/[0.08] dark:data-[state=open]:text-slate-200',
            className
          )}
        >
          {busy ? (
            <Loader2 className='h-3.5 w-3.5 animate-spin' aria-hidden />
          ) : (
            <MoreHorizontal className='h-3.5 w-3.5' aria-hidden />
          )}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align={align} className='min-w-[170px]'>
        <DropdownMenuItem
          disabled={waiting}
          onSelect={() => run('copy')}
          className='gap-2 text-[12.5px]'
        >
          <ImageIcon className='h-3.5 w-3.5' aria-hidden />
          Copy as image
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={waiting}
          onSelect={() => run('download')}
          className='gap-2 text-[12.5px]'
        >
          <Download className='h-3.5 w-3.5' aria-hidden />
          Download PNG
        </DropdownMenuItem>
        {waiting && (
          <p
            className='flex items-center gap-1.5 px-2 pb-1 pt-1.5 text-[11.5px] text-muted-foreground'
            data-widget-image-wait
          >
            <Loader2 className='h-3 w-3 animate-spin' aria-hidden />
            Wait for the widget to load
          </p>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** A spinner, skeleton or busy region in the widget body (its own chrome left out): a picture
 *  taken now would show the loading state, not the figure. */
export function widgetIsLoading(el: HTMLElement | null): boolean {
  if (!el) return false
  const nodes = el.querySelectorAll<HTMLElement>(
    '[aria-busy="true"], .animate-spin, .animate-pulse'
  )
  for (const n of Array.from(nodes)) {
    if (!n.closest(`[${WIDGET_IMAGE_IGNORE_ATTR}]`)) return true
  }
  return false
}
