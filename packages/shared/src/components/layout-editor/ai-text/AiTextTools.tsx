import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Sparkles } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useNivaroClient } from '../../../context'
import { get, post } from '../../../lib/commands'
import type { LayoutBundle, LayoutOp } from '../../../lib/layout-ops'
import { cn } from '../../../lib/utils'
import { Checkbox } from '../../ui/checkbox'
import { collectionMetaKey } from '../collection-meta'
import { tintCard } from '../panel-style'
import { PickList, quietText, Segmented, smallBtn } from '../settings/controls'
import { parseSaveFailure } from '../useLayoutDraft'
import { approveDraftOps, draftTranslations, planLabel, planTextOps, staleReason } from './text-ops'
import type { TextLocales, TextProposal, TextResult, TextTool } from './types'

/**
 * AI wording tools (#2677 #2678 #2679 #2681 #2682 #2683) in Form settings →
 * AI review. Each tool asks the server for proposals (it reads, never
 * writes), lists them as plain sentences with checkboxes, and Apply sends the
 * kept ones through the draft as ONE undo step. Choice labels may instead go
 * on the field itself (every form), which is its own immediate call.
 */

const TOOLS: Array<{ id: TextTool; label: string; effect: string; needsAi: boolean }> = [
  {
    id: 'glossary',
    label: 'Glossary terms',
    effect: 'Labels and help that use another word for a glossary term, rewritten to the term.',
    needsAi: false
  },
  {
    id: 'intros',
    label: 'Section intros',
    effect: 'A short note at the top of each step or section: what to fill in and why.',
    needsAi: true
  },
  {
    id: 'placeholders',
    label: 'Placeholders',
    effect: 'Example text from the shape of stored values — never a real value.',
    needsAi: false
  },
  {
    id: 'choices',
    label: 'Choice labels',
    effect: 'Readable words for coded dropdown choices such as $t:pending_approval.',
    needsAi: false
  },
  {
    id: 'reading',
    label: 'Plain language',
    effect: 'Scores every label and help text, worst first, with simpler rewrites.',
    needsAi: false
  },
  {
    id: 'translate',
    label: 'Translations',
    effect: 'Draft labels and help in another language; drafts wait for your approval.',
    needsAi: true
  }
]

type ChoiceTarget = 'layout' | 'field'

export function AiTextTools({
  layoutId,
  bundle,
  collection,
  apply
}: {
  layoutId: number
  bundle: LayoutBundle
  collection: string
  apply: (ops: LayoutOp[], opts: { label: string }) => void
}) {
  const client = useNivaroClient()
  const qc = useQueryClient()
  const [tool, setTool] = useState<TextTool | null>(null)
  const [locale, setLocale] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)
  const [result, setResult] = useState<TextResult | null>(null)
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [targets, setTargets] = useState<Map<string, ChoiceTarget>>(new Map())

  const { data: info } = useQuery<TextLocales | null>({
    queryKey: ['layout-editor', 'ai-text', 'locales', layoutId],
    queryFn: () =>
      client
        .request<{ data: TextLocales }>(get(`/ai-design/layouts/${layoutId}/text/locales`))
        .then((r) => r?.data ?? null),
    staleTime: 60_000
  })
  const aiReady = info?.ai_configured ?? false
  const drafts = useMemo(() => draftTranslations(bundle), [bundle])

  const ask = async (t: TextTool, loc: string | null = locale) => {
    setTool(t)
    setResult(null)
    setError(null)
    setDone(null)
    if (t === 'translate' && !loc) return
    setBusy(true)
    try {
      const res = await client.request<{ data: TextResult }>(
        post(`/ai-design/layouts/${layoutId}/text/${t}`, t === 'translate' ? { locale: loc } : {})
      )
      const r = res?.data ?? null
      setResult(r)
      setPicked(
        new Set((r?.proposals ?? []).filter((p) => !staleReason(bundle, p)).map((p) => p.id))
      )
      setTargets(new Map())
    } catch (err) {
      const f = parseSaveFailure(err, 'The tool could not run')
      setError(
        f.status === 503
          ? 'AI is not set up here. Glossary terms, placeholders, choice labels and plain language still work from rules.'
          : f.message
      )
    } finally {
      setBusy(false)
    }
  }

  const run = async (proposals: TextProposal[]) => {
    if (!result || proposals.length === 0) return
    setError(null)
    const onField = proposals.filter(
      (p) => p.key === 'choices' && p.choices?.from === 'field' && targets.get(p.id) === 'field'
    )
    const plan = planTextOps(bundle, proposals, new Set(onField.map((p) => p.id)))
    if (plan.ops.length) apply(plan.ops, { label: planLabel(result.tool, plan.applied.length) })
    const fieldDone: string[] = []
    for (const p of onField) {
      if (p.target.kind !== 'placement' || !p.choices) continue
      try {
        await client.request(
          post(`/ai-design/layouts/${layoutId}/text/choices/field`, {
            field: p.target.field,
            choices: p.choices.changed.map((c) => ({ value: c.value, text: c.after }))
          })
        )
        fieldDone.push(p.id)
      } catch (err) {
        setError(parseSaveFailure(err, 'The field could not be changed').message)
      }
    }
    if (fieldDone.length) void qc.invalidateQueries({ queryKey: collectionMetaKey(collection) })
    const gone = new Set([...plan.applied, ...fieldDone])
    const parts: string[] = []
    if (plan.applied.length)
      parts.push(
        `${plan.applied.length} change${plan.applied.length === 1 ? '' : 's'} on this form (Undo reverts them)`
      )
    if (fieldDone.length)
      parts.push(
        `${fieldDone.length} field${fieldDone.length === 1 ? '' : 's'} relabelled on every form`
      )
    if (plan.skipped.length) parts.push(`${plan.skipped.length} skipped: ${plan.skipped[0].why}`)
    setDone(parts.join(' · ') || 'Nothing changed')
    setResult({ ...result, proposals: result.proposals.filter((p) => !gone.has(p.id)) })
    setPicked((s) => new Set([...s].filter((id) => !gone.has(id))))
  }

  const proposals = result?.proposals ?? []
  const chosen = proposals.filter((p) => picked.has(p.id))
  const current = TOOLS.find((t) => t.id === tool)

  return (
    <div data-ai-text-tools='' className='space-y-2.5'>
      <div className='flex flex-wrap gap-1.5'>
        {TOOLS.map((t) => {
          const off = t.needsAi && !aiReady
          return (
            <button
              key={t.id}
              type='button'
              data-ai-text-tool={t.id}
              disabled={busy || off}
              data-tip={off ? 'Needs AI — set it up under Settings → AI Features' : t.effect}
              onClick={() => void ask(t.id)}
              className={cn(
                smallBtn,
                tool === t.id &&
                  'border-nvr-cyan/50 bg-nvr-cyan/10 text-slate-900 dark:border-nvr-cyan/40 dark:text-foreground'
              )}
            >
              {t.label}
            </button>
          )
        })}
      </div>
      {current && <p className={quietText}>{current.effect}</p>}

      {tool === 'translate' && (
        <TranslateBar
          locales={info?.locales ?? []}
          locale={locale}
          busy={busy}
          onPick={(l) => {
            setLocale(l)
            if (l) void ask('translate', l)
          }}
        />
      )}
      {tool === 'translate' && drafts.length > 0 && (
        <div data-ai-text-drafts='' className={cn(tintCard, 'space-y-1.5 p-2.5 text-[12px]')}>
          <div className='flex items-center justify-between gap-2'>
            <span className='font-medium text-slate-700 dark:text-foreground'>
              {drafts.length} translation draft{drafts.length === 1 ? '' : 's'} waiting for approval
            </span>
            <button
              type='button'
              className={smallBtn}
              onClick={() =>
                apply(approveDraftOps(bundle, drafts), {
                  label: `Approve ${drafts.length} translation${drafts.length === 1 ? '' : 's'}`
                })
              }
            >
              Approve all
            </button>
          </div>
          <ul className='space-y-1'>
            {drafts.slice(0, 12).map((d) => (
              <li key={`${d.locale}:${d.group_key}:${d.field}`} className='flex items-center gap-2'>
                <span className='min-w-0 flex-1 truncate text-slate-600 dark:text-muted-foreground'>
                  <span className='font-mono text-[11px]'>{d.locale}</span> {d.field}: “{d.label}”
                </span>
                <button
                  type='button'
                  className='text-[12px] font-medium text-nvr-navy hover:underline dark:text-nvr-cyan'
                  onClick={() =>
                    apply(approveDraftOps(bundle, [d]), {
                      label: `Approve the ${d.locale} translation of ${d.field}`
                    })
                  }
                >
                  Approve
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {busy && (
        <p className={cn(quietText, 'flex items-center gap-1.5')}>
          <Sparkles className='h-3.5 w-3.5 animate-pulse text-nvr-cyan' />
          Reading the form…
        </p>
      )}
      {error && <p className='text-[12px] text-[#9c2f47] dark:text-[#f08aa1]'>{error}</p>}
      {done && (
        <p data-ai-text-done='' className='text-[12px] text-slate-700 dark:text-foreground'>
          {done}
        </p>
      )}

      {result && !busy && (
        <div data-ai-text-result={result.tool} className='space-y-2'>
          {result.terms && result.terms.length > 0 && (
            <div className={cn(tintCard, 'p-2.5 text-[12px]')}>
              <p className='mb-1 font-medium text-slate-700 dark:text-foreground'>
                Words that are not the glossary term
              </p>
              <ul className='space-y-0.5 text-slate-600 dark:text-muted-foreground'>
                {result.terms.map((t) => (
                  <li key={`${t.found}:${t.term}`}>
                    “{t.found}” should be “{t.term}” — {t.places.length} place
                    {t.places.length === 1 ? '' : 's'}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {result.note && <p className={quietText}>{result.note}</p>}
          {proposals.length > 0 && (
            <>
              <ul className='space-y-1'>
                {proposals.map((p) => (
                  <ProposalRow
                    key={p.id}
                    p={p}
                    stale={staleReason(bundle, p)}
                    checked={picked.has(p.id)}
                    onCheck={(v) =>
                      setPicked((s) => {
                        const n = new Set(s)
                        if (v) n.add(p.id)
                        else n.delete(p.id)
                        return n
                      })
                    }
                    target={targets.get(p.id) ?? 'layout'}
                    onTarget={(t) => setTargets((m) => new Map(m).set(p.id, t))}
                  />
                ))}
              </ul>
              <div className='flex flex-wrap items-center gap-1.5'>
                <button
                  type='button'
                  data-ai-text-apply=''
                  disabled={chosen.length === 0}
                  onClick={() => void run(chosen)}
                  className='inline-flex h-7 items-center rounded-md bg-nvr-cyan px-2.5 text-[12px] font-medium text-white transition-colors hover:bg-nvr-cyan-dark disabled:opacity-50'
                >
                  Apply {chosen.length === proposals.length ? 'all' : `${chosen.length} selected`}
                </button>
                {chosen.length !== proposals.length && (
                  <button
                    type='button'
                    className={smallBtn}
                    onClick={() => void run(proposals.filter((p) => !staleReason(bundle, p)))}
                  >
                    Apply all
                  </button>
                )}
              </div>
            </>
          )}
          {result.flagged && result.flagged.length > 0 && (
            <div className='space-y-1'>
              <p className='text-[12px] font-medium text-slate-700 dark:text-foreground'>
                Hard to read, no plainer wording found
              </p>
              <ul className='space-y-1'>
                {result.flagged.map((f) => (
                  <li key={`${f.place}:${f.text}`} className='flex items-start gap-2 text-[12px]'>
                    <ScoreChip score={f.score} />
                    <span className='min-w-0 text-slate-600 dark:text-muted-foreground'>
                      {f.place}: “{f.text}”{f.reasons.length > 0 && ` — ${f.reasons.join('; ')}`}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {result.dropped > 0 && (
            <p className={quietText}>
              {result.dropped} AI suggestion{result.dropped === 1 ? '' : 's'} left out: named
              something not on this form or failed a check.
            </p>
          )}
          {proposals.length === 0 && !result.note && !result.flagged?.length && (
            <p className={quietText}>Nothing to change.</p>
          )}
        </div>
      )}
    </div>
  )
}

function TranslateBar({
  locales,
  locale,
  busy,
  onPick
}: {
  locales: string[]
  locale: string | null
  busy: boolean
  onPick: (l: string | null) => void
}) {
  if (locales.length === 0)
    return (
      <p className={quietText}>
        No other languages are set up. Add them under Settings → Localization.
      </p>
    )
  return (
    <PickList
      ariaLabel='Language'
      value={locale}
      disabled={busy}
      placeholder='Pick a language…'
      options={locales.map((l) => ({ value: l, label: l }))}
      onChange={onPick}
    />
  )
}

function ScoreChip({ score }: { score: number }) {
  const level = score >= 70 ? 'plain' : score >= 50 ? 'fair' : 'hard'
  return (
    <span
      data-tip={`Plain-language score ${score} of 100`}
      className={cn(
        'inline-flex h-5 shrink-0 items-center rounded px-1.5 font-mono text-[11px] tabular-nums',
        level === 'plain' &&
          'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300',
        level === 'fair' && 'bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-300',
        level === 'hard' && 'bg-[#fae6eb] text-[#9c2f47] dark:bg-[#3d1621] dark:text-[#f08aa1]'
      )}
    >
      {score}
    </span>
  )
}

function ProposalRow({
  p,
  stale,
  checked,
  onCheck,
  target,
  onTarget
}: {
  p: TextProposal
  stale: string | null
  checked: boolean
  onCheck: (v: boolean) => void
  target: ChoiceTarget
  onTarget: (t: ChoiceTarget) => void
}) {
  const id = `ai-text-${p.id}`
  return (
    <li
      data-ai-text-proposal={p.id}
      className={cn(
        'flex items-start gap-2 rounded-md px-1.5 py-1 hover:bg-muted',
        stale && 'opacity-60'
      )}
    >
      <Checkbox
        id={id}
        className='mt-0.5'
        checked={checked && !stale}
        disabled={!!stale}
        onCheckedChange={(v) => onCheck(v === true)}
      />
      <div className='min-w-0 flex-1 space-y-1'>
        <label
          htmlFor={id}
          className='block text-[12.5px] leading-snug text-slate-800 dark:text-foreground'
        >
          {p.sentence}
        </label>
        <div className='flex flex-wrap items-center gap-1.5 text-[11.5px] text-slate-500 dark:text-muted-foreground'>
          {p.score && (
            <span className='inline-flex items-center gap-1'>
              <ScoreChip score={p.score.before} />
              {p.score.after != null && (
                <>
                  →
                  <ScoreChip score={p.score.after} />
                </>
              )}
            </span>
          )}
          <span>{p.source === 'ai' ? 'Written by AI' : 'From rules'}</span>
          {p.score?.reasons.length ? <span>· {p.score.reasons.join('; ')}</span> : null}
          {p.tone === 'warn' && <span>· shown as a warning</span>}
          {stale && <span className='text-[#9c2f47] dark:text-[#f08aa1]'>· {stale}</span>}
        </div>
        {p.key === 'choices' && p.choices && (
          <div className='flex items-center gap-2'>
            {p.choices.from === 'field' ? (
              <Segmented<ChoiceTarget>
                ariaLabel='Where the labels go'
                value={target}
                options={[
                  { value: 'layout', label: 'This form' },
                  { value: 'field', label: 'The field (every form)' }
                ]}
                onChange={onTarget}
              />
            ) : (
              <span className='text-[11.5px] text-slate-500 dark:text-muted-foreground'>
                This form keeps its own choice list, so the labels go on this form.
              </span>
            )}
          </div>
        )}
      </div>
    </li>
  )
}
