import { AlertTriangle, ArrowDownWideNarrow, Columns2, RefreshCw, ScanSearch } from 'lucide-react'
import { createContext, type ReactNode, useContext, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { useNivaroClient } from '../../../context'
import { cn } from '../../../lib/utils'
import {
  type CoverageResult,
  type CoverageRow,
  fetchCoverage,
  type HealthRow,
  useLayoutHealth
} from '../lint/lint-api'
import { ToolButton } from '../toolbar-kit'
import { apiFailure } from './overview-api'
import type { OverviewRow } from './types'

/**
 * The overview's analysis (#2581 coverage, #2612 health): a health score per
 * form with what costs it points, and — on demand — how many of the newest
 * records land on each form, flagging forms nobody gets and record rules
 * that match no record. Rows read both through context, so the table code
 * only mounts two small cells.
 */

interface Analysis {
  health: Map<number, HealthRow>
  coverage: CoverageResult | null
}

const AnalysisContext = createContext<Analysis>({ health: new Map(), coverage: null })

export function useOverviewAnalysis(collection: string, hasRows: boolean) {
  const client = useNivaroClient()
  const { data: healthRows = [] } = useLayoutHealth(collection, hasRows)
  const [coverage, setCoverage] = useState<{ collection: string; result: CoverageResult } | null>(
    null
  )
  const [checking, setChecking] = useState(false)
  const [worstFirst, setWorstFirst] = useState(false)
  const health = useMemo(() => new Map(healthRows.map((h) => [h.layout_id, h])), [healthRows])
  const current = coverage?.collection === collection ? coverage.result : null

  const check = async (fresh: boolean) => {
    setChecking(true)
    try {
      setCoverage({ collection, result: await fetchCoverage(client, collection, fresh) })
    } catch (err) {
      toast.error(apiFailure(err, 'Could not check the records').message)
    } finally {
      setChecking(false)
    }
  }

  const value = useMemo<Analysis>(() => ({ health, coverage: current }), [health, current])
  return { value, check, checking, worstFirst, setWorstFirst }
}

export function AnalysisProvider({ value, children }: { value: Analysis; children: ReactNode }) {
  return <AnalysisContext.Provider value={value}>{children}</AnalysisContext.Provider>
}

/** Rows of one section, worst health first (rows without a score keep their place last). */
export function sortWorstFirst(rows: OverviewRow[], health: Map<number, HealthRow>): OverviewRow[] {
  return rows
    .map((r, i) => ({ r, i, s: health.get(r.layout_id)?.score ?? 101 }))
    .sort((a, b) => a.s - b.s || a.i - b.i)
    .map((x) => x.r)
}

const HEALTH_DOT = (score: number) =>
  score >= 80 ? 'bg-emerald-500' : score >= 60 ? 'bg-amber-500' : 'bg-red-500'

/** "● Health 72": a word with the number, so it never reads as a count. */
export function HealthChip({ layoutId }: { layoutId: number }) {
  const h = useContext(AnalysisContext).health.get(layoutId)
  if (!h) return null
  const tip = h.costs.length
    ? `Health ${h.score}/100 — ${h.costs.map((c) => `${c.label} (−${c.points})`).join(', ')}`
    : `Health ${h.score}/100 — nothing costs this form points`
  return (
    <span
      data-health={h.score}
      data-tip={tip}
      className='inline-flex items-center gap-1 whitespace-nowrap rounded-full bg-slate-100 px-1.5 py-px text-[11px] font-medium tabular-nums text-slate-600 dark:bg-muted dark:text-muted-foreground'
    >
      <span aria-hidden className={cn('h-1.5 w-1.5 rounded-full', HEALTH_DOT(h.score))} />
      Health {h.score}
      <span className='sr-only'> out of 100</span>
    </span>
  )
}

export interface CoverageFlag {
  tone: 'muted' | 'warn'
  text: string
}

/** What the sample says about one overview row. Pure. */
export function coverageFlags(row: OverviewRow, cov: CoverageResult): CoverageFlag[] {
  if (row.section !== 'forms') return []
  const c: CoverageRow | undefined = cov.rows.find((r) => r.layout_id === row.layout_id)
  if (!c) return []
  if (row.reason.kind === 'role')
    return [{ tone: 'muted', text: 'Chosen by role, so not counted in the sample' }]
  const n = cov.sampled
  const out: CoverageFlag[] = []
  if (c.records > 0)
    out.push({
      tone: 'muted',
      text: `${c.records.toLocaleString()} of ${n.toLocaleString()} sampled records open with it`
    })
  if (c.rule_matches === 0 && n > 0)
    out.push({ tone: 'warn', text: 'Its record rules match none of the sampled records' })
  else if (c.records === 0 && n > 0)
    out.push({
      tone: 'warn',
      text:
        c.rule_matches != null
          ? `Nobody gets it: its rules match ${c.rule_matches.toLocaleString()} sampled records, but other forms win them`
          : 'Nobody gets it in the sample'
    })
  return out
}

export function CoverageNote({ row }: { row: OverviewRow }) {
  const cov = useContext(AnalysisContext).coverage
  if (!cov) return null
  const flags = coverageFlags(row, cov)
  return (
    <>
      {flags.map((f) => (
        <div
          key={f.text}
          data-coverage-flag={f.tone}
          className={cn(
            'mt-1 flex items-start gap-1 text-[11.5px]',
            f.tone === 'warn'
              ? 'text-amber-700 dark:text-amber-300'
              : 'text-slate-500 dark:text-muted-foreground'
          )}
        >
          {f.tone === 'warn' && <AlertTriangle className='mt-[2px] h-3 w-3 shrink-0' />}
          {f.text}
        </div>
      ))}
    </>
  )
}

/** Rows of the overview's Analyze menu: coverage, worst first, compare forms. */
export function AnalysisButtons({
  hasCoverage,
  checking,
  onCheck,
  worstFirst,
  onWorstFirst,
  onCompare
}: {
  hasCoverage: boolean
  checking: boolean
  onCheck: () => void
  worstFirst: boolean
  onWorstFirst: (v: boolean) => void
  /** Two forms side by side; absent with fewer than two forms. */
  onCompare?: () => void
}) {
  return (
    <>
      <ToolButton
        label={checking ? 'Checking…' : hasCoverage ? 'Check coverage again' : 'Check coverage'}
        icon={<ScanSearch className='h-3.5 w-3.5' />}
        hint='Run the newest records through the same matching the record page uses'
        disabled={checking}
        onClick={onCheck}
        data={{ 'data-analyze-coverage': '' }}
      />
      <ToolButton
        label='Worst first'
        icon={<ArrowDownWideNarrow className='h-3.5 w-3.5' />}
        hint='Sort each section by health, worst first'
        checked={worstFirst}
        onClick={() => onWorstFirst(!worstFirst)}
        data={{ 'data-analyze-worst-first': '' }}
      />
      {onCompare && (
        <ToolButton
          label='Compare forms…'
          icon={<Columns2 className='h-3.5 w-3.5' />}
          hint='Two forms side by side, with their differences'
          onClick={onCompare}
          data={{ 'data-analyze-compare': '' }}
        />
      )}
    </>
  )
}

/** The coverage part of the findings strip: what the sample said, and Check again. */
export function CoverageSummary({
  rows,
  checking,
  onRecheck
}: {
  rows: OverviewRow[]
  checking: boolean
  onRecheck: () => void
}) {
  const cov = useContext(AnalysisContext).coverage
  if (!cov) return null
  const nobody = rows.filter((r) => coverageFlags(r, cov).some((f) => f.tone === 'warn')).length
  return (
    <span
      data-coverage-strip=''
      role='status'
      data-tip={`Checked the ${cov.sampled.toLocaleString()} newest records, as an administrator sees them${cov.rule_error ? '. A record rule names a column this table lacks, so no record rule matches.' : ''}`}
      className='inline-flex min-w-0 items-center gap-1.5 text-[12px] text-slate-600 dark:text-muted-foreground'
    >
      <ScanSearch className='h-3.5 w-3.5 shrink-0' />
      <span className='min-w-0 truncate'>
        Coverage:{' '}
        {nobody > 0 ? (
          <b className='font-semibold text-amber-800 dark:text-amber-200'>
            {nobody} {nobody === 1 ? 'form gets' : 'forms get'} no records
          </b>
        ) : (
          'every form gets records'
        )}
        {cov.no_form > 0 && ` · ${cov.no_form.toLocaleString()} records match no form`}
        {cov.rule_error && ' · a record rule names a missing column'}
      </span>
      <button
        type='button'
        className='inline-flex h-7 shrink-0 items-center gap-1 rounded-md px-2 text-[12px] font-medium text-slate-700 hover:bg-muted dark:text-foreground'
        disabled={checking}
        onClick={onRecheck}
      >
        <RefreshCw className={cn('h-3.5 w-3.5', checking && 'animate-spin')} />
        Check again
      </button>
    </span>
  )
}

/** The last coverage check of this collection (null before one ran). */
export function useCoverageResult(): CoverageResult | null {
  return useContext(AnalysisContext).coverage
}
