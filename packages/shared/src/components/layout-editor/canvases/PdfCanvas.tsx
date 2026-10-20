import { useState } from 'react'
import { useApiFetchConfig } from '../../../context'
import { type GroupRow, type LayoutBundle, UNGROUPED_KEY } from '../../../lib/layout-ops'
import { titleCase } from '../../../lib/utils'
import { DesignNode } from '../DesignNode'
import { useLayoutDesign } from '../design-context'

// A file (PDF) layout shown the way the generated document groups it: one
// section per group, one cell per placement. The PDF never renders tabs,
// widgets or slot cards, so this is a light renderer rather than the record
// form in design mode (which would draw those and need live field data).

export interface PdfCanvasProps {
  bundle: LayoutBundle
  collection: string
}

const isSlotKey = (f: string) => f.startsWith('__')

export function PdfCanvas({ bundle, collection }: PdfCanvasProps) {
  const design = useLayoutDesign()
  const showHidden = design?.showHidden ?? false
  const sections: GroupRow[] = bundle.groups
    .filter((g) => g.key !== UNGROUPED_KEY && g.type !== 'ungrouped')
    .sort((a, b) => a.sort - b.sort)
  const fetchCfg = useApiFetchConfig()
  const [loading, setLoading] = useState(false)
  const [failed, setFailed] = useState(false)

  // The route is admin-only and the host may auth with a bearer token, so a
  // plain link cannot carry it: fetch with the host's config, open the blob.
  // The tab opens first so the click's popup allowance is not lost to the await.
  const preview = async () => {
    setLoading(true)
    setFailed(false)
    const tab = window.open('', '_blank')
    try {
      const resp = await fetch(
        `${fetchCfg.apiBase}/collection-layouts/${bundle.layout.id}/preview-html`,
        { headers: fetchCfg.authHeaders, credentials: fetchCfg.credentials }
      )
      if (!resp.ok) throw new Error(String(resp.status))
      const url = URL.createObjectURL(new Blob([await resp.text()], { type: 'text/html' }))
      if (tab) tab.location.href = url
      else window.open(url, '_blank')
      setTimeout(() => URL.revokeObjectURL(url), 60_000)
    } catch {
      tab?.close()
      setFailed(true)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className='flex flex-col gap-4 p-4' data-pdf-canvas={collection}>
      <div className='flex items-center justify-between gap-3'>
        <p className='text-[12px] text-slate-500 dark:text-slate-400'>
          Each section below becomes a section in the PDF, in this order.
        </p>
        <div className='flex items-center gap-2'>
          {failed && (
            <span className='text-[12px] text-red-600 dark:text-red-400'>
              Could not build the preview.
            </span>
          )}
          <button
            type='button'
            data-pdf-preview=''
            data-design-pass=''
            disabled={loading}
            onClick={preview}
            className='rounded-md bg-nvr-cyan px-3 py-1.5 text-[12px] font-medium text-white disabled:opacity-60'
          >
            Preview with sample values
          </button>
        </div>
      </div>
      {sections.map((g) => {
        const cells = bundle.placements
          .filter((p) => p.group_key === g.key && !isSlotKey(p.field))
          .filter((p) => p.is_visible || showHidden)
          .sort((a, b) => a.sort - b.sort)
        return (
          <DesignNode key={g.key} target={{ kind: 'group', key: g.key }}>
            <section className='rounded-lg border border-slate-200 bg-white dark:border-border dark:bg-card'>
              <h3 className='border-b border-slate-200 px-3 py-2 text-[13px] font-semibold dark:border-border'>
                {g.label}
              </h3>
              <div className='grid grid-cols-1 gap-2 p-3 sm:grid-cols-2'>
                {cells.length === 0 && (
                  <p className='text-[12px] text-slate-500 dark:text-slate-400'>No fields yet.</p>
                )}
                {cells.map((p) => (
                  <DesignNode
                    key={`${p.field}:${p.group_key}`}
                    target={{ kind: 'field', field: p.field, group_key: p.group_key }}
                  >
                    <div
                      className={`rounded-md border border-slate-200 px-3 py-2 dark:border-border ${
                        p.is_visible ? '' : 'opacity-50'
                      }`}
                    >
                      <div className='text-[11px] text-slate-500 dark:text-slate-400'>
                        {p.label_override ?? titleCase(p.field)}
                      </div>
                      <div className='h-4 rounded bg-slate-100 dark:bg-slate-800' />
                    </div>
                  </DesignNode>
                ))}
              </div>
            </section>
          </DesignNode>
        )
      })}
    </div>
  )
}
