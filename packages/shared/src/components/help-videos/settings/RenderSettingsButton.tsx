import { useQuery, useQueryClient } from '@tanstack/react-query'
import { SlidersHorizontal } from 'lucide-react'
import { useEffect, useId, useState } from 'react'
import { useItemEditAuth, useNivaroClient } from '../../../context'
import { TipLayer } from '../../TipLayer'
import { Button } from '../../ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '../../ui/popover'
import { SimpleSelect } from '../../ui/SimpleSelect'
import { Switch } from '../../ui/switch'
import { helpVideoError } from '../api'
import {
  type EncoderSettings,
  type HelpVideoSettingsDto,
  helpVideoSettingsApi,
  helpVideoSettingsKeys
} from './api'

const PRESET_LABELS: Record<string, string> = {
  ultrafast: 'Fastest, largest files',
  superfast: 'Very fast',
  veryfast: 'Fast (default)',
  faster: 'Faster than balanced',
  fast: 'Balanced',
  medium: 'Smaller files',
  slow: 'Slow, small files',
  slower: 'Slowest, smallest files'
}
const HARDWARE_NAMES: Record<string, string> = {
  videotoolbox: 'VideoToolbox',
  vaapi: 'VAAPI'
}

const noteClass = 'text-[12px] text-muted-foreground'
const labelClass = 'text-[12.5px] font-medium text-foreground'
const warnClass =
  'rounded-md border border-amber-300 bg-amber-50 px-2.5 py-1.5 text-[12.5px] text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-200'
const errorClass =
  'rounded-md border border-rose-200 bg-rose-50 px-2.5 py-1.5 text-[12.5px] text-rose-800 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-200'
const inputClass =
  'h-8 w-20 rounded-md border border-border bg-background px-2 text-[13px] tabular-nums text-foreground disabled:opacity-60'

function FromEnv({ dto, k }: { dto: HelpVideoSettingsDto; k: keyof EncoderSettings }) {
  if (dto.sources[k] !== 'env') return null
  return (
    <span className='ml-1.5 text-[11px] font-normal text-muted-foreground' data-tip={dto.env[k]}>
      from the server environment
    </span>
  )
}

/** How help-video renders are encoded (#1561). Administrators only. */
export function RenderSettingsButton() {
  const { isAdmin } = useItemEditAuth()
  const client = useNivaroClient()
  const qc = useQueryClient()
  const ids = { crf: useId(), twoPass: useId(), hw: useId() }
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState<EncoderSettings | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const settings = useQuery({
    queryKey: helpVideoSettingsKeys.settings,
    enabled: isAdmin && open,
    queryFn: () => helpVideoSettingsApi(client).settings()
  })
  const dto = settings.data
  useEffect(() => {
    if (dto && open) setDraft(dto.encoder)
  }, [dto, open])
  if (!isAdmin) return null

  const migrated = dto?.migrated !== false
  const changed = (d: EncoderSettings) =>
    dto
      ? (Object.keys(d) as Array<keyof EncoderSettings>).filter((k) => d[k] !== dto.encoder[k])
      : []
  const save = async (patchBody: Partial<Record<keyof EncoderSettings, unknown>>) => {
    setSaving(true)
    setError(null)
    setSaved(false)
    try {
      const next = await helpVideoSettingsApi(client).saveEncoder(patchBody)
      qc.setQueryData(helpVideoSettingsKeys.settings, next)
      setDraft(next.encoder)
      setSaved(true)
    } catch (e) {
      const err = helpVideoError(e)
      setError(
        err?.code === 'HELP_VIDEO_SETTINGS_MIGRATION_PENDING'
          ? 'Not saved: this database needs the update that adds these settings (migration 410).'
          : `Not saved. ${(e as Error).message}`
      )
    } finally {
      setSaving(false)
    }
  }
  const recheck = async () => {
    const next = await helpVideoSettingsApi(client)
      .settings(true)
      .catch(() => null)
    if (next) qc.setQueryData(helpVideoSettingsKeys.settings, next)
  }
  const d = draft
  const dirty = d ? changed(d) : []
  const hw = dto?.hardware
  const hwLine = !hw
    ? null
    : hw.available.length
      ? `This server can use ${hw.available.map((k) => HARDWARE_NAMES[k] ?? k).join(' and ')}.`
      : hw.failed.length
        ? `This server has ${hw.failed.map((f) => HARDWARE_NAMES[f.kind] ?? f.kind).join(' and ')} but it did not work, so renders use software.`
        : 'This server has no hardware encoder, so renders use software.'

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o)
        if (!o) {
          setError(null)
          setSaved(false)
        }
      }}
    >
      <PopoverTrigger asChild>
        <Button size='sm' variant='outline' data-hv-render-settings>
          <SlidersHorizontal className='mr-1 h-4 w-4' aria-hidden /> Render settings
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align='end'
        className='w-[min(380px,calc(100vw-2rem))] space-y-3 text-[13px]'
        data-hv-render-settings-panel
      >
        <TipLayer />
        <div>
          <p className='text-[13.5px] font-semibold text-foreground'>Render settings</p>
          <p className={noteClass}>
            How published videos are encoded. Changes apply to the next render; videos already
            rendered keep their file.
          </p>
        </div>
        {settings.isError ? (
          <p className={errorClass} role='alert'>
            The settings could not be loaded.{' '}
            <button type='button' className='underline' onClick={() => void settings.refetch()}>
              Try again
            </button>
          </p>
        ) : !d || !dto ? (
          <p className={noteClass} role='status'>
            Loading…
          </p>
        ) : (
          <>
            {!migrated && (
              <p className={warnClass} data-hv-settings-migration>
                These settings need a database update (migration 410) before they can be saved.
                Renders use the values shown.
              </p>
            )}
            <div className='space-y-1'>
              <label htmlFor={ids.crf} className={labelClass}>
                Quality
                <FromEnv dto={dto} k='crf' />
              </label>
              <div className='flex items-center gap-2'>
                <input
                  id={ids.crf}
                  type='number'
                  min={dto.limits.crf_min}
                  max={dto.limits.crf_max}
                  step={1}
                  value={d.crf}
                  disabled={!migrated}
                  onChange={(e) => setDraft({ ...d, crf: Number(e.target.value) })}
                  className={inputClass}
                  data-hv-settings-crf
                />
                <span className={noteClass}>
                  CRF {dto.limits.crf_min}–{dto.limits.crf_max}. Lower is sharper and larger; 23 is
                  the default.
                </span>
              </div>
            </div>
            <div className='space-y-1'>
              <span className={labelClass}>
                Speed
                <FromEnv dto={dto} k='preset' />
              </span>
              <SimpleSelect
                value={d.preset}
                onChange={(v) => setDraft({ ...d, preset: v as EncoderSettings['preset'] })}
                options={dto.limits.presets.map((p) => ({
                  value: p,
                  label: `${p} · ${PRESET_LABELS[p] ?? p}`
                }))}
                ariaLabel='Speed'
                disabled={!migrated}
                className='h-8 w-full text-[13px]'
                triggerProps={{ 'data-hv-settings-preset': '' }}
              />
            </div>
            <div className='space-y-1'>
              <label htmlFor={ids.twoPass} className={labelClass}>
                Two-pass encoding
                <FromEnv dto={dto} k='two_pass_over_minutes' />
              </label>
              <div className='flex items-center gap-2'>
                <span className={noteClass}>For videos longer than</span>
                <input
                  id={ids.twoPass}
                  type='number'
                  min={0}
                  max={dto.limits.two_pass_max_minutes}
                  step={1}
                  value={d.two_pass_over_minutes}
                  disabled={!migrated}
                  onChange={(e) =>
                    setDraft({ ...d, two_pass_over_minutes: Number(e.target.value) })
                  }
                  className={inputClass}
                  data-hv-settings-two-pass
                />
                <span className={noteClass}>min (0 = never)</span>
              </div>
              <p className={noteClass}>
                Two passes take about twice as long and keep a long video's file size steady.
                Software only.
              </p>
            </div>
            <div className='space-y-1'>
              <div className='flex items-center justify-between gap-3'>
                <label htmlFor={ids.hw} className={labelClass}>
                  Use a hardware encoder when this server has one
                  <FromEnv dto={dto} k='hardware' />
                </label>
                <Switch
                  id={ids.hw}
                  checked={d.hardware === 'auto'}
                  disabled={!migrated}
                  onCheckedChange={(on) => setDraft({ ...d, hardware: on ? 'auto' : 'off' })}
                  data-hv-settings-hardware
                />
              </div>
              <p className={noteClass}>
                Faster renders with less load on the server. Hardware encoders ignore Speed and aim
                at a bitrate set from Quality. If one fails, the video is encoded again in software.
              </p>
              {hwLine && (
                <p className={noteClass} data-hv-settings-hw-status>
                  {hwLine}{' '}
                  <button
                    type='button'
                    className='underline underline-offset-2 hover:text-foreground'
                    onClick={() => void recheck()}
                  >
                    Check again
                  </button>
                </p>
              )}
            </div>
            {error && (
              <p className={errorClass} role='alert'>
                {error}
              </p>
            )}
            <div className='flex items-center justify-between gap-2 pt-1'>
              <Button
                size='sm'
                variant='ghost'
                disabled={!migrated || saving || Object.keys(dto.stored.encoder).length === 0}
                onClick={() =>
                  void save({
                    preset: null,
                    crf: null,
                    two_pass_over_minutes: null,
                    hardware: null
                  })
                }
                data-hv-settings-reset
              >
                Use the defaults
              </Button>
              <div className='flex items-center gap-2'>
                {saved && !dirty.length && (
                  <span
                    className='text-[12px] text-emerald-700 dark:text-emerald-300'
                    role='status'
                  >
                    Saved
                  </span>
                )}
                <Button
                  size='sm'
                  disabled={!migrated || saving || !dirty.length}
                  onClick={() => void save(Object.fromEntries(dirty.map((k) => [k, d[k]])))}
                  data-hv-settings-save
                >
                  {saving ? 'Saving…' : 'Save'}
                </Button>
              </div>
            </div>
          </>
        )}
      </PopoverContent>
    </Popover>
  )
}
