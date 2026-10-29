import { Copy, FileUp, Quote, Sparkles, X } from 'lucide-react'
import { type ReactNode, useMemo, useRef, useState } from 'react'
import { useNivaroClient } from '../../../context'
import type { LayoutBundle } from '../../../lib/layout-ops'
import { cn, formatFileSize } from '../../../lib/utils'
import { Checkbox } from '../../ui/checkbox'
import { apiFailure, useOverviewFields } from '../overview/overview-api'
import { effectText, inputBase, tintCard } from '../panel-style'
import {
  COMPOSE_ACCEPT,
  COMPOSE_MAX_BYTES,
  COMPOSE_MAX_FILES,
  COMPOSE_MAX_TOTAL_BYTES,
  type ComposeMode,
  type ComposeResult,
  composeFromFile,
  composeFromText
} from './ai-forms-api'
import { type AiPlan, extraChoices, planComposed } from './plan'

/**
 * One AI form request (#2668 describe, #2669 picture / PDF, #2670 process
 * document) and its review: every change in plain words, what was left out,
 * labels no field matched, and for a process document the passage each step
 * came from plus the suggested read-only / required fields to tick. Apply
 * hands the host a planner so it plans again on the bundle it applies to.
 */

export const MODE_COPY: Record<ComposeMode, { title: string; hint: string }> = {
  describe: {
    title: 'Describe the form',
    hint: 'Built from this collection’s fields. Anything the AI names that is not a field is left out and listed.'
  },
  picture: {
    title: 'From a paper form, picture or PDF',
    hint: 'A photo, scan, PDF or spreadsheet of the old form (several photos for a form of several pages). Its labels are matched to fields; labels with no field are listed as fields you may want to create, never created. Read once, never stored. Up to 6 files, 10 MB each.'
  },
  sop: {
    title: 'From a process document',
    hint: 'One step per stage of the process, with suggested read-only and required fields for the pipeline states. Read once, never stored. Up to 10 MB.'
  }
}

export const quiet = effectText
export const ghostBtn =
  'inline-flex h-7 items-center gap-1 rounded-md px-2.5 text-[12px] font-medium text-slate-600 transition-colors hover:bg-muted hover:text-slate-900 disabled:opacity-50 dark:text-muted-foreground dark:hover:text-foreground'
export const primaryBtn =
  'inline-flex h-7 items-center gap-1.5 rounded-md bg-nvr-cyan px-3 text-[12px] font-medium text-white transition-opacity hover:opacity-90 disabled:pointer-events-none disabled:opacity-50'
const head = 'text-[12px] font-semibold text-slate-700 dark:text-foreground'
const noteCls =
  'rounded-md border border-amber-200 bg-amber-50 px-2.5 py-1.5 text-[12px] leading-snug text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200'

type Phase =
  | { kind: 'input'; error?: string }
  | { kind: 'asking' }
  | { kind: 'review'; result: ComposeResult }

export function AiComposer({
  collection,
  mode,
  bundle,
  applyLabel,
  onApply,
  onBack,
  busy = false
}: {
  collection: string
  mode: ComposeMode
  /** What the review previews against: the draft, or an empty new form. */
  bundle: LayoutBundle
  applyLabel: (plan: AiPlan) => string
  /** `build` plans on the bundle the host applies to (the draft may have changed). */
  onApply: (build: (b: LayoutBundle) => AiPlan, result: ComposeResult) => void
  onBack?: () => void
  busy?: boolean
}) {
  const client = useNivaroClient()
  const { data: fields = [] } = useOverviewFields(collection)
  const [text, setText] = useState('')
  const [files, setFiles] = useState<File[]>([])
  const [phase, setPhase] = useState<Phase>({ kind: 'input' })
  const [chosen, setChosen] = useState<Set<string>>(new Set())
  const fileRef = useRef<HTMLInputElement | null>(null)
  const env = useMemo(() => ({ fields }), [fields])
  const copy = MODE_COPY[mode]

  const ready = mode === 'describe' ? text.trim().length >= 6 : files.length > 0

  /** Add picked files (a form photographed page by page), within the limits. */
  const addFiles = (picked: File[]) => {
    const next = [...files]
    for (const f of picked) {
      if (f.size > COMPOSE_MAX_BYTES) {
        setPhase({ kind: 'input', error: `${f.name} is larger than 10 MB` })
        return
      }
      if (!next.some((x) => x.name === f.name && x.size === f.size)) next.push(f)
    }
    if (next.length > COMPOSE_MAX_FILES) {
      setPhase({ kind: 'input', error: `Up to ${COMPOSE_MAX_FILES} files at once` })
      return
    }
    if (next.reduce((n, f) => n + f.size, 0) > COMPOSE_MAX_TOTAL_BYTES) {
      setPhase({ kind: 'input', error: 'The files are larger than 25 MB together' })
      return
    }
    setFiles(next)
    setPhase({ kind: 'input' })
  }

  const run = async () => {
    if (!ready) return
    setPhase({ kind: 'asking' })
    try {
      const result =
        mode === 'describe'
          ? await composeFromText(client, collection, text.trim())
          : await composeFromFile(client, {
              collection,
              mode,
              files,
              note: text
            })
      setChosen(
        new Set(
          extraChoices(result.form, result.states ?? [], env)
            .filter((c) => c.checked)
            .map((c) => c.id)
        )
      )
      setPhase({ kind: 'review', result })
    } catch (err) {
      const f = apiFailure(err, 'The AI could not build the form')
      setPhase({
        kind: 'input',
        error:
          f.status === 503 ? 'AI is not set up here. Turn it on under Settings → AI.' : f.message
      })
    }
  }

  if (phase.kind === 'review')
    return (
      <Review
        result={phase.result}
        bundle={bundle}
        env={env}
        chosen={chosen}
        onChosen={setChosen}
        applyLabel={applyLabel}
        busy={busy}
        onBack={() => setPhase({ kind: 'input' })}
        onApply={(build) => onApply(build, phase.result)}
      />
    )

  return (
    <form
      className='space-y-2.5'
      data-ai-compose={mode}
      onSubmit={(e) => {
        e.preventDefault()
        void run()
      }}
    >
      <p className={head}>{copy.title}</p>
      <p className={quiet}>{copy.hint}</p>
      {mode !== 'describe' && (
        <div className='space-y-1.5'>
          <input
            ref={fileRef}
            type='file'
            accept={COMPOSE_ACCEPT}
            multiple
            className='hidden'
            data-ai-compose-file=''
            onChange={(e) => {
              const picked = Array.from(e.target.files ?? [])
              e.target.value = ''
              if (picked.length) addFiles(picked)
            }}
          />
          <button
            type='button'
            className={cn(
              'inline-flex h-8 items-center gap-1.5 rounded-md border border-slate-200 bg-white px-2.5 text-[12.5px] font-medium text-slate-700 transition-colors hover:bg-slate-50 disabled:opacity-50 dark:border-border dark:bg-card dark:text-foreground dark:hover:bg-muted'
            )}
            disabled={files.length >= COMPOSE_MAX_FILES}
            onClick={() => fileRef.current?.click()}
          >
            <FileUp className='h-3.5 w-3.5' />
            {files.length ? 'Add another page or file' : 'Choose files'}
          </button>
          {files.length > 0 && (
            <ul className='space-y-0.5' data-ai-compose-files=''>
              {files.map((f, i) => (
                <li
                  key={`${f.name}:${f.size}`}
                  className='flex min-w-0 items-center gap-1.5 text-[12px] text-slate-600 dark:text-muted-foreground'
                >
                  {files.length > 1 && (
                    <span className='w-4 shrink-0 text-right tabular-nums text-slate-400 dark:text-muted-foreground'>
                      {i + 1}
                    </span>
                  )}
                  <span className='min-w-0 flex-1 truncate'>
                    {f.name} · {formatFileSize(f.size)}
                  </span>
                  <button
                    type='button'
                    aria-label={`Remove ${f.name}`}
                    data-tip='Remove'
                    onClick={() => setFiles(files.filter((x) => x !== f))}
                    className='inline-flex h-6 w-6 shrink-0 items-center justify-center rounded text-slate-400 transition-colors hover:bg-muted hover:text-slate-700 dark:hover:text-foreground'
                  >
                    <X className='h-3.5 w-3.5' />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {mode === 'describe' ? (
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={3}
          maxLength={2000}
          aria-label='Describe the form'
          placeholder='A returns form with a manager approval step'
          data-ai-compose-text=''
          className={cn(inputBase, 'h-auto resize-y py-1.5 leading-snug')}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault()
              void run()
            }
          }}
        />
      ) : (
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          maxLength={500}
          aria-label='Note for the AI (optional)'
          placeholder='Note for the AI (optional)'
          className={inputBase}
        />
      )}
      {phase.kind === 'input' && phase.error && (
        <p
          role='alert'
          data-ai-compose-error=''
          className='text-[12.5px] leading-snug text-red-700 dark:text-red-300'
        >
          {phase.error}
        </p>
      )}
      <div className='flex items-center justify-end gap-1.5 pt-0.5'>
        {onBack && (
          <button type='button' className={ghostBtn} onClick={onBack}>
            Back
          </button>
        )}
        <button
          type='submit'
          className={primaryBtn}
          disabled={!ready || phase.kind === 'asking'}
          data-ai-compose-run=''
        >
          <Sparkles className='h-3.5 w-3.5' />
          {phase.kind === 'asking'
            ? mode === 'describe'
              ? 'Building…'
              : 'Reading…'
            : mode === 'describe'
              ? 'Build draft'
              : 'Read it'}
        </button>
      </div>
    </form>
  )
}

function Review({
  result,
  bundle,
  env,
  chosen,
  onChosen,
  applyLabel,
  onApply,
  onBack,
  busy
}: {
  result: ComposeResult
  bundle: LayoutBundle
  env: { fields: Array<{ field: string; label?: string | null }> }
  chosen: Set<string>
  onChosen: (s: Set<string>) => void
  applyLabel: (plan: AiPlan) => string
  onApply: (build: (b: LayoutBundle) => AiPlan) => void
  onBack: () => void
  busy: boolean
}) {
  const { form } = result
  const states = useMemo(() => result.states ?? [], [result])
  const extras = useMemo(() => extraChoices(form, states, env), [form, states, env])
  const build = (b: LayoutBundle) => planComposed(b, form, env, { chosen, states })
  const plan = useMemo(
    () => planComposed(bundle, form, env, { chosen, states }),
    [bundle, form, env, chosen, states]
  )
  const sources = form.groups.filter((g) => g.source)
  return (
    <div className='space-y-3' data-ai-review=''>
      <p className={cn(head, 'flex items-center gap-1.5')}>
        <Sparkles className='h-3.5 w-3.5 text-nvr-cyan' />
        The AI proposes
      </p>
      {form.explanation && <p className={quiet}>{form.explanation}</p>}
      {result.read_as?.includes('pdf-pages') && (
        <p className={quiet} data-ai-read-as=''>
          Read from pictures of the PDF’s pages.
        </p>
      )}
      {plan.steps.length > 0 ? (
        <ol className='list-decimal space-y-1 pl-5 text-[12.5px] leading-snug text-slate-700 dark:text-foreground'>
          {plan.steps.map((s, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: two steps may read the same; the list is rebuilt whole
            <li key={`${i}:${s}`}>{s}</li>
          ))}
        </ol>
      ) : (
        <p className={quiet}>Nothing to change: the form already looks like this.</p>
      )}
      {extras.length > 0 && (
        <Block title='Read-only and required, from the process'>
          <ul className='space-y-1.5'>
            {extras.map((x) => (
              <li key={x.id} className='flex items-start gap-2'>
                <Checkbox
                  id={`ai-extra-${x.id}`}
                  className='mt-0.5 border-slate-300 data-[state=checked]:border-nvr-cyan data-[state=checked]:bg-nvr-cyan data-[state=checked]:text-white dark:border-border'
                  checked={chosen.has(x.id)}
                  onCheckedChange={(v) => {
                    const next = new Set(chosen)
                    if (v === true) next.add(x.id)
                    else next.delete(x.id)
                    onChosen(next)
                  }}
                  data-ai-extra={x.id}
                />
                <label htmlFor={`ai-extra-${x.id}`} className='min-w-0 flex-1 cursor-pointer'>
                  <span className='block text-[12.5px] leading-snug text-slate-800 dark:text-foreground'>
                    {x.text}
                  </span>
                  {x.note && <span className={cn(quiet, 'block')}>{x.note}</span>}
                  {x.source && <SourceQuote text={x.source} />}
                </label>
              </li>
            ))}
          </ul>
        </Block>
      )}
      {sources.length > 0 && (
        <Block title='Where each step came from'>
          <ul className='space-y-1.5' data-ai-sources=''>
            {sources.map((g) => (
              <li key={g.label}>
                <span className='text-[12px] font-medium text-slate-800 dark:text-foreground'>
                  {g.label}
                </span>
                <SourceQuote text={g.source as string} />
              </li>
            ))}
          </ul>
        </Block>
      )}
      {form.candidates.length > 0 && <Candidates candidates={form.candidates} />}
      {plan.notes.map((n) => (
        <p key={n} className={noteCls}>
          {n}
        </p>
      ))}
      <div className='flex items-center justify-end gap-1.5 pt-1'>
        <button type='button' className={ghostBtn} onClick={onBack}>
          Back
        </button>
        <button
          type='button'
          className={primaryBtn}
          disabled={plan.ops.length === 0 || busy}
          onClick={() => onApply(build)}
          data-ai-apply=''
        >
          {applyLabel(plan)}
        </button>
      </div>
    </div>
  )
}

/** Labels on the paper form no field matched: fields you may want to create (#3186). */
function Candidates({ candidates }: { candidates: ComposeResult['form']['candidates'] }) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    const lines = candidates.map((c) => [c.label, c.key ?? '', c.type ?? ''].join('\t'))
    try {
      await navigator.clipboard.writeText(['Label\tKey\tType', ...lines].join('\n'))
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      /* clipboard refused (not a secure page): the list stays on screen */
    }
  }
  return (
    <Block title='Fields you may want to create'>
      <p className={quiet}>
        Labels on the form no field matched. Nothing is created: add the ones you need in the data
        model, then build again to place them.
      </p>
      <ul className='mt-1 space-y-1' data-ai-candidates=''>
        {candidates.map((c) => {
          const meta = [c.type, c.group ? `in ${c.group}` : null].filter(Boolean).join(' · ')
          return (
            <li
              key={c.label}
              className='flex min-w-0 flex-wrap items-baseline gap-x-1.5 text-[12.5px] text-slate-700 dark:text-foreground'
            >
              <span className='min-w-0 break-words'>{c.label}</span>
              {meta && <span className='text-slate-500 dark:text-muted-foreground'>· {meta}</span>}
              {c.key && (
                <span
                  data-tip='Suggested field key'
                  className='font-mono text-[11px] text-slate-500 dark:text-muted-foreground'
                >
                  {c.key}
                </span>
              )}
            </li>
          )
        })}
      </ul>
      <button
        type='button'
        className={cn(ghostBtn, '-ml-2.5 mt-0.5')}
        onClick={() => void copy()}
        data-ai-candidates-copy=''
      >
        <Copy className='h-3.5 w-3.5' />
        {copied ? 'Copied' : 'Copy the list'}
      </button>
    </Block>
  )
}

function Block({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className={cn(tintCard, 'space-y-1.5 px-2.5 py-2')}>
      <p className={head}>{title}</p>
      {children}
    </div>
  )
}

function SourceQuote({ text }: { text: string }) {
  return (
    <span className='mt-0.5 flex items-start gap-1 text-[11.5px] italic leading-snug text-slate-500 dark:text-muted-foreground'>
      <Quote className='mt-0.5 h-3 w-3 shrink-0 not-italic' />
      {text}
    </span>
  )
}
