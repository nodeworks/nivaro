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
  previewRecordId?: string | null
  collection: string
}

const hiddenKey = (f: string) => f.startsWith('__')

export function PdfCanvas({ bundle, previewRecordId, collection }: PdfCanvasProps) {
  const design = useLayoutDesign()
  const showHidden = design?.showHidden ?? false
  const sections: GroupRow[] = bundle.groups
    .filter((g) => g.key !== UNGROUPED_KEY && g.type !== 'ungrouped')
    .sort((a, b) => a.sort - b.sort)
  const previewHref = `/api/collection-layouts/${bundle.layout.id}/preview-html?record_id=${encodeURIComponent(
    previewRecordId ?? ''
  )}`

  return (
    <div className='flex flex-col gap-4 p-4' data-pdf-canvas={collection}>
      <div className='flex items-center justify-between gap-3'>
        <p className='text-[12px] text-slate-500 dark:text-slate-400'>
          Each section below becomes a section in the PDF, in this order.
        </p>
        {previewRecordId ? (
          <a
            data-pdf-preview=''
            data-design-pass=''
            href={previewHref}
            target='_blank'
            rel='noreferrer'
            className='rounded-md bg-nvr-cyan px-3 py-1.5 text-[12px] font-medium text-white'
          >
            Preview PDF
          </a>
        ) : (
          <div className='flex items-center gap-2'>
            <span className='text-[12px] text-slate-500 dark:text-slate-400'>
              Pick a preview record to see the PDF.
            </span>
            <button
              type='button'
              data-pdf-preview=''
              disabled
              className='rounded-md bg-slate-200 px-3 py-1.5 text-[12px] font-medium text-slate-500 dark:bg-slate-800 dark:text-slate-400'
            >
              Preview PDF
            </button>
          </div>
        )}
      </div>
      {sections.map((g) => {
        const cells = bundle.placements
          .filter((p) => p.group_key === g.key && !hiddenKey(p.field))
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
