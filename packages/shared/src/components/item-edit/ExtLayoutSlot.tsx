import { useEffect, useRef } from 'react'
import { getLayoutSlot, type LayoutSlotHandle } from '../../lib/layout-slots'

/**
 * Extension layout slot host (#425): mounts a window-registered DOM plugin as
 * a layout section. Resolution happens ONCE at mount (useRef — the hooks-order
 * rule from the field-interface registry applies here too); bundles register
 * during app bootstrap, so mount-time resolution is correct.
 */
export function ExtLayoutSlot({
  slotKey,
  collection,
  itemId,
  draft
}: {
  slotKey: string
  collection: string
  itemId: string | null
  draft: Record<string, unknown>
}) {
  const elRef = useRef<HTMLDivElement>(null)
  const pluginRef = useRef(getLayoutSlot(slotKey))
  const handleRef = useRef<LayoutSlotHandle | void>(undefined)

  useEffect(() => {
    const el = elRef.current
    const plugin = pluginRef.current
    if (!el || !plugin) return
    handleRef.current = plugin.mount(el, { collection, itemId, draft })
    return () => {
      handleRef.current?.destroy?.()
      el.innerHTML = ''
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  useEffect(() => {
    handleRef.current?.update?.({ collection, itemId, draft })
  }, [collection, itemId, draft])

  if (!pluginRef.current) {
    return (
      <div className='rounded-lg border border-dashed border-slate-200 px-4 py-3 text-[12px] text-slate-400 dark:border-border'>
        Extension slot "{slotKey}" — no extension has registered it on this instance.
      </div>
    )
  }
  return <div ref={elRef} data-ext-slot={slotKey} className='rounded-lg border border-slate-200 bg-white p-4 dark:border-border dark:bg-card' />
}
