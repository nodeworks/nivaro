import { AlertCircle, AlertTriangle, CheckCircle2, CircleAlert, Info, Sparkles } from 'lucide-react'
import type { ReactNode } from 'react'
import type { LayoutHealth, LintFinding, LintSeverity } from '../../../lib/layout-lint'
import type { LayoutOp } from '../../../lib/layout-ops'
import { cn } from '../../../lib/utils'
import type { DesignTarget } from '../design-context'
import { PanelBody, PanelHeader } from '../panel-frame'
import { effectText, groupTitle } from '../panel-style'
import { barBtn, barBtnOn } from '../toolbar-kit'
import { isStyleRule } from './LabelStyle'
import { findingDesignTarget } from './lint-api'

/**
 * The editor's Problems panel (#2592, #2582, #2607): what the deterministic lint
 * finds on the draft, worst first. A finding selects its target on the canvas;
 * a fix is one undo step through the draft. The AI review stays in Form
 * settings → Tools — this panel links there.
 */

const SECTIONS: Array<{ severity: LintSeverity; title: string }> = [
  { severity: 'error', title: 'Errors' },
  { severity: 'warn', title: 'Warnings' },
  { severity: 'info', title: 'Tips' }
]

const ICON: Record<LintSeverity, typeof AlertCircle> = {
  error: AlertCircle,
  warn: AlertTriangle,
  info: Info
}

const TONE: Record<LintSeverity, string> = {
  error: 'text-red-600 dark:text-red-400',
  warn: 'text-amber-600 dark:text-amber-400',
  info: 'text-slate-500 dark:text-muted-foreground'
}

export function scoreTone(score: number): string {
  return score >= 80
    ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300'
    : score >= 60
      ? 'bg-amber-50 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300'
      : 'bg-red-50 text-red-700 dark:bg-red-500/15 dark:text-red-300'
}

export function lintCounts(findings: LintFinding[]) {
  const n = (s: LintSeverity) => findings.filter((f) => f.severity === s).length
  return { error: n('error'), warn: n('warn'), info: n('info') }
}

/** Top-bar button: how many problems and warnings the draft has. */
export function LintButton({
  findings,
  active,
  onClick
}: {
  findings: LintFinding[]
  active: boolean
  onClick: () => void
}) {
  const c = lintCounts(findings)
  const count = c.error + c.warn
  return (
    <button
      type='button'
      onClick={onClick}
      aria-pressed={active}
      aria-label={`Problems: ${c.error} errors, ${c.warn} warnings`}
      data-editor-checks=''
      data-tip='Problems this form has: hidden required fields, missing cascade parents, empty steps, unreachable fields, accessibility and label style'
      className={cn(barBtn, 'gap-1 px-2', active && barBtnOn)}
    >
      <CircleAlert
        className={cn(
          'h-3.5 w-3.5',
          c.error > 0
            ? 'text-red-600 dark:text-red-400'
            : count > 0
              ? 'text-amber-600 dark:text-amber-400'
              : 'text-slate-500 dark:text-muted-foreground'
        )}
      />
      {count > 0 ? (
        <span data-checks-count={count} className='tabular-nums'>
          {count}
        </span>
      ) : (
        <CheckCircle2 className='h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400' />
      )}
    </button>
  )
}

const quietBtn =
  'inline-flex h-6 items-center rounded px-1.5 text-[12px] font-medium text-slate-700 transition-colors hover:bg-muted hover:text-slate-900 dark:text-foreground'

/** Every sentence-case fix at once (#3184): one undo step. */
export function sentenceCaseBatch(
  findings: LintFinding[]
): { ops: LayoutOp[]; count: number } | null {
  const fixes = findings.filter((f) => f.rule === 'label-sentence-case' && f.fix)
  if (fixes.length < 2) return null
  return {
    ops: fixes.flatMap((f) => (f.fix?.ops ?? []) as unknown as LayoutOp[]),
    count: fixes.length
  }
}

function FindingRow({
  finding,
  onSelect,
  apply,
  readOnly,
  onTurnOff
}: {
  finding: LintFinding
  onSelect: (t: DesignTarget) => void
  apply: (ops: LayoutOp[], opts?: { label: string }) => void
  readOnly: boolean
  onTurnOff?: (rule: string) => void
}) {
  const canTurnOff = !!onTurnOff && isStyleRule(finding.rule)
  const Icon = ICON[finding.severity]
  const target = findingDesignTarget(finding)
  return (
    <li
      data-lint-finding={finding.rule}
      className='rounded-md border border-slate-200 bg-white dark:border-border dark:bg-card'
    >
      <button
        type='button'
        disabled={!target}
        onClick={() => target && onSelect(target)}
        className='flex w-full items-start gap-2 rounded-md px-2.5 py-2 text-left transition-colors hover:bg-muted disabled:cursor-default disabled:hover:bg-transparent'
        data-tip={target ? 'Select it on the form' : undefined}
      >
        <Icon className={cn('mt-0.5 h-3.5 w-3.5 shrink-0', TONE[finding.severity])} />
        <span className='min-w-0 text-[12.5px] leading-snug text-slate-700 dark:text-foreground'>
          {finding.message}
        </span>
      </button>
      {((finding.fix && !readOnly) || canTurnOff) && (
        <div className='flex flex-wrap items-center gap-x-1 border-t border-slate-100 px-2.5 py-1.5 dark:border-border'>
          {finding.fix && !readOnly && (
            <button
              type='button'
              data-lint-fix=''
              onClick={() =>
                finding.fix &&
                apply(finding.fix.ops as unknown as LayoutOp[], { label: finding.fix.label })
              }
              className={quietBtn}
            >
              {finding.fix.label}
            </button>
          )}
          {canTurnOff && (
            <button
              type='button'
              data-lint-turn-off={finding.rule}
              data-tip='House style for every form on this instance'
              onClick={() => onTurnOff?.(finding.rule)}
              className={cn(
                quietBtn,
                'ml-auto font-normal text-slate-500 dark:text-muted-foreground'
              )}
            >
              Turn off this check
            </button>
          )}
        </div>
      )}
    </li>
  )
}

export function LintPanel({
  findings,
  health,
  ready,
  onSelect,
  apply,
  onOpenAiReview,
  readOnly = false,
  onTurnOff,
  styleSettings
}: {
  findings: LintFinding[]
  health: LayoutHealth | null
  ready: boolean
  onSelect: (t: DesignTarget) => void
  apply: (ops: LayoutOp[], opts?: { label: string }) => void
  /** Opens Form settings, where the AI review lives (hosts without it pass nothing). */
  onOpenAiReview?: () => void
  readOnly?: boolean
  /** Turns a label style check off for the instance (#3184); absent = no such button. */
  onTurnOff?: (rule: string) => void
  /** The label style settings block, under the findings. */
  styleSettings?: ReactNode
}) {
  const c = lintCounts(findings)
  const batch = readOnly ? null : sentenceCaseBatch(findings)
  const sub =
    findings.length === 0
      ? ready
        ? 'Nothing to fix'
        : 'Checking…'
      : [
          c.error && `${c.error} ${c.error === 1 ? 'problem' : 'problems'}`,
          c.warn && `${c.warn} ${c.warn === 1 ? 'warning' : 'warnings'}`,
          c.info && `${c.info} ${c.info === 1 ? 'suggestion' : 'suggestions'}`
        ]
          .filter(Boolean)
          .join(' · ')
  return (
    <div data-lint-panel='' className='flex min-h-0 flex-1 flex-col'>
      <PanelHeader eyebrow='Form' title='Problems' sub={sub} />
      <PanelBody>
        {health && (
          <section aria-label='Health' className='space-y-1.5'>
            <div className='flex items-center gap-2'>
              <h3 className={groupTitle}>Health</h3>
              <span
                data-health-score={health.score}
                className={cn(
                  'rounded-full px-2 py-px text-[11.5px] font-semibold tabular-nums',
                  scoreTone(health.score)
                )}
              >
                {health.score} / 100
              </span>
            </div>
            {health.costs.length > 0 ? (
              <ul className='space-y-0.5'>
                {health.costs.map((cost) => (
                  <li key={cost.label} className={cn(effectText, 'flex justify-between gap-2')}>
                    <span>{cost.label}</span>
                    <span className='tabular-nums'>−{cost.points}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className={effectText}>Nothing costs this form points.</p>
            )}
          </section>
        )}
        {findings.length === 0 && ready && (
          <p className={cn(effectText, 'flex items-center gap-1.5')}>
            <CheckCircle2 className='h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400' />
            No problems found on this form.
          </p>
        )}
        {SECTIONS.map(({ severity, title }) => {
          const list = findings.filter((f) => f.severity === severity)
          if (list.length === 0) return null
          return (
            <section key={severity} aria-label={title} className='space-y-1.5'>
              <h3 className={groupTitle}>
                {title}{' '}
                <span className='font-normal text-slate-500 dark:text-muted-foreground'>
                  {list.length}
                </span>
              </h3>
              {severity === 'info' && batch && (
                <button
                  type='button'
                  data-lint-fix-all='label-sentence-case'
                  onClick={() =>
                    apply(batch.ops, { label: `Change ${batch.count} labels to sentence case` })
                  }
                  className={cn(quietBtn, 'h-7 border border-slate-200 dark:border-border')}
                >
                  Change all {batch.count} labels to sentence case
                </button>
              )}
              <ul className='space-y-1.5'>
                {list.map((f) => (
                  <FindingRow
                    key={f.id}
                    finding={f}
                    onSelect={onSelect}
                    apply={apply}
                    readOnly={readOnly}
                    onTurnOff={onTurnOff}
                  />
                ))}
              </ul>
            </section>
          )
        })}
        {styleSettings}
        {onOpenAiReview && (
          <div className='space-y-1'>
            <p className={effectText}>
              These checks are counted, not guessed. The AI review also reads labels and help text.
            </p>
            <button
              type='button'
              onClick={onOpenAiReview}
              className='inline-flex h-7 items-center gap-1.5 rounded-md px-1.5 text-[12px] font-medium text-slate-700 transition-colors hover:bg-muted hover:text-slate-900 dark:text-foreground'
            >
              <Sparkles className='h-3.5 w-3.5' />
              Open the AI review
            </button>
          </div>
        )}
      </PanelBody>
    </div>
  )
}
