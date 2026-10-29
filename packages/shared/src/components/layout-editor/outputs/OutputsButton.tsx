import {
  ArrowLeft,
  Download,
  FileCode2,
  FileOutput,
  FileSpreadsheet,
  Loader2,
  Printer,
  Upload
} from 'lucide-react'
import { type ReactNode, useMemo, useRef, useState } from 'react'
import { useApiFetchConfig } from '../../../context'
import type { LayoutBundle, LayoutOp } from '../../../lib/layout-ops'
import { cn } from '../../../lib/utils'
import { Checkbox } from '../../ui/checkbox'
import { Popover, PopoverContent } from '../../ui/popover'
import { useCollectionMeta } from '../inspector/field-context'
import { effectText } from '../panel-style'
import { ToolButton } from '../toolbar-kit'
import type { ApplyOptions } from '../useLayoutDraft'
import { diffHelpSheet, type HelpDiff, helpSheetPlan, helpSheetRows, propWord } from './help-sheet'
import { type FileImportState, LayoutFilePreview, problemsOf, readLayoutFile } from './LayoutFile'
import {
  downloadBlankForm,
  downloadHelpSheet,
  downloadLayoutFile,
  downloadRecords,
  downloadTemplate,
  parseHelpSheetFile,
  saveFile
} from './output-api'

// Form-shaped outputs (#2721 #2724 #2729): one button in the top bar, one
// popover beside it. The form as an Excel template or export, as a blank page
// for pen and paper, and its labels and help text as a sheet to edit and
// bring back. A sheet that comes back shows every difference first and
// applies the ticked ones as one undo step.

const checkCls =
  'mt-0.5 h-4 w-4 shrink-0 rounded border-slate-300 data-[state=checked]:border-nvr-cyan data-[state=checked]:bg-nvr-cyan data-[state=checked]:text-white dark:border-slate-600 [&_svg]:h-3 [&_svg]:w-3'

const rowBtn =
  'group flex w-full items-start gap-2.5 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-muted focus-visible:bg-muted focus-visible:outline-none disabled:pointer-events-none disabled:opacity-60'

function Action({
  icon,
  title,
  effect,
  busy,
  onClick,
  data
}: {
  icon: ReactNode
  title: string
  effect: string
  busy: boolean
  onClick: () => void
  data: string
}) {
  return (
    <button type='button' className={rowBtn} disabled={busy} onClick={onClick} data-output={data}>
      <span className='mt-0.5 text-slate-500 dark:text-muted-foreground'>
        {busy ? <Loader2 className='h-4 w-4 animate-spin' /> : icon}
      </span>
      <span className='min-w-0 flex-1'>
        <span className='block text-[13px] font-medium text-slate-900 dark:text-foreground'>
          {title}
        </span>
        <span className={cn(effectText, 'block')}>{effect}</span>
      </span>
    </button>
  )
}

function ChangeList({
  diff,
  skip,
  toggle
}: {
  diff: HelpDiff
  skip: Set<string>
  toggle: (id: string) => void
}) {
  return (
    <div
      data-help-changes=''
      className='mt-2 max-h-[320px] overflow-y-auto border-t border-slate-100 pt-1 dark:border-border'
    >
      {diff.changes.map((c) => (
        // biome-ignore lint/a11y/noLabelWithoutControl: the Radix checkbox is the control
        <label
          key={c.id}
          data-help-change={c.prop}
          className='flex cursor-pointer items-start gap-2 rounded px-1 py-1.5 hover:bg-muted'
        >
          <Checkbox
            checked={!skip.has(c.id)}
            onCheckedChange={() => toggle(c.id)}
            className={checkCls}
          />
          <span className='min-w-0 flex-1 text-[12.5px] leading-snug'>
            <span className='block truncate text-[11.5px] text-slate-500 dark:text-muted-foreground'>
              {propWord(c.prop)} · {c.where}
            </span>
            <span className='block whitespace-pre-wrap break-words text-slate-500 line-through decoration-slate-300 dark:text-muted-foreground'>
              {c.before || 'Empty'}
            </span>
            <span className='block whitespace-pre-wrap break-words text-slate-900 dark:text-foreground'>
              {c.after || 'Removed (the field’s own text shows)'}
            </span>
          </span>
        </label>
      ))}
    </div>
  )
}

export function OutputsButton({
  bundle,
  apply,
  collection
}: {
  bundle: LayoutBundle
  apply: (ops: LayoutOp[], opts?: ApplyOptions) => void
  collection: string
}) {
  const cfg = useApiFetchConfig()
  const layoutId = Number(bundle.layout.id)
  const layoutName = String(bundle.layout.name ?? 'form')
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [diff, setDiff] = useState<HelpDiff | null>(null)
  const [skip, setSkip] = useState<Set<string>>(new Set())
  const fileRef = useRef<HTMLInputElement | null>(null)
  // Layout as a file (#3189): an imported file's plan, shown before it applies.
  const [layoutFile, setLayoutFile] = useState<FileImportState | null>(null)
  const [problems, setProblems] = useState<string[]>([])
  const layoutFileRef = useRef<HTMLInputElement | null>(null)
  const { data: meta } = useCollectionMeta(open ? collection : null)
  const globals = meta?.fields

  const chosen = useMemo(() => (diff?.changes ?? []).filter((c) => !skip.has(c.id)), [diff, skip])
  const plan = useMemo(() => helpSheetPlan(bundle, chosen), [bundle, chosen])

  const run = async (id: string, job: () => Promise<void>) => {
    setBusy(id)
    setError(null)
    setProblems([])
    try {
      await job()
    } catch (e) {
      setError((e as Error).message || 'Something went wrong')
      setProblems(problemsOf(e))
    } finally {
      setBusy(null)
    }
  }

  const onFile = (file: File | undefined) => {
    if (!file) return
    void run('upload', async () => {
      const rows = await parseHelpSheetFile(cfg, file)
      const next = diffHelpSheet(bundle, globals ?? [], rows)
      setSkip(new Set())
      setDiff(next)
    })
  }

  const toggle = (id: string) =>
    setSkip((cur) => {
      const next = new Set(cur)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const close = (v: boolean) => {
    setOpen(v)
    if (!v) {
      setDiff(null)
      setLayoutFile(null)
      setError(null)
      setProblems([])
    }
  }

  const onLayoutFile = (file: File | undefined) => {
    if (!file) return
    void run('layout-import', async () => setLayoutFile(await readLayoutFile(cfg, bundle, file)))
  }

  return (
    <Popover open={open} onOpenChange={close}>
      <ToolButton
        popover
        onOpen={() => setOpen(true)}
        label='Outputs'
        icon={<FileOutput className='h-3.5 w-3.5 shrink-0' />}
        tip='Excel template and export, blank printable form, help text sheet'
        hint='Spreadsheet, print and help text'
        data={{ 'data-outputs-open': '' }}
      />
      <PopoverContent
        align='end'
        className='w-[420px] max-w-[calc(100vw-16px)] p-3'
        data-outputs=''
      >
        {layoutFile ? (
          <LayoutFilePreview
            bundle={bundle}
            state={layoutFile}
            onBack={() => setLayoutFile(null)}
            apply={apply}
            onDone={() => close(false)}
          />
        ) : diff ? (
          <>
            <button
              type='button'
              onClick={() => setDiff(null)}
              className='mb-1 inline-flex items-center gap-1 text-[12px] font-medium text-sky-700 hover:underline dark:text-nvr-cyan'
            >
              <ArrowLeft className='h-3 w-3' /> Back
            </button>
            <p className='text-[13px] font-semibold text-slate-900 dark:text-foreground'>
              {diff.changes.length === 0
                ? 'Nothing differs from the form'
                : `${diff.changes.length} ${diff.changes.length === 1 ? 'change' : 'changes'} in the sheet`}
            </p>
            <p className={cn(effectText, 'mt-0.5')}>
              Untick any you do not want. Applying is one step; Undo puts every one back.
            </p>
            <ChangeList diff={diff} skip={skip} toggle={toggle} />
            {(diff.unknown > 0 || diff.skipped.length > 0) && (
              <p className={cn(effectText, 'mt-2')}>
                {diff.unknown > 0 &&
                  `${diff.unknown} ${diff.unknown === 1 ? 'row' : 'rows'} match nothing on this form and ${diff.unknown === 1 ? 'is' : 'are'} left out. `}
                {diff.skipped.join('. ')}
              </p>
            )}
            <div className='mt-2 flex items-center justify-end gap-2 border-t border-slate-100 pt-2.5 dark:border-border'>
              <span className={cn(effectText, 'mr-auto')}>
                {diff.changes.length > 0 && `${chosen.length} of ${diff.changes.length} ticked`}
              </span>
              <button
                type='button'
                data-help-apply=''
                disabled={!plan.ok}
                onClick={() => {
                  if (!plan.ok) return
                  apply(plan.ops, { label: plan.label })
                  close(false)
                }}
                className='inline-flex h-7 items-center rounded-md bg-nvr-cyan px-3 text-[12px] font-medium text-white transition-opacity hover:opacity-90 disabled:pointer-events-none disabled:opacity-40'
              >
                Apply {chosen.length > 0 ? chosen.length : ''}
              </button>
            </div>
          </>
        ) : (
          <>
            <p className='px-2 text-[13px] font-semibold text-slate-900 dark:text-foreground'>
              Outputs
            </p>
            <p className={cn(effectText, 'mt-0.5 px-2')}>
              The form as a file. Spreadsheets and print follow the saved form.
            </p>
            <div className='mt-2 space-y-0.5'>
              <Action
                data='template'
                icon={<FileSpreadsheet className='h-4 w-4' />}
                title='Excel import template'
                effect='Columns in this form’s order; choices are dropdowns and required columns are amber.'
                busy={busy === 'template'}
                onClick={() =>
                  run('template', async () => saveFile(await downloadTemplate(cfg, layoutId)))
                }
              />
              <Action
                data='records'
                icon={<Download className='h-4 w-4' />}
                title='Export records to Excel'
                effect='Up to 5,000 records in the same columns, limited to what you may read.'
                busy={busy === 'records'}
                onClick={() =>
                  run('records', async () => saveFile(await downloadRecords(cfg, layoutId)))
                }
              />
              <Action
                data='blank'
                icon={<Printer className='h-4 w-4' />}
                title='Blank printable form'
                effect='A PDF with lines and checkboxes for filling in on paper.'
                busy={busy === 'blank'}
                onClick={() =>
                  run('blank', async () => saveFile(await downloadBlankForm(cfg, layoutId)))
                }
              />
            </div>
            <div className='mt-2 border-t border-slate-100 pt-2 dark:border-border'>
              <p className='px-2 text-[12.5px] font-semibold text-slate-900 dark:text-foreground'>
                Labels and help text
              </p>
              <div className='mt-1 space-y-0.5'>
                <Action
                  data='help-download'
                  icon={<Download className='h-4 w-4' />}
                  title='Download as a sheet'
                  effect='Every label, help text and placeholder on this form, including unsaved edits.'
                  busy={busy === 'help'}
                  onClick={() =>
                    run('help', async () =>
                      saveFile(
                        await downloadHelpSheet(
                          cfg,
                          helpSheetRows(bundle, globals ?? []),
                          layoutName
                        )
                      )
                    )
                  }
                />
                <Action
                  data='help-upload'
                  icon={<Upload className='h-4 w-4' />}
                  title='Upload the edited sheet'
                  effect='You see every difference before anything changes.'
                  busy={busy === 'upload'}
                  onClick={() => fileRef.current?.click()}
                />
                <input
                  ref={fileRef}
                  type='file'
                  accept='.xlsx'
                  className='hidden'
                  data-help-file=''
                  onChange={(e) => {
                    onFile(e.target.files?.[0])
                    e.target.value = ''
                  }}
                />
              </div>
            </div>
            <div className='mt-2 border-t border-slate-100 pt-2 dark:border-border'>
              <p className='px-2 text-[12.5px] font-semibold text-slate-900 dark:text-foreground'>
                Layout file
              </p>
              <div className='mt-1 space-y-0.5'>
                <Action
                  data='layout-download'
                  icon={<FileCode2 className='h-4 w-4' />}
                  title='Download as YAML'
                  effect='The saved form, its settings, sections and every field, to keep and review as code.'
                  busy={busy === 'layout-download'}
                  onClick={() =>
                    run('layout-download', async () =>
                      saveFile(await downloadLayoutFile(cfg, layoutId))
                    )
                  }
                />
                <Action
                  data='layout-import'
                  icon={<Upload className='h-4 w-4' />}
                  title='Import a layout file'
                  effect='You see what would change first; applying is one undo step.'
                  busy={busy === 'layout-import'}
                  onClick={() => layoutFileRef.current?.click()}
                />
                <input
                  ref={layoutFileRef}
                  type='file'
                  accept='.yaml,.yml,.json,application/yaml,text/yaml'
                  className='hidden'
                  data-layout-file=''
                  onChange={(e) => {
                    onLayoutFile(e.target.files?.[0])
                    e.target.value = ''
                  }}
                />
              </div>
            </div>
            {error && (
              <div
                role='alert'
                className='mt-2 text-[12px] leading-snug text-red-600 dark:text-red-400'
              >
                <p>{error}</p>
                {problems.length > 1 && (
                  <ul
                    data-layout-file-problems=''
                    className='mt-1 max-h-[160px] list-disc space-y-0.5 overflow-y-auto pl-4'
                  >
                    {problems.map((p) => (
                      <li key={p}>{p}</li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </>
        )}
      </PopoverContent>
    </Popover>
  )
}
