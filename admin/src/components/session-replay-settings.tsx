import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Plus, Trash2, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Link } from 'react-router'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { api } from '@/lib/api'
import { useSettings } from '@/lib/useSettings'
import {
  normalizeReplayMasking,
  type ReplayMaskingRules
} from '../../../packages/shared/src/lib/replay-masking'
import { normalizeReplaySampling } from '../../../packages/shared/src/lib/replay-sampling'

/**
 * Settings → Session replay. The on/off switches and retention stay beside
 * the recordings (Session Replays page); this section holds the policy the
 * recorders apply: what is masked (#1361) and what recording may cost — a
 * daily byte cap and per-route sampling (#1368). Each card saves its own keys.
 */

type ReplaySettingsRow = Record<string, unknown>

const FIELD_KEY = /^(\*|[A-Za-z0-9_-]{1,64})\.([A-Za-z0-9_-]{1,64})$/

function apiError(e: unknown, fallback: string): string {
  return (e as { response?: { data?: { error?: string } } })?.response?.data?.error ?? fallback
}

function useSaveSettings(okMessage: string, failMessage: string, onSaved?: () => void) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (patch: Record<string, unknown>) => api.patch('/settings', patch),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['settings'] })
      qc.invalidateQueries({ queryKey: ['session-recording-enabled'] })
      onSaved?.()
      toast.success(okMessage)
    },
    onError: (e: unknown) => toast.error(apiError(e, failMessage))
  })
}

function Card({
  title,
  intro,
  children,
  ...rest
}: {
  title: string
  intro: React.ReactNode
  children: React.ReactNode
} & React.HTMLAttributes<HTMLElement>) {
  return (
    <section
      {...rest}
      className='rounded-lg border border-slate-200 bg-white p-5 dark:border-border dark:bg-card'
    >
      <h3 className='text-[13px] font-semibold text-slate-900 dark:text-foreground'>{title}</h3>
      <p className='mb-4 mt-1 max-w-[72ch] text-[12px] text-muted-foreground'>{intro}</p>
      {children}
    </section>
  )
}

// ── #1361 Masking rules ──────────────────────────────────────────────────────

function MaskingCard({ settings }: { settings: ReplaySettingsRow | undefined }) {
  const stored = settings?.replay_masking
  const [draft, setDraft] = useState<ReplayMaskingRules>(() => normalizeReplayMasking(stored))
  const [dirty, setDirty] = useState(false)
  const [entry, setEntry] = useState('')
  useEffect(() => {
    if (!dirty) setDraft(normalizeReplayMasking(stored))
  }, [stored, dirty])
  const save = useSaveSettings(
    'Masking rules saved — recorders pick them up on their next page load',
    'Could not save the masking rules',
    () => setDirty(false)
  )
  const edit = (patch: Partial<ReplayMaskingRules>) => {
    setDraft((d) => ({ ...d, ...patch }))
    setDirty(true)
  }
  const key = entry.trim()
  const valid = FIELD_KEY.test(key)
  const add = () => {
    if (!valid || draft.allow_fields.includes(key)) return
    edit({ allow_fields: [...draft.allow_fields, key] })
    setEntry('')
  }

  return (
    <Card
      data-replay-masking
      title='Masking'
      intro={
        <>
          Every input is masked, and so is the value of every field on a record — in the edit form
          and the read view. Allow a field that is safe to watch (a status, a code) and it shows in
          replays; everything else stays masked. Rich text and file names follow their own switches,
          even in an allowed field.
        </>
      }
    >
      <div className='space-y-3'>
        <div className='flex items-center justify-between gap-4 text-[12.5px]'>
          <span>
            Mask rich text
            <span className='block text-[11px] text-muted-foreground'>
              Editors (notes, descriptions, comments) show as asterisks.
            </span>
          </span>
          <Switch
            aria-label='Mask rich text'
            checked={draft.mask_rich_text}
            onCheckedChange={(v) => edit({ mask_rich_text: v })}
          />
        </div>
        <div className='flex items-center justify-between gap-4 text-[12.5px]'>
          <span>
            Mask file names
            <span className='block text-[11px] text-muted-foreground'>
              File names are masked and file thumbnails blocked, in fields and the file library.
            </span>
          </span>
          <Switch
            aria-label='Mask file names'
            checked={draft.mask_file_names}
            onCheckedChange={(v) => edit({ mask_file_names: v })}
          />
        </div>
        <div>
          <Label className='text-[12px] font-medium'>Fields shown unmasked</Label>
          <div className='mt-1.5 flex gap-2'>
            <Input
              data-replay-allow-input
              value={entry}
              placeholder='orders.status  or  *.code'
              className='h-8 font-mono text-[12px]'
              onChange={(e) => setEntry(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  add()
                }
              }}
            />
            <Button type='button' size='sm' variant='outline' onClick={add} disabled={!valid}>
              <Plus className='mr-1 h-3.5 w-3.5' /> Allow
            </Button>
          </div>
          {key && !valid && (
            <p className='mt-1 text-[11px] text-amber-600'>
              Use collection.field — the field's key, not its label. * matches any collection.
            </p>
          )}
          <div className='mt-2 flex flex-wrap gap-1.5'>
            {draft.allow_fields.length === 0 ? (
              <span className='text-[11.5px] text-muted-foreground'>
                None — every field value is masked.
              </span>
            ) : (
              draft.allow_fields.map((f) => (
                <span
                  key={f}
                  data-replay-allowed={f}
                  className='inline-flex items-center gap-1 rounded-full border border-slate-200 bg-slate-50 py-0.5 pl-2.5 pr-1 font-mono text-[11.5px] dark:border-border dark:bg-muted'
                >
                  {f}
                  <button
                    type='button'
                    aria-label={`Mask ${f} again`}
                    className='rounded-full p-0.5 text-slate-400 hover:bg-slate-200 hover:text-slate-700 dark:hover:bg-muted-foreground/20'
                    onClick={() =>
                      edit({ allow_fields: draft.allow_fields.filter((x) => x !== f) })
                    }
                  >
                    <X className='h-3 w-3' />
                  </button>
                </span>
              ))
            )}
          </div>
        </div>
        <div className='flex justify-end border-t border-slate-100 pt-3 dark:border-border'>
          <Button
            size='sm'
            onClick={() => save.mutate({ replay_masking: draft })}
            disabled={!dirty || save.isPending}
          >
            {save.isPending ? 'Saving…' : 'Save masking'}
          </Button>
        </div>
      </div>
    </Card>
  )
}

// ── #1368 Recording cost: daily cap + per-route sampling ─────────────────────

const pctOf = (share: number) => String(Math.round(share * 1000) / 10)

function readCostDraft(settings: ReplaySettingsRow | undefined) {
  const s = normalizeReplaySampling(settings?.replay_sampling)
  const cap = Number(settings?.replay_daily_cap_mb)
  return {
    cap: Number.isFinite(cap) && cap > 0 ? String(cap) : '',
    defaultPct: pctOf(s.default),
    routes: Object.entries(s.routes).map(([route, share]) => ({ route, pct: pctOf(share) }))
  }
}

const ROUTE_KEY = /^\/[\w.:*/-]*$/

function CostCard({ settings }: { settings: ReplaySettingsRow | undefined }) {
  const stored = `${settings?.replay_daily_cap_mb ?? ''}|${settings?.replay_sampling ?? ''}`
  const [draft, setDraft] = useState(() => readCostDraft(settings))
  const [dirty, setDirty] = useState(false)
  // biome-ignore lint/correctness/useExhaustiveDependencies: `stored` is the settings' fingerprint
  useEffect(() => {
    if (!dirty) setDraft(readCostDraft(settings))
  }, [stored, dirty])
  // The routes that cost the most this week, offered as suggestions.
  const usage = useQuery({
    queryKey: ['ops', '/ops-db/session-replay'],
    queryFn: () =>
      api
        .get<{ data: { by_route: Array<{ route: string }> } }>('/ops-db/session-replay')
        .then((r) => r.data.data.by_route.map((x) => x.route).filter(Boolean)),
    staleTime: 60_000
  })
  const save = useSaveSettings(
    'Recording limits saved — recorders pick them up on their next page load',
    'Could not save the recording limits',
    () => setDirty(false)
  )
  const edit = (fn: (d: typeof draft) => typeof draft) => {
    setDraft(fn)
    setDirty(true)
  }
  const pctOk = (v: string) => v.trim() !== '' && Number(v) >= 0 && Number(v) <= 100
  const rowsOk = draft.routes.every((r) => ROUTE_KEY.test(r.route.trim()) && pctOk(r.pct))
  const capOk = draft.cap.trim() === '' || /^\d+$/.test(draft.cap.trim())
  const valid = rowsOk && capOk && pctOk(draft.defaultPct)

  const submit = () => {
    const routes: Record<string, number> = {}
    for (const r of draft.routes) routes[r.route.trim()] = Number(r.pct) / 100
    save.mutate({
      replay_daily_cap_mb: draft.cap.trim() === '' ? null : Number(draft.cap),
      replay_sampling: { default: Number(draft.defaultPct) / 100, routes }
    })
  }

  return (
    <Card
      data-replay-cost
      title='Recording cost'
      intro={
        <>
          A cap on what the whole instance records per day, and the share of sessions recorded on
          each page. DB Health shows what recording costs per page and per build.
        </>
      }
    >
      <div className='space-y-4'>
        <div className='grid grid-cols-2 gap-4'>
          <div>
            <Label className='text-[12px] font-medium'>Daily cap (MB stored)</Label>
            <Input
              data-replay-cap
              inputMode='numeric'
              value={draft.cap}
              placeholder='No cap'
              className='mt-1 h-8'
              onChange={(e) => edit((d) => ({ ...d, cap: e.target.value }))}
            />
            <p className='mt-1 text-[11px] text-muted-foreground'>
              Once today's recordings (UTC) reach it, recorders stop until tomorrow.
            </p>
          </div>
          <div>
            <Label className='text-[12px] font-medium'>Sessions recorded (%)</Label>
            <Input
              data-replay-default-rate
              inputMode='decimal'
              value={draft.defaultPct}
              className='mt-1 h-8'
              onChange={(e) => edit((d) => ({ ...d, defaultPct: e.target.value }))}
            />
            <p className='mt-1 text-[11px] text-muted-foreground'>
              On any page without its own rule below.
            </p>
          </div>
        </div>
        <div>
          <div className='flex items-center justify-between'>
            <Label className='text-[12px] font-medium'>Per page</Label>
            <Button
              type='button'
              size='sm'
              variant='outline'
              onClick={() =>
                edit((d) => ({ ...d, routes: [...d.routes, { route: '', pct: '10' }] }))
              }
            >
              <Plus className='mr-1 h-3.5 w-3.5' /> Add page
            </Button>
          </div>
          <p className='mt-1 text-[11px] text-muted-foreground'>
            A page pattern as DB Health lists it (/content/orders/:id), or a prefix ending in /* for
            every page under it. The most specific rule wins; 0% never records the page.
          </p>
          <datalist id='replay-route-suggestions'>
            {(usage.data ?? []).map((r) => (
              <option key={r} value={r} />
            ))}
          </datalist>
          <div className='mt-2 space-y-2'>
            {draft.routes.map((r, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: rows are edited in place
              <div key={i} className='flex items-center gap-2'>
                <Input
                  data-replay-route={i}
                  list='replay-route-suggestions'
                  value={r.route}
                  placeholder='/content/orders/:id'
                  className={`h-8 flex-1 font-mono text-[12px] ${
                    r.route && !ROUTE_KEY.test(r.route.trim()) ? 'border-amber-500' : ''
                  }`}
                  onChange={(e) =>
                    edit((d) => ({
                      ...d,
                      routes: d.routes.map((x, j) =>
                        j === i ? { ...x, route: e.target.value } : x
                      )
                    }))
                  }
                />
                <Input
                  aria-label='Percent of sessions recorded'
                  inputMode='decimal'
                  value={r.pct}
                  className='h-8 w-20'
                  onChange={(e) =>
                    edit((d) => ({
                      ...d,
                      routes: d.routes.map((x, j) => (j === i ? { ...x, pct: e.target.value } : x))
                    }))
                  }
                />
                <span className='text-[12px] text-muted-foreground'>%</span>
                <Button
                  type='button'
                  size='sm'
                  variant='ghost'
                  aria-label='Remove this page rule'
                  onClick={() =>
                    edit((d) => ({ ...d, routes: d.routes.filter((_, j) => j !== i) }))
                  }
                >
                  <Trash2 className='h-3.5 w-3.5' />
                </Button>
              </div>
            ))}
          </div>
        </div>
        <div className='flex items-center justify-end gap-3 border-t border-slate-100 pt-3 dark:border-border'>
          {!valid && (
            <span className='text-[11px] text-amber-600'>
              Percentages run 0–100; the cap is whole megabytes; a page starts with /.
            </span>
          )}
          <Button size='sm' onClick={submit} disabled={!dirty || !valid || save.isPending}>
            {save.isPending ? 'Saving…' : 'Save limits'}
          </Button>
        </div>
      </div>
    </Card>
  )
}

export function SessionReplaySettingsSection() {
  const { data } = useSettings()
  const settings = data as ReplaySettingsRow | undefined
  return (
    <div className='p-8'>
      <div className='max-w-2xl'>
        <h2 className='text-[15px] font-semibold tracking-[-0.01em] text-slate-900 dark:text-foreground'>
          Session replay
        </h2>
        <p className='mb-6 mt-1 text-[12px] text-muted-foreground'>
          Recording on/off, error clips and how long recordings are kept live on the{' '}
          <Link to='/session-replays' className='underline'>
            Session Replays
          </Link>{' '}
          page. These settings shape what the recorders capture.
        </p>
        <div className='space-y-5'>
          <MaskingCard settings={settings} />
          <CostCard settings={settings} />
        </div>
      </div>
    </div>
  )
}
