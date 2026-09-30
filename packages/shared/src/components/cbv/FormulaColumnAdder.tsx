import { useState } from 'react'
import { validateExpression } from '../../lib/expression'

/**
 * #644 — "＋ Formula column" in the collection browser's Columns picker.
 * `{{amount}} - {{allocated_total}}` over the row's own fields (a dotted
 * `{{project.budget}}` reads a related value), the same expression engine the
 * grid's formula columns use. The column lives in the view: save the view to
 * keep it. Display only — it is computed per row on the page.
 */
export function FormulaColumnAdder({
  fields,
  onAdd
}: {
  fields: string[]
  onAdd: (label: string, formula: string) => void
}) {
  const [label, setLabel] = useState('')
  const [formula, setFormula] = useState('')
  const check = formula.trim() ? validateExpression(formula, fields) : null
  const canAdd = !!label.trim() && !!check?.ok
  return (
    <div className='space-y-1 px-1.5 pb-1' data-cbv-formula-adder>
      <input
        value={label}
        onChange={(e) => setLabel(e.target.value)}
        placeholder='Column name, e.g. Left to allocate'
        aria-label='Formula column name'
        className='h-7 w-full rounded border border-slate-200 bg-white px-2 text-[12px] dark:border-slate-700 dark:bg-slate-900'
      />
      <input
        value={formula}
        onChange={(e) => setFormula(e.target.value)}
        placeholder='{{amount}} - {{allocated_total}}'
        aria-label='Formula'
        spellCheck={false}
        className='h-7 w-full rounded border border-slate-200 bg-white px-2 font-mono text-[11.5px] dark:border-slate-700 dark:bg-slate-900'
      />
      {check && !check.ok && (
        <p className='text-[11px] text-red-600 dark:text-red-400' data-cbv-formula-error>
          {check.error}
        </p>
      )}
      {check?.ok && check.unknownTokens.length > 0 && (
        <p className='text-[11px] text-amber-700 dark:text-amber-300' data-cbv-formula-unknown>
          Not a field here: {check.unknownTokens.join(', ')}
        </p>
      )}
      <button
        type='button'
        disabled={!canAdd}
        data-cbv-formula-add
        onClick={() => {
          onAdd(label.trim(), formula.trim())
          setLabel('')
          setFormula('')
        }}
        className='h-7 rounded bg-[#00ceff] px-2.5 text-[12px] font-semibold text-white disabled:opacity-40'
      >
        Add formula column
      </button>
    </div>
  )
}
