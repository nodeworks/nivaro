import { useState } from 'react'
import { formatNumber } from '@/lib/utils'

// ─── Estimated-plan viewer ──────────────────────────────────────────────────
// ShowPlanXML → readable operator tree: cost %, rows, objects, warnings and
// missing-index suggestions, with the raw XML behind a toggle.

interface PlanOp {
  depth: number
  physical: string
  logical: string
  object: string | null
  rows: number
  cost: number
  warnings: string[]
}

function parsePlan(xml: string): {
  statements: Array<{
    text: string
    estRows: number
    subtreeCost: number
    warnings: string[]
    missingIndexes: string[]
    ops: PlanOp[]
  }>
} | null {
  try {
    const doc = new DOMParser().parseFromString(xml, 'text/xml')
    if (doc.querySelector('parsererror')) return null
    const statements: Array<{
      text: string
      estRows: number
      subtreeCost: number
      warnings: string[]
      missingIndexes: string[]
      ops: PlanOp[]
    }> = []
    for (const st of doc.querySelectorAll('StmtSimple, StmtCond, StmtCursor')) {
      const ops: PlanOp[] = []
      const walk = (el: Element, depth: number) => {
        for (const child of el.children) {
          if (child.tagName === 'RelOp') {
            const obj = child.querySelector(':scope > * > Object')
            const objName = obj
              ? [obj.getAttribute('Table'), obj.getAttribute('Index')]
                  .filter(Boolean)
                  .join(' · ')
                  .replace(/[[\]]/g, '')
              : null
            const warns = [...child.querySelectorAll(':scope > Warnings > *')].map(
              (w) =>
                w.tagName +
                (w.getAttribute('ConvertIssue') ? `: ${w.getAttribute('ConvertIssue')}` : '')
            )
            ops.push({
              depth,
              physical: child.getAttribute('PhysicalOp') ?? '?',
              logical: child.getAttribute('LogicalOp') ?? '',
              object: objName,
              rows: Number(child.getAttribute('EstimateRows') ?? 0),
              cost: Number(child.getAttribute('EstimatedTotalSubtreeCost') ?? 0),
              warnings: warns
            })
            walk(child, depth + 1)
          } else {
            walk(child, depth)
          }
        }
      }
      const qp = st.querySelector('QueryPlan')
      if (qp) walk(qp, 0)
      const missing = [...st.querySelectorAll('MissingIndex')].map((mi) => {
        const table = (mi.getAttribute('Table') ?? '').replace(/[[\]]/g, '')
        const cols = (group: string) =>
          [...mi.querySelectorAll(`ColumnGroup[Usage="${group}"] Column`)]
            .map((c) => (c.getAttribute('Name') ?? '').replace(/[[\]]/g, ''))
            .join(', ')
        const eq = cols('EQUALITY')
        const ineq = cols('INEQUALITY')
        const incl = cols('INCLUDE')
        return `${table} (${[eq, ineq].filter(Boolean).join(', ')})${incl ? ` INCLUDE (${incl})` : ''}`
      })
      const stWarnings = [...st.querySelectorAll(':scope > QueryPlan > Warnings > *')].map(
        (w) =>
          w.tagName + (w.getAttribute('ConvertIssue') ? ` (${w.getAttribute('ConvertIssue')})` : '')
      )
      statements.push({
        text: st.getAttribute('StatementText') ?? '',
        estRows: Number(st.getAttribute('StatementEstRows') ?? 0),
        subtreeCost: Number(st.getAttribute('StatementSubTreeCost') ?? 0),
        warnings: stWarnings,
        missingIndexes: missing,
        ops
      })
    }
    return statements.length ? { statements } : null
  } catch {
    return null
  }
}

export function PlanViewer({ xml }: { xml: string }) {
  const [showRaw, setShowRaw] = useState(false)
  const parsed = parsePlan(xml)
  if (!parsed || showRaw) {
    return (
      <div className='space-y-2'>
        {parsed && (
          <button
            type='button'
            onClick={() => setShowRaw(false)}
            className='text-[11.5px] text-nvr-cyan underline decoration-dotted underline-offset-2'
          >
            ← Back to the readable plan
          </button>
        )}
        <pre className='max-h-[60vh] overflow-auto whitespace-pre-wrap rounded-md border border-slate-200 bg-slate-50 p-3 font-mono text-[10.5px] leading-relaxed dark:border-border dark:bg-muted/30'>
          {xml}
        </pre>
      </div>
    )
  }
  return (
    <div className='space-y-4'>
      {parsed.statements.map((st, si) => {
        const total = st.subtreeCost || Math.max(...st.ops.map((o) => o.cost), 0.000001)
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: positional statements
          <div key={si} className='space-y-2'>
            <div className='rounded-md border border-slate-200 bg-slate-50 px-3 py-2 dark:border-border dark:bg-muted/30'>
              <pre className='max-h-24 overflow-auto whitespace-pre-wrap font-mono text-[10.5px] text-slate-600 dark:text-slate-300'>
                {st.text.trim()}
              </pre>
              <p className='mt-1 text-[11px] text-slate-400'>
                Estimated cost {st.subtreeCost.toFixed(4)} · ~{formatNumber(Math.round(st.estRows))}{' '}
                row(s)
              </p>
            </div>
            {st.warnings.length > 0 && (
              <div className='rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-[11.5px] text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300'>
                ⚠ {st.warnings.join(' · ')}
              </div>
            )}
            {st.missingIndexes.length > 0 && (
              <div className='rounded-md border border-sky-200 bg-sky-50 px-3 py-2 text-[11.5px] text-sky-800 dark:border-sky-500/30 dark:bg-sky-500/10 dark:text-sky-300'>
                Missing index suggestion{st.missingIndexes.length > 1 ? 's' : ''}:{' '}
                {st.missingIndexes.join(' · ')}
              </div>
            )}
            <div className='overflow-x-auto rounded-md border border-slate-200 dark:border-border'>
              <table
                className='w-full text-[11.5px]'
                style={{ fontVariantNumeric: 'tabular-nums' }}
              >
                <thead>
                  <tr className='border-b border-slate-100 text-left text-[10px] uppercase tracking-wide text-slate-400 dark:border-border'>
                    <th className='px-3 py-1.5 font-semibold'>Operator</th>
                    <th className='px-3 py-1.5 font-semibold'>Object</th>
                    <th className='px-3 py-1.5 text-right font-semibold'>Est. rows</th>
                    <th className='px-3 py-1.5 text-right font-semibold'>Cost</th>
                    <th className='w-[120px] px-3 py-1.5 font-semibold'>% of total</th>
                  </tr>
                </thead>
                <tbody className='divide-y divide-slate-100 dark:divide-border'>
                  {st.ops.map((op, oi) => {
                    const pct = Math.min(100, (op.cost / total) * 100)
                    const scan = /scan/i.test(op.physical) && !/index seek/i.test(op.physical)
                    return (
                      // biome-ignore lint/suspicious/noArrayIndexKey: positional tree rows
                      <tr key={oi}>
                        <td className='px-3 py-1.5'>
                          <span
                            style={{ paddingLeft: op.depth * 14 }}
                            className='inline-flex items-center gap-1.5'
                          >
                            {op.depth > 0 && (
                              <span className='text-slate-300 dark:text-slate-600'>└</span>
                            )}
                            <span
                              className={
                                scan
                                  ? 'font-medium text-amber-700 dark:text-amber-400'
                                  : 'font-medium'
                              }
                            >
                              {op.physical}
                            </span>
                            {op.logical && op.logical !== op.physical && (
                              <span className='text-slate-400'>({op.logical})</span>
                            )}
                            {op.warnings.length > 0 && (
                              <span className='text-amber-500' title={op.warnings.join(', ')}>
                                ⚠
                              </span>
                            )}
                          </span>
                        </td>
                        <td
                          className='max-w-[260px] truncate px-3 py-1.5 font-mono text-[10.5px] text-slate-500 dark:text-slate-400'
                          title={op.object ?? ''}
                        >
                          {op.object ?? ''}
                        </td>
                        <td className='px-3 py-1.5 text-right'>
                          {formatNumber(Math.round(op.rows))}
                        </td>
                        <td className='px-3 py-1.5 text-right'>{op.cost.toFixed(4)}</td>
                        <td className='px-3 py-1.5'>
                          <div className='flex items-center gap-1.5'>
                            <div className='h-1.5 w-full max-w-[70px] overflow-hidden rounded-full bg-slate-100 dark:bg-muted'>
                              <div
                                className={
                                  pct > 50
                                    ? 'h-full bg-red-400'
                                    : pct > 20
                                      ? 'h-full bg-amber-400'
                                      : 'h-full bg-nvr-cyan'
                                }
                                style={{ width: `${pct}%` }}
                              />
                            </div>
                            <span className='w-9 text-right text-[10.5px] text-slate-400'>
                              {pct.toFixed(0)}%
                            </span>
                          </div>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )
      })}
      <button
        type='button'
        onClick={() => setShowRaw(true)}
        className='text-[11.5px] text-slate-400 underline decoration-dotted underline-offset-2 hover:text-slate-600 dark:hover:text-slate-200'
      >
        View raw ShowPlan XML
      </button>
    </div>
  )
}
