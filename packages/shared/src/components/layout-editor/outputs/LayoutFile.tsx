import { AlertTriangle, ArrowLeft } from 'lucide-react'
import { useMemo } from 'react'
import type { LayoutBundle, LayoutOp } from '../../../lib/layout-ops'
import { cn, formatRelative } from '../../../lib/utils'
import { canvasDiff, diffSummary } from '../canvas-diff'
import { effectText } from '../panel-style'
import type { ApplyOptions } from '../useLayoutDraft'
import { planFileOps } from './layout-file-plan'
import {
  type FetchConfig,
  type LayoutFileImport,
  LayoutFileProblems,
  parseLayoutFile
} from './output-api'

/**
 * Layout as a file (#3189) in the Outputs popover: what an imported file
 * would change, before anything does. Apply is one undo step on the draft;
 * Save writes it like any other edit.
 */

export interface FileImportState {
  name: string
  result: LayoutFileImport
}

/** Read a chosen file; the preview plans it against the draft. Throws with the API's problems. */
export async function readLayoutFile(
  cfg: FetchConfig,
  bundle: LayoutBundle,
  file: File
): Promise<FileImportState> {
  const text = await file.text()
  const result = await parseLayoutFile(cfg, Number(bundle.layout.id), text)
  return { name: file.name, result }
}

export function problemsOf(e: unknown): string[] {
  return e instanceof LayoutFileProblems ? e.problems : []
}

export function LayoutFilePreview({
  bundle,
  state,
  onBack,
  apply,
  onDone
}: {
  bundle: LayoutBundle
  state: FileImportState
  onBack: () => void
  apply: (ops: LayoutOp[], opts?: ApplyOptions) => void
  onDone: () => void
}) {
  const { result, name } = state
  // Planned against the draft as it is now: an edit while the preview is open is taken in.
  const plan = useMemo(() => planFileOps(bundle, result.target), [bundle, result.target])
  const diff = useMemo(() => canvasDiff(bundle, plan.after), [bundle, plan.after])
  const summary = diffSummary(diff)
  const from = [
    result.source.name ? `from “${result.source.name}”` : null,
    result.source.at ? `exported ${formatRelative(result.source.at)}` : null
  ]
    .filter(Boolean)
    .join(', ')
  return (
    <div data-layout-file-preview=''>
      <button
        type='button'
        onClick={onBack}
        className='mb-1 inline-flex items-center gap-1 text-[12px] font-medium text-sky-700 hover:underline dark:text-nvr-cyan'
      >
        <ArrowLeft className='h-3 w-3' /> Back
      </button>
      <p className='break-words text-[13px] font-semibold text-slate-900 dark:text-foreground'>
        {plan.ops.length === 0
          ? 'Nothing differs from the form'
          : `${name}: ${summary ?? 'changes'}`}
      </p>
      <p className={cn(effectText, 'mt-0.5')}>
        {from ? `${from.charAt(0).toUpperCase()}${from.slice(1)}. ` : ''}
        {plan.ops.length > 0 &&
          'Applying changes the draft as one step (Undo puts it back); Save writes it.'}
      </p>
      {diff.settings.length > 0 && (
        <p className={cn(effectText, 'mt-1.5')} data-layout-file-settings=''>
          Form settings: {diff.settings.join(', ')}
        </p>
      )}
      {(result.warnings.length > 0 || plan.remaining.length > 0) && (
        <ul
          data-layout-file-warnings=''
          className='mt-2 max-h-[200px] space-y-1 overflow-y-auto border-t border-slate-100 pt-2 dark:border-border'
        >
          {[...result.warnings, ...plan.remaining].map((w) => (
            <li
              key={w}
              className='flex items-start gap-1.5 text-[12px] leading-snug text-slate-700 dark:text-foreground'
            >
              <AlertTriangle className='mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600 dark:text-amber-400' />
              <span className='min-w-0 break-words'>{w}</span>
            </li>
          ))}
        </ul>
      )}
      <div className='mt-2 flex items-center justify-end gap-2 border-t border-slate-100 pt-2.5 dark:border-border'>
        <span className={cn(effectText, 'mr-auto')}>
          {plan.ops.length > 0 &&
            `${plan.ops.length} ${plan.ops.length === 1 ? 'step' : 'steps'}, one undo`}
        </span>
        <button
          type='button'
          data-layout-file-apply=''
          disabled={plan.ops.length === 0}
          onClick={() => {
            apply(plan.ops, { label: `Import ${name}` })
            onDone()
          }}
          className='inline-flex h-7 items-center rounded-md bg-nvr-cyan px-3 text-[12px] font-medium text-white transition-opacity hover:opacity-90 disabled:pointer-events-none disabled:opacity-40'
        >
          Apply to the draft
        </button>
      </div>
    </div>
  )
}
