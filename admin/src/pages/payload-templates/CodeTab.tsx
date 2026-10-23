import { useQueryClient } from '@tanstack/react-query'
import { AlertCircle, AlertTriangle, ArrowRightLeft } from 'lucide-react'
import { useEffect, useId, useRef, useState } from 'react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import {
  type DraftBody,
  errorMessage,
  httpStatus,
  type MapSpec,
  type Problem,
  type RecordOption,
  staleCurrent,
  type TemplateDetail
} from './api'
import { parseSpecText } from './code-tab-lib'
import { usePayloadEditor } from './editor-context'
import { shortValue } from './json-diff'
import {
  type ConvertDiff,
  convertDiffs,
  convertSkipped,
  fetchNewestRecords,
  fetchRecentIds,
  toText,
  useConvert
} from './panel-api'
import { OUTLINE_BTN, STRONG_BTN } from './panel-parts'

export interface CodeTabProps {
  template: TemplateDetail
  draft: DraftBody
  onChange: (next: DraftBody) => void
  problems: Problem[]
}

const APPLY_MS = 400
const DIFFS_SHOWN = 12

const pretty = (spec: MapSpec) => JSON.stringify(spec, null, 2)

const EDITOR =
  'block min-h-[420px] w-full resize-y rounded-md border border-slate-200 bg-slate-50 p-3 font-mono text-[12px] leading-[1.6] text-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan dark:border-border dark:bg-background dark:text-slate-200'

function Errors({ items, tone = 'error' }: { items: string[]; tone?: 'error' | 'warning' }) {
  if (!items.length) return null
  return (
    <ul
      className={cn(
        'space-y-1 rounded-md border px-3 py-2 text-[12px] leading-snug',
        tone === 'error'
          ? 'border-red-200 bg-red-50 text-red-800 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-200'
          : 'border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200'
      )}
      role='alert'
      data-payload-code-errors
    >
      {items.map((m) => (
        <li key={m} className='flex gap-2'>
          {tone === 'error' ? (
            <AlertCircle className='mt-px h-3.5 w-3.5 shrink-0' />
          ) : (
            <AlertTriangle className='mt-px h-3.5 w-3.5 shrink-0' />
          )}
          <span className='min-w-0 break-words'>{m}</span>
        </li>
      ))}
    </ul>
  )
}

function ProblemList({ problems }: { problems: Problem[] }) {
  if (!problems.length) return null
  return (
    <ul className='space-y-1' data-payload-code-problems>
      {problems.map((p) => (
        <li
          key={`${p.field_id}:${p.path}:${p.message}`}
          className={cn(
            'flex gap-2 text-[12px] leading-snug',
            p.severity === 'error'
              ? 'text-red-700 dark:text-red-300'
              : 'text-amber-700 dark:text-amber-300'
          )}
        >
          {p.severity === 'error' ? (
            <AlertCircle className='mt-px h-3.5 w-3.5 shrink-0' />
          ) : (
            <AlertTriangle className='mt-px h-3.5 w-3.5 shrink-0' />
          )}
          <span className='min-w-0 break-words'>
            {p.path && <span className='mr-1.5 font-mono text-[11.5px]'>{p.path}</span>}
            {p.message}
          </span>
        </li>
      ))}
    </ul>
  )
}

// ─── Convert to Liquid ──────────────────────────────────────────────────────

function ConvertDiffs({
  diffs,
  labelOf
}: {
  diffs: ConvertDiff[]
  labelOf: (index: number) => string
}) {
  const refused = diffs.filter((d) => d.index < 0)
  const differ = diffs.filter((d) => d.index >= 0)
  return (
    <div
      className='space-y-2 rounded-md border border-red-200 bg-red-50 px-3 py-2.5 text-[12.5px] text-red-900 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-100'
      role='alert'
      data-payload-convert-diffs
    >
      <p className='font-medium'>
        {refused.length
          ? 'Not converted — this field map uses something Liquid can’t reproduce exactly.'
          : `Not converted — the Liquid version sent a different body for ${
              new Set(differ.map((d) => d.index)).size
            } of the records checked.`}{' '}
        The payload is still a field map.
      </p>
      <ul className='space-y-1.5'>
        {[...refused, ...differ].slice(0, DIFFS_SHOWN).map((d) => (
          <li key={`${d.index}:${d.path}`} className='min-w-0 break-words'>
            {d.index >= 0 && <span className='font-medium'>{labelOf(d.index)} · </span>}
            {d.path && <span className='font-mono text-[11.5px]'>{d.path}</span>}
            {d.message ? (
              <span> {toText(d.message)}</span>
            ) : (
              <span className='text-red-800/80 dark:text-red-200/80'>
                {' '}
                field map gives {shortValue(d.map)}, Liquid gives {shortValue(d.liquid)}
              </span>
            )}
          </li>
        ))}
      </ul>
      {diffs.length > DIFFS_SHOWN && (
        <p className='text-[12px]'>…and {diffs.length - DIFFS_SHOWN} more differences.</p>
      )}
      <p className='text-[12px]'>
        Keep it as a field map, or change the rows named above and convert again.
      </p>
    </div>
  )
}

function ConvertSection({
  template,
  blocked
}: {
  template: TemplateDetail
  blocked: string | null
}) {
  const ctx = usePayloadEditor()
  const ctxRef = useRef(ctx)
  ctxRef.current = ctx
  const qc = useQueryClient()
  const convert = useConvert(template.key)
  const [stage, setStage] = useState<'idle' | 'confirm' | 'running'>('idle')
  const [diffs, setDiffs] = useState<ConvertDiff[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  // The records the server compared, in its order (recent set minus the ones it left out).
  const compared = useRef<RecordOption[]>([])
  const [leftOut, setLeftOut] = useState<Array<{ id: string; message: string }>>([])

  const labelOf = (i: number) => {
    const r = compared.current[i]
    return r ? r.label || `#${r.id}` : `Record ${i + 1}`
  }

  const run = async () => {
    setStage('running')
    setDiffs(null)
    setError(null)
    setLeftOut([])
    let recent: string[] = []
    let labels = new Map<string, string>()
    try {
      const saved = await ctxRef.current.saveNow()
      if (!saved) {
        const why = ctxRef.current.saveError?.message
        setError(`The draft has to save before it converts${why ? `: ${why}` : '.'}`)
        return
      }
      // The server compares over its recent-records set (the same one Check uses); these reads
      // only name the records in a refusal.
      ;[recent, labels] = await Promise.all([
        fetchRecentIds(template.key).catch(() => [] as string[]),
        fetchNewestRecords(qc, template.key)
          .then((rows) => new Map(rows.map((r) => [r.id, r.label])))
          .catch(() => new Map<string, string>())
      ])
      await convert.mutateAsync({ base_rev: ctxRef.current.getRev() ?? 0 })
      await ctxRef.current.adoptServerDraft()
      toast.success('Converted to Liquid', {
        description: 'Both versions sent identical bodies. Nothing goes live until you publish.'
      })
    } catch (e) {
      const d = convertDiffs(e)
      const current = staleCurrent(e)
      if (d) {
        const skipped = convertSkipped(e)
        const gone = new Set(skipped.map((x) => x.id))
        compared.current = recent
          .filter((id) => !gone.has(id))
          .map((id) => ({ id, label: labels.get(id) ?? '' }))
        setLeftOut(skipped)
        setDiffs(d)
      } else if (current) {
        ctxRef.current.raiseConflict(current)
        setError('The draft changed on the server before it converted. See the banner above.')
      } else if (httpStatus(e) === 501)
        setError('Convert to Liquid isn’t available on this server yet.')
      else setError(errorMessage(e, 'The draft was not converted'))
    } finally {
      setStage((s) => (s === 'running' ? 'idle' : s))
    }
  }

  return (
    <section
      className='space-y-2 border-t border-slate-200 pt-4 dark:border-border'
      aria-label='Convert to Liquid'
      data-payload-convert
    >
      <h3 className='text-[12.5px] font-semibold text-slate-800 dark:text-slate-100'>
        Convert to Liquid
      </h3>
      <p className='text-[12.5px] text-slate-600 dark:text-slate-300'>
        For a body the field map can’t express. Nivaro writes the Liquid for you, then renders up to
        20 recent records (the same ones Check recent records uses) both ways; it converts only when
        every body comes out identical.
      </p>
      {stage === 'confirm' ? (
        <div
          className='space-y-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2.5 dark:border-amber-500/30 dark:bg-amber-500/10'
          data-payload-convert-confirm
        >
          <p className='text-[12.5px] text-amber-900 dark:text-amber-100'>
            <span className='font-medium'>This is one way.</span> The draft becomes Liquid text and
            the field map goes away.{' '}
            {template.published_version != null
              ? `Live keeps sending v${template.published_version} until you publish.`
              : 'Nothing goes live until you publish.'}{' '}
            To get a field map back, restore a field-map version from History.
          </p>
          <div className='flex flex-wrap gap-2'>
            <button
              type='button'
              onClick={() => void run()}
              className={STRONG_BTN}
              data-payload-convert-go
            >
              Convert to Liquid
            </button>
            <button type='button' onClick={() => setStage('idle')} className={OUTLINE_BTN}>
              Keep the field map
            </button>
          </div>
        </div>
      ) : (
        <span data-tip={blocked ?? undefined}>
          <button
            type='button'
            onClick={() => setStage('confirm')}
            disabled={!!blocked || stage === 'running'}
            className={OUTLINE_BTN}
            data-payload-convert-start
          >
            <ArrowRightLeft className='h-3.5 w-3.5 text-slate-400' />
            {stage === 'running' ? 'Checking both ways…' : 'Convert to Liquid…'}
          </button>
        </span>
      )}
      {stage === 'running' && (
        <p className='text-[12px] text-slate-500 dark:text-muted-foreground' role='status'>
          Rendering the records with the field map and with the generated Liquid. This can take a
          few seconds.
        </p>
      )}
      {error && <Errors items={[error]} />}
      {diffs && <ConvertDiffs diffs={diffs} labelOf={labelOf} />}
      {diffs && leftOut.length > 0 && (
        <p className='text-[12px] text-slate-500 dark:text-muted-foreground'>
          {leftOut.length} recent {leftOut.length === 1 ? 'record was' : 'records were'} left out
          because {leftOut.length === 1 ? 'its' : 'their'} data couldn't be read:{' '}
          {leftOut
            .slice(0, 3)
            .map((x) => `#${x.id} (${x.message})`)
            .join(', ')}
          {leftOut.length > 3 ? ' …' : ''}
        </p>
      )}
    </section>
  )
}

// ─── Map template: the spec as JSON ─────────────────────────────────────────

function SpecEditor({
  template,
  draft,
  onChange
}: CodeTabProps & { draft: { mode: 'map'; body: MapSpec } }) {
  const ctx = usePayloadEditor()
  const id = useId()
  const [text, setText] = useState(() => pretty(draft.body))
  const [localError, setLocalError] = useState<string | null>(null)
  // The text of the spec this tab last applied (or was given) — an outside change resets it.
  const lastApplied = useRef(pretty(draft.body))
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const textRef = useRef(text)
  textRef.current = text
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange

  /** Parse the box and hand a good spec to the editor; a bad one stays here with its error. */
  const apply = (t: string, report: (msg: string | null) => void) => {
    const r = parseSpecText(t)
    if (!r.ok) return report(r.message)
    report(null)
    const spec = r.spec as MapSpec
    lastApplied.current = pretty(spec)
    onChangeRef.current({ mode: 'map', body: spec })
  }
  const applyRef = useRef(apply)
  applyRef.current = apply

  useEffect(() => {
    const next = pretty(draft.body)
    if (next === lastApplied.current) return
    lastApplied.current = next
    setText(next)
    setLocalError(null)
  }, [draft.body])

  // Leaving the tab with a keystroke still waiting applies it (a valid spec only).
  useEffect(
    () => () => {
      if (!timer.current) return
      clearTimeout(timer.current)
      timer.current = null
      applyRef.current(textRef.current, () => {})
    },
    []
  )

  const flushNow = () => {
    if (!timer.current) return
    clearTimeout(timer.current)
    timer.current = null
    apply(text, setLocalError)
  }

  const edit = (t: string) => {
    setText(t)
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      timer.current = null
      applyRef.current(t, setLocalError)
    }, APPLY_MS)
  }

  const serverErrors = !localError && ctx.saveError ? ctx.saveError.errors : []
  const serverMessage =
    !localError && ctx.saveError && !ctx.saveError.errors.length ? [ctx.saveError.message] : []
  const blocked = localError
    ? 'Fix the JSON first'
    : ctx.saveError
      ? 'The draft has to save before it converts'
      : null

  return (
    <div className='space-y-3 px-5 py-4' data-payload-code-map>
      <label htmlFor={id} className='block text-[12.5px] text-slate-600 dark:text-slate-300'>
        The field map as JSON. Changes here are the same edits as on the Field map tab and save the
        same way.
      </label>
      <textarea
        id={id}
        value={text}
        onChange={(e) => edit(e.target.value)}
        onBlur={flushNow}
        spellCheck={false}
        autoCapitalize='off'
        autoCorrect='off'
        wrap='off'
        aria-invalid={!!localError || serverErrors.length > 0}
        className={cn(
          EDITOR,
          (localError || serverErrors.length > 0) && 'border-red-300 dark:border-red-500/40'
        )}
        data-payload-spec-editor
      />
      {localError && <Errors items={[localError]} />}
      {serverErrors.length > 0 && (
        <div className='space-y-1'>
          <p className='text-[12px] font-medium text-red-700 dark:text-red-300'>
            The server refused this field map — the draft is not saved until these are fixed:
          </p>
          <Errors items={serverErrors} />
        </div>
      )}
      {serverMessage.length > 0 && <Errors items={serverMessage} />}
      <ConvertSection template={template} blocked={blocked} />
    </div>
  )
}

// ─── Code template: Liquid ──────────────────────────────────────────────────

function LiquidEditor({
  draft,
  onChange,
  problems
}: CodeTabProps & { draft: { mode: 'code'; body: string } }) {
  const ctx = usePayloadEditor()
  const id = useId()
  const errs = ctx.saveError
    ? ctx.saveError.errors.length
      ? ctx.saveError.errors
      : [ctx.saveError.message]
    : []
  return (
    <div className='space-y-3 px-5 py-4' data-payload-code-liquid>
      <label htmlFor={id} className='block text-[12.5px] text-slate-600 dark:text-slate-300'>
        Liquid that renders this payload’s JSON body. It reads{' '}
        <code className='font-mono text-[11.5px]'>record</code>,{' '}
        <code className='font-mono text-[11.5px]'>context.&lt;lookup&gt;</code>,{' '}
        <code className='font-mono text-[11.5px]'>state</code> and{' '}
        <code className='font-mono text-[11.5px]'>acting_user</code>;{' '}
        <code className='font-mono text-[11.5px]'>secrets.&lt;name&gt;</code> is a body secret,
        filled in only when the request is sent.
      </label>
      <textarea
        id={id}
        value={draft.body}
        onChange={(e) => onChange({ mode: 'code', body: e.target.value })}
        spellCheck={false}
        autoCapitalize='off'
        autoCorrect='off'
        wrap='off'
        aria-invalid={errs.length > 0}
        className={cn(EDITOR, errs.length > 0 && 'border-red-300 dark:border-red-500/40')}
        data-payload-liquid-editor
      />
      {errs.length > 0 && <Errors items={errs} />}
      {problems.length > 0 && (
        <div className='space-y-1'>
          <p className='text-[12px] font-medium text-slate-700 dark:text-slate-200'>
            For the preview record
          </p>
          <ProblemList problems={problems} />
        </div>
      )}
    </div>
  )
}

/**
 * Code tab. A field-map template shows its spec as editable JSON plus the
 * one-way Convert to Liquid; a code template is its Liquid text.
 */
export function CodeTab(props: CodeTabProps) {
  const { draft } = props
  return draft.mode === 'code' ? (
    <LiquidEditor {...props} draft={draft} />
  ) : (
    // A different template remounts the editor (its text and timers belong to one spec).
    <SpecEditor key={props.template.key} {...props} draft={draft} />
  )
}
