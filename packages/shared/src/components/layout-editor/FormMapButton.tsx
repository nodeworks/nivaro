import { Map as MapIcon, Printer, X } from 'lucide-react'
import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { LayoutBundle } from '../../lib/layout-ops'
import { modalHostOf } from '../ui/popover'
import { buildFormMap, type FormMapInput, formMapHtml } from './form-map'
import { useCollectionMeta } from './inspector/field-context'
import { LoadError } from './load-error'
import { choiceLabelsFrom } from './overview/describe-conditions'
import { useOverviewFields, useRoleNames } from './overview/overview-api'
import { ToolButton, useBarMenu } from './toolbar-kit'

/**
 * #2617 — the top bar's "Form map": a clean printable diagram of the form
 * (steps → sections → fields, widths, required / read-only marks, rules) in a
 * preview panel with Print / Save as PDF. The page is its own light document
 * inside an iframe, so it prints without the app around it, light in every theme.
 */
export function FormMapButton({
  bundle,
  collection
}: {
  bundle: LayoutBundle | null
  collection: string
}) {
  const [open, setOpen] = useState(false)
  const [marker, setMarker] = useState<HTMLSpanElement | null>(null)
  const trigger = useRef<HTMLButtonElement | null>(null)
  // In the Tools menu, focus goes back to the menu's button.
  const menu = useBarMenu()
  return (
    <>
      <span ref={setMarker} hidden data-form-map-marker='' />
      <ToolButton
        buttonRef={(el) => {
          trigger.current = el
        }}
        label='Form map'
        icon={<MapIcon className='h-3.5 w-3.5' />}
        hint='Print the steps, sections and fields'
        tip='A printable map of the steps, sections and fields'
        disabled={!bundle}
        opensDialog
        onClick={() => setOpen(true)}
        data={{ 'data-form-map-open': '', 'aria-haspopup': 'dialog' }}
      />
      {open &&
        bundle &&
        createPortal(
          <FormMapPanel
            bundle={bundle}
            collection={collection}
            onClose={() => {
              setOpen(false)
              ;(trigger.current ?? menu?.anchor.current)?.focus()
            }}
          />,
          // Inside the editor's overlay dialog when there is one (its focus and
          // scroll lock), else body — fixed under the page outlet would be offset.
          modalHostOf(marker) ?? document.body
        )}
    </>
  )
}

function FormMapPanel({
  bundle,
  collection,
  onClose
}: {
  bundle: LayoutBundle
  collection: string
  onClose: () => void
}) {
  const metaQ = useCollectionMeta(collection)
  const fieldsQ = useOverviewFields(collection)
  const rolesQ = useRoleNames(true)
  const meta = metaQ.data
  const fields = fieldsQ.data ?? []
  const roles = rolesQ.data ?? []
  // A map drawn without the field labels or roles would read as wrong: say it failed.
  const failed = metaQ.isError || fieldsQ.isError || rolesQ.isError
  const retry = () => {
    if (metaQ.isError) void metaQ.refetch()
    if (fieldsQ.isError) void fieldsQ.refetch()
    if (rolesQ.isError) void rolesQ.refetch()
  }
  const frame = useRef<HTMLIFrameElement | null>(null)
  const panel = useRef<HTMLDivElement | null>(null)
  const html = useMemo(() => {
    const map = buildFormMap({
      bundle,
      collectionLabel: meta?.label || collection,
      fields: fields as FormMapInput['fields'],
      roles,
      choiceLabels: choiceLabelsFrom(fields)
    })
    return formMapHtml(map)
  }, [bundle, meta?.label, collection, fields, roles])

  useEffect(() => panel.current?.focus(), [])

  // Escape closes the map, not the editor behind it.
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Escape') return
    e.preventDefault()
    e.stopPropagation()
    onClose()
  }

  return (
    <div
      ref={panel}
      role='dialog'
      aria-modal='true'
      aria-label='Form map'
      tabIndex={-1}
      data-form-map=''
      onKeyDown={onKeyDown}
      className='fixed inset-0 z-[120] flex flex-col bg-[#0f172a]/40 outline-none dark:bg-black/60'
    >
      <div className='flex shrink-0 items-center gap-2 border-b border-slate-200 bg-white px-4 py-2 dark:border-border dark:bg-card'>
        <MapIcon className='h-4 w-4 text-slate-500 dark:text-muted-foreground' />
        <h2 className='m-0 min-w-0 flex-1 truncate text-[14px] font-semibold text-slate-900 dark:text-foreground'>
          Form map · {String(bundle.layout.name ?? '')}
        </h2>
        <span className='hidden text-[12px] text-slate-500 sm:inline dark:text-muted-foreground'>
          Choose “Save as PDF” in the print dialog for a file.
        </span>
        <button
          type='button'
          data-form-map-print=''
          disabled={failed}
          onClick={() => frame.current?.contentWindow?.print()}
          className='inline-flex h-8 items-center gap-1.5 rounded-md bg-nvr-cyan px-3 text-[12px] font-medium text-white transition-colors hover:bg-[#00b8e0] disabled:opacity-40'
        >
          <Printer className='h-3.5 w-3.5' />
          Print / Save as PDF
        </button>
        <button
          type='button'
          aria-label='Close the form map'
          onClick={onClose}
          className='inline-flex h-8 w-8 items-center justify-center rounded-md text-slate-500 transition-colors hover:bg-muted hover:text-slate-800 dark:text-muted-foreground dark:hover:text-foreground'
        >
          <X className='h-4 w-4' />
        </button>
      </div>
      <div className='min-h-0 flex-1 overflow-hidden p-4 sm:p-6'>
        {failed ? (
          <div className='mx-auto max-w-[900px] rounded-md border border-slate-200 bg-white p-4 dark:border-border dark:bg-card'>
            <LoadError what='the field labels and roles for the map' onRetry={retry} />
          </div>
        ) : (
          // The page itself is always light: it is paper.
          <iframe
            ref={frame}
            title='Form map preview'
            srcDoc={html}
            // No scripts ever run in the map (it holds field labels and rule
            // text). allow-same-origin lets Print reach contentWindow.print();
            // allow-modals lets that print dialog open. Checked in Chrome.
            sandbox='allow-same-origin allow-modals'
            data-form-map-frame=''
            className='mx-auto block h-full w-full max-w-[900px] rounded-md border border-slate-300 bg-white shadow-lg dark:border-border'
          />
        )}
      </div>
    </div>
  )
}
