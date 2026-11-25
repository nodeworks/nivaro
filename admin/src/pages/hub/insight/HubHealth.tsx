import { QueryErrorState, toastError, useUnsavedWork } from '@nivaro/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Mail, SlidersHorizontal } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router'
import { toast } from 'sonner'
import { envTone } from '@/components/hub-brand/env-tone'
import { HubEnvTag } from '@/components/hub-brand/HubBits'
import { HubToolbar } from '@/components/hub-page'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { SimpleSelect } from '@/components/ui/simple-select'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { useAuth } from '@/lib/auth'
import { cn } from '@/lib/utils'
import { ghostButton, SectionCard } from '../hub-parts'
import { HealthScore } from './HealthScore'
import {
  type EnvHealth,
  fetchDigestMe,
  fetchHealth,
  fetchInsightSettings,
  HEALTH_PARTS,
  type HealthPart,
  type InsightSettings,
  insightKeys,
  PART_HINT,
  PART_LABEL,
  type PartScore,
  saveDigestMe,
  saveInsightSettings
} from './insight-api'

/**
 * Health (Apps hub tab): one 0–100 score per environment, built from figures other Hub tabs
 * already keep (Fleet uptime and drift, Capacity error rate, the readiness and issues the app
 * reports, Backups & data, Secrets) — the page shows each part beside the score so a low number
 * always says why. Admins set the weights; everyone sets their own weekly digest.
 */

type Band = 'any' | 'good' | 'fair' | 'poor' | 'none'
const BANDS: readonly Band[] = ['any', 'good', 'fair', 'poor', 'none']

export default function HubHealth() {
  const { user } = useAuth()
  const isAdmin = !!(user as { is_admin?: boolean } | null)?.is_admin
  const navigate = useNavigate()
  const health = useQuery({
    queryKey: insightKeys.health(),
    queryFn: fetchHealth,
    staleTime: 60_000,
    refetchInterval: 5 * 60_000
  })
  const [params, setParams] = useSearchParams()
  const app = params.get('app') ?? ''
  const band = (BANDS as readonly string[]).includes(params.get('band') ?? '')
    ? (params.get('band') as Band)
    : 'any'
  const set = (k: string, v: string, empty = '') =>
    setParams(
      (p) => {
        const out = new URLSearchParams(p)
        if (v && v !== empty) out.set(k, v)
        else out.delete(k)
        return out
      },
      { replace: true }
    )
  const [weightsOpen, setWeightsOpen] = useState(false)

  const rows = useMemo(() => health.data?.environments ?? [], [health.data])
  const apps = useMemo(() => {
    const m = new Map<number, string>()
    for (const r of rows) m.set(r.app_id, r.app_name)
    return [...m].sort((a, b) => a[1].localeCompare(b[1]))
  }, [rows])
  const shown = useMemo(
    () =>
      rows
        .filter((r) => !app || String(r.app_id) === app)
        .filter((r) =>
          band === 'any' ? true : band === 'none' ? r.score == null : r.band === band
        ),
    [rows, app, band]
  )
  const poor = rows.filter((r) => r.band === 'poor').length
  const weights = health.data?.weights

  return (
    <div className='flex flex-1 min-h-0 flex-col overflow-y-auto bg-slate-50 dark:bg-background'>
      <HubToolbar
        description={
          <>
            {health.data
              ? `${rows.length} environment${rows.length === 1 ? '' : 's'}, scored 0–100.`
              : 'A 0–100 score per environment, and what lowers it.'}
            {poor > 0 && (
              <>
                {' '}
                <button
                  type='button'
                  aria-pressed={band === 'poor'}
                  onClick={() => set('band', band === 'poor' ? '' : 'poor', 'any')}
                  className={cn(
                    'rounded-md px-1.5 py-0.5 text-[12px] font-medium text-red-700 hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/50 dark:text-red-300',
                    band === 'poor' && 'bg-accent'
                  )}
                >
                  {poor} poor
                </button>
              </>
            )}
          </>
        }
        actions={
          <>
            <Link
              to='/docs?section=hub-insight'
              className='px-2 text-[12px] text-slate-500 hover:underline dark:text-muted-foreground'
            >
              How the score works
            </Link>
            {isAdmin && (
              <button
                type='button'
                className={cn(ghostButton, weightsOpen && 'bg-accent')}
                aria-expanded={weightsOpen}
                onClick={() => setWeightsOpen((o) => !o)}
              >
                <SlidersHorizontal className='h-3.5 w-3.5' aria-hidden />
                Weights
              </button>
            )}
          </>
        }
      >
        <div className='mt-2 flex flex-wrap items-center gap-2'>
          <SimpleSelect
            value={app}
            onChange={(v) => set('app', v)}
            ariaLabel='App'
            className='h-8 w-[170px] text-[12px]'
            options={[
              { value: '', label: 'Every app' },
              ...apps.map(([id, name]) => ({ value: String(id), label: name }))
            ]}
          />
          <SimpleSelect
            value={band}
            onChange={(v) => set('band', v, 'any')}
            ariaLabel='Score'
            className='h-8 w-[150px] text-[12px]'
            options={[
              { value: 'any', label: 'Any score' },
              { value: 'good', label: 'Good (90+)' },
              { value: 'fair', label: 'Fair (70–89)' },
              { value: 'poor', label: 'Poor (below 70)' },
              { value: 'none', label: 'No score yet' }
            ]}
          />
        </div>
      </HubToolbar>

      <div className='space-y-4 p-4 sm:p-6'>
        {isAdmin && weightsOpen && <WeightsCard onClose={() => setWeightsOpen(false)} />}
        <DigestCard />
        {health.isPending ? (
          <div className='space-y-2'>
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className='h-12 w-full' />
            ))}
          </div>
        ) : health.isError ? (
          <QueryErrorState
            error={health.error}
            what='the health scores'
            onRetry={() => void health.refetch()}
          />
        ) : rows.length === 0 ? (
          <div className='rounded-lg border border-dashed border-slate-300 bg-white px-6 py-10 text-center dark:border-border dark:bg-card'>
            <p className='m-0 text-[13px] font-medium text-slate-900 dark:text-foreground'>
              No environments to score
            </p>
            <p className='m-0 mt-1 text-[12px] text-slate-500 dark:text-muted-foreground'>
              Add an app on the Apps tab. Its score appears once the Hub has checked it.
            </p>
          </div>
        ) : (
          <div className='overflow-x-auto rounded-lg border border-slate-200 bg-white dark:border-border dark:bg-card'>
            <table className='w-full min-w-[1100px] border-collapse text-[12px]'>
              <thead>
                <tr className='border-b border-slate-200 text-left text-[11px] font-medium text-slate-500 dark:border-border dark:text-muted-foreground'>
                  <th className='px-3 py-2 font-medium'>App / environment</th>
                  <th className='px-3 py-2 font-medium'>Score</th>
                  {HEALTH_PARTS.map((p) => (
                    <th key={p} className='px-3 py-2 font-medium' data-tip={PART_HINT[p]}>
                      {PART_LABEL[p]}
                      {weights && (
                        <span className='ml-1 font-normal tabular-nums text-slate-400 dark:text-muted-foreground'>
                          ×{weights[p]}
                        </span>
                      )}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {shown.map((r) => (
                  <HealthRow
                    key={r.environment_id}
                    row={r}
                    onOpen={() => navigate(`/hub?app=${r.app_id}`)}
                  />
                ))}
                {shown.length === 0 && (
                  <tr>
                    <td
                      colSpan={2 + HEALTH_PARTS.length}
                      className='px-3 py-8 text-center text-slate-500 dark:text-muted-foreground'
                    >
                      Nothing matches these filters.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}

function HealthRow({ row: r, onOpen }: { row: EnvHealth; onOpen: () => void }) {
  return (
    <tr
      className='border-b border-slate-100 align-top last:border-b-0 hover:bg-slate-50 dark:border-border dark:hover:bg-muted'
      data-env-tone={envTone(r.env_key)}
    >
      <td className='px-3 py-2'>
        <button
          type='button'
          onClick={onOpen}
          className='text-left font-medium text-slate-900 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/50 dark:text-foreground'
        >
          {r.app_name} <span className='text-slate-400'>/</span> {r.env_key}
        </button>
        <HubEnvTag envKey={r.env_key} className='ml-1.5 align-[1px]' />
      </td>
      <td className='px-3 py-2'>
        <HealthScore health={r} />
      </td>
      {HEALTH_PARTS.map((p) => (
        <PartCell key={p} part={r.parts.find((x) => x.part === p)} />
      ))}
    </tr>
  )
}

function PartCell({ part }: { part: PartScore | undefined }) {
  if (!part || part.score == null || part.weight === 0)
    return (
      <td className='px-3 py-2 text-slate-400 dark:text-muted-foreground'>
        <span data-tip={part?.weight === 0 ? 'Weight 0: not counted' : 'No figure yet'}>—</span>
      </td>
    )
  const tone =
    part.score >= 90
      ? 'text-slate-900 dark:text-foreground'
      : part.score >= 70
        ? 'text-amber-700 dark:text-amber-300'
        : 'text-red-700 dark:text-red-300'
  return (
    <td className='max-w-[160px] px-3 py-2'>
      <span className={cn('font-medium tabular-nums', tone)}>{part.score}</span>
      {part.figure && (
        <p
          className='m-0 truncate text-[11px] text-slate-500 dark:text-muted-foreground'
          data-tip={part.figure}
        >
          {part.figure}
        </p>
      )}
    </td>
  )
}

function DigestCard() {
  const qc = useQueryClient()
  const me = useQuery({ queryKey: insightKeys.digest(), queryFn: fetchDigestMe, staleTime: 60_000 })
  const save = useMutation({
    mutationFn: saveDigestMe,
    onSuccess: (d) => {
      qc.setQueryData(insightKeys.digest(), (old: unknown) =>
        old ? { ...(old as object), enabled: d.enabled } : old
      )
      toast.success(d.enabled ? 'Weekly digest on' : 'Weekly digest off')
    },
    onError: (e) => toastError(e, 'Could not change your digest')
  })
  if (!me.data?.owns_apps) return null
  return (
    <div className='flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-slate-200 bg-white px-4 py-3 dark:border-border dark:bg-card'>
      <Mail className='h-4 w-4 shrink-0 text-slate-400' aria-hidden />
      <div className='min-w-0 flex-[1_1_260px]'>
        <p className='m-0 text-[13px] font-medium text-slate-900 dark:text-foreground'>
          Weekly digest
        </p>
        <p className='m-0 text-[12px] text-slate-500 dark:text-muted-foreground'>
          {me.data.delivered
            ? 'Monday mornings: your apps’ deploys, incidents, drift and health, and what is coming up.'
            : 'An administrator has switched the weekly digest off for everyone.'}
        </p>
      </div>
      <div className='flex items-center gap-2 text-[12px] text-slate-600 dark:text-slate-300'>
        <Switch
          id='hub-digest-me'
          checked={me.data.enabled}
          disabled={save.isPending || !me.data.delivered}
          onCheckedChange={(v) => save.mutate(v)}
          aria-label='Send me the weekly digest'
        />
        <label htmlFor='hub-digest-me'>{me.data.enabled ? 'On' : 'Off'}</label>
      </div>
    </div>
  )
}

function WeightsCard({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient()
  const settings = useQuery({ queryKey: insightKeys.settings(), queryFn: fetchInsightSettings })
  const [draft, setDraft] = useState<InsightSettings | null>(null)
  useEffect(() => {
    if (settings.data && !draft) setDraft(settings.data)
  }, [settings.data, draft])
  const dirty =
    !!draft && !!settings.data && JSON.stringify(draft) !== JSON.stringify(settings.data)
  useUnsavedWork(dirty, 'Health score weights')
  const save = useMutation({
    mutationFn: (s: InsightSettings) => saveInsightSettings(s),
    onSuccess: (s) => {
      qc.setQueryData(insightKeys.settings(), s)
      setDraft(s)
      void qc.invalidateQueries({ queryKey: insightKeys.health() })
      void qc.invalidateQueries({ queryKey: insightKeys.usage() })
      toast.success('Saved — scores use the new weights from now on')
    },
    onError: (e) => toastError(e, 'Could not save the weights')
  })
  const allZero = !!draft && HEALTH_PARTS.every((p) => draft.weights[p] === 0)
  const floorBad = !!draft && (draft.usage.floor < 5 || draft.usage.floor > 100)
  return (
    <SectionCard
      title='Weights and privacy'
      description='How much each part counts (0 leaves it out), the usage privacy floor and the weekly digest.'
      actions={
        <>
          <button type='button' className={ghostButton} onClick={onClose}>
            Close
          </button>
          <Button
            size='sm'
            className='h-8 bg-nvr-cyan text-white hover:bg-nvr-cyan/90'
            disabled={!dirty || allZero || floorBad || save.isPending}
            onClick={() => draft && save.mutate(draft)}
          >
            Save
          </Button>
        </>
      }
    >
      {!draft ? (
        <div className='p-4'>
          <Skeleton className='h-16 w-full' />
        </div>
      ) : (
        <div className='space-y-4 p-4'>
          <div className='grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-8'>
            {HEALTH_PARTS.map((p: HealthPart) => (
              <div key={p} className='block text-[12px]'>
                <label
                  htmlFor={`hub-weight-${p}`}
                  className='mb-1 block font-medium text-slate-700 dark:text-slate-200'
                  data-tip={PART_HINT[p]}
                >
                  {PART_LABEL[p]}
                </label>
                <Input
                  id={`hub-weight-${p}`}
                  type='number'
                  min={0}
                  max={10}
                  step={1}
                  value={draft.weights[p]}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      weights: {
                        ...draft.weights,
                        [p]: Math.max(0, Math.min(10, Math.round(Number(e.target.value) || 0)))
                      }
                    })
                  }
                  className='h-8 tabular-nums'
                />
              </div>
            ))}
          </div>
          {allZero && (
            <p className='m-0 text-[12px] text-red-700 dark:text-red-300'>
              At least one part must count.
            </p>
          )}
          <div className='flex flex-wrap items-end gap-x-6 gap-y-3 border-t border-slate-100 pt-4 dark:border-border'>
            <div className='block text-[12px]'>
              <label
                htmlFor='hub-usage-floor'
                className='mb-1 block font-medium text-slate-700 dark:text-slate-200'
              >
                Usage privacy floor (people)
              </label>
              <Input
                id='hub-usage-floor'
                type='number'
                min={5}
                max={100}
                value={draft.usage.floor}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    usage: { ...draft.usage, floor: Math.round(Number(e.target.value) || 0) }
                  })
                }
                className='h-8 w-[110px] tabular-nums'
                aria-invalid={floorBad}
              />
              <span className='mt-1 block text-[11px] text-slate-500 dark:text-muted-foreground'>
                Days and screens with fewer people are never shown. Never below 5.
              </span>
            </div>
            <div className='flex items-center gap-2 pb-5 text-[12px] text-slate-700 dark:text-slate-200'>
              <Switch
                id='hub-digest-all'
                checked={draft.digest.enabled}
                onCheckedChange={(v) => setDraft({ ...draft, digest: { enabled: v } })}
                aria-label='Send the weekly digest to app owners'
              />
              <label htmlFor='hub-digest-all'>Send the weekly digest to app owners</label>
            </div>
          </div>
        </div>
      )}
    </SectionCard>
  )
}
