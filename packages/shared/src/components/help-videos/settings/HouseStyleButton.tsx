import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Palette } from 'lucide-react'
import { useEffect, useId, useState } from 'react'
import { useItemEditAuth, useNivaroClient } from '../../../context'
import { Button } from '../../ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '../../ui/popover'
import { SimpleSelect } from '../../ui/SimpleSelect'
import { Switch } from '../../ui/switch'
import { ANNOTATION_PALETTE } from '../annotationStyles'
import { helpVideoError } from '../api'
import { EDIT_LIMITS, OUTRO_DEFAULT_TEXT } from '../edits'
import { CALLOUT_TEXT_NAMES, type HouseStyle, TONE_NAMES } from '../houseStyle'
import type { Tone } from '../types'
import { helpVideoSettingsApi, helpVideoSettingsKeys } from './api'

const noteClass = 'text-[12px] leading-snug text-muted-foreground'
const labelClass = 'text-[12.5px] font-medium text-foreground'
const groupClass = 'space-y-2 border-t border-border pt-3'
const warnClass =
  'rounded-md border border-amber-300 bg-amber-50 px-2.5 py-1.5 text-[12.5px] text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-200'
const errorClass =
  'rounded-md border border-rose-200 bg-rose-50 px-2.5 py-1.5 text-[12.5px] text-rose-800 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-200'
const segment =
  'h-7 min-w-[36px] border-l border-input px-2 text-[12px] transition-colors duration-150 first:border-l-0 focus-visible:relative focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-nvr-cyan disabled:opacity-60 motion-reduce:transition-none'
const on = 'bg-nvr-cyan/15 font-semibold text-foreground'
const off = 'bg-background text-foreground hover:bg-muted'
const inputClass =
  'h-7 w-16 rounded-md border border-border bg-background px-2 text-[12.5px] tabular-nums text-foreground disabled:opacity-60'

const ANIMATIONS = [
  { value: 'none', label: 'No motion' },
  { value: 'subtle', label: 'Subtle' },
  { value: 'lively', label: 'Lively' }
]
const TRANSITIONS = [
  { value: 'cut', label: 'Cut' },
  { value: 'fade', label: 'Fade' },
  { value: 'fade_black', label: 'Fade through black' },
  { value: 'slide', label: 'Slide' },
  { value: 'zoom', label: 'Zoom' },
  { value: 'wipe', label: 'Wipe' }
]

function Segmented<T extends string>({
  label,
  value,
  choices,
  disabled,
  onChange,
  hook
}: {
  label: string
  value: T
  choices: Array<{ value: T; label: string; swatch?: string }>
  disabled: boolean
  onChange: (v: T) => void
  hook: string
}) {
  return (
    <div className='flex items-center justify-between gap-2'>
      <span className='text-[12px] text-muted-foreground'>{label}</span>
      <fieldset
        className='inline-flex overflow-hidden rounded-md border border-input'
        aria-label={label}
        disabled={disabled}
      >
        {choices.map((c) => (
          <button
            key={c.value}
            type='button'
            aria-pressed={value === c.value}
            onClick={() => onChange(c.value)}
            className={`${segment} inline-flex items-center gap-1.5 ${value === c.value ? on : off}`}
            data-hv-house={`${hook}:${c.value}`}
          >
            {c.swatch && (
              <span
                className='h-2.5 w-2.5 rounded-full ring-1 ring-black/10 dark:ring-white/25'
                style={{ background: c.swatch }}
                aria-hidden
              />
            )}
            {c.label}
          </button>
        ))}
      </fieldset>
    </div>
  )
}

/** The house style (#1551): defaults every new help video starts from.
 *  Administrators only. */
export function HouseStyleButton() {
  const { isAdmin } = useItemEditAuth()
  const client = useNivaroClient()
  const qc = useQueryClient()
  const ids = { intro: useId(), introMs: useId(), outro: useId(), outroMs: useId(), audio: useId() }
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState<HouseStyle | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const q = useQuery({
    queryKey: helpVideoSettingsKeys.houseStyle,
    enabled: isAdmin && open,
    queryFn: () => helpVideoSettingsApi(client).houseStyle()
  })
  const dto = q.data
  useEffect(() => {
    if (dto && open) setDraft(dto.house_style)
  }, [dto, open])
  if (!isAdmin) return null

  const migrated = dto?.migrated !== false
  const lock = !migrated || saving
  const d = draft
  const dirty = !!(d && dto && JSON.stringify(d) !== JSON.stringify(dto.house_style))
  const set = (patch: Partial<HouseStyle>) => {
    if (!d) return
    setSaved(false)
    setDraft({ ...d, ...patch })
  }
  const save = async (body: HouseStyle | null) => {
    setSaving(true)
    setError(null)
    setSaved(false)
    try {
      const next = await helpVideoSettingsApi(client).saveHouseStyle(body)
      qc.setQueryData(helpVideoSettingsKeys.houseStyle, next)
      setDraft(next.house_style)
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
  const msInput = (id: string, value: number, onValue: (ms: number) => void, hook: string) => (
    <input
      id={id}
      type='number'
      min={EDIT_LIMITS.cardMinMs / 1000}
      max={EDIT_LIMITS.cardMaxMs / 1000}
      step={0.5}
      value={value / 1000}
      disabled={lock}
      onChange={(e) => {
        // Only a length inside the card limits is taken; anything else waits
        // for the next keystroke.
        const n = Number(e.target.value)
        if (!Number.isFinite(n) || n * 1000 < EDIT_LIMITS.cardMinMs) return
        if (n * 1000 > EDIT_LIMITS.cardMaxMs) return
        onValue(Math.round(n * 10) * 100)
      }}
      className={inputClass}
      data-hv-house={hook}
    />
  )

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
        <Button size='sm' variant='outline' data-hv-house-style-button>
          <Palette className='mr-1 h-4 w-4' aria-hidden /> House style
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align='end'
        className='max-h-[min(640px,calc(100vh-6rem))] w-[min(400px,calc(100vw-2rem))] space-y-3 overflow-y-auto text-[13px]'
        data-hv-house-style-panel
      >
        <div>
          <p className='text-[13.5px] font-semibold text-foreground'>House style</p>
          <p className={noteClass}>
            New videos start from this. A video that already exists keeps its own choices until an
            author applies the house style in the editor.
          </p>
        </div>
        {q.isError ? (
          <p className={errorClass} role='alert'>
            The house style could not be loaded.{' '}
            <button type='button' className='underline' onClick={() => void q.refetch()}>
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
              <p className={warnClass} data-hv-house-migration>
                The house style needs a database update (migration 410) before it can be saved. New
                videos use the standard look shown here.
              </p>
            )}
            <div className='space-y-2'>
              <p className={labelClass}>Callouts</p>
              <Segmented<Tone>
                label='Colour'
                value={d.callout_tone}
                disabled={lock}
                hook='tone'
                onChange={(v) => set({ callout_tone: v })}
                choices={(['accent', 'warning', 'neutral'] as Tone[]).map((t) => ({
                  value: t,
                  label: TONE_NAMES[t],
                  swatch: ANNOTATION_PALETTE[t]
                }))}
              />
              <Segmented
                label='Text size'
                value={d.callout_text}
                disabled={lock}
                hook='text'
                onChange={(v) => set({ callout_text: v })}
                choices={(['small', 'medium', 'large'] as const).map((v) => ({
                  value: v,
                  label: CALLOUT_TEXT_NAMES[v]
                }))}
              />
            </div>
            <div className={groupClass}>
              <p className={labelClass}>Step badges</p>
              <Segmented
                label='Shape'
                value={d.step_style.shape}
                disabled={lock}
                hook='step-shape'
                onChange={(v) => set({ step_style: { ...d.step_style, shape: v } })}
                choices={[
                  { value: 'circle', label: 'Circle' },
                  { value: 'square', label: 'Square' }
                ]}
              />
              <Segmented
                label='Size'
                value={d.step_style.size}
                disabled={lock}
                hook='step-size'
                onChange={(v) => set({ step_style: { ...d.step_style, size: v } })}
                choices={[
                  { value: 'small', label: 'Small' },
                  { value: 'medium', label: 'Medium' },
                  { value: 'large', label: 'Large' }
                ]}
              />
            </div>
            <div className={groupClass}>
              <p className={labelClass}>Captions</p>
              <Segmented
                label='Size'
                value={d.caption_style.size}
                disabled={lock}
                hook='caption-size'
                onChange={(v) => set({ caption_style: { ...d.caption_style, size: v } })}
                choices={[
                  { value: 's', label: 'S' },
                  { value: 'm', label: 'M' },
                  { value: 'l', label: 'L' },
                  { value: 'xl', label: 'XL' }
                ]}
              />
              <Segmented
                label='Background'
                value={d.caption_style.background}
                disabled={lock}
                hook='caption-background'
                onChange={(v) => set({ caption_style: { ...d.caption_style, background: v } })}
                choices={[
                  { value: 'none', label: 'None' },
                  { value: 'shaded', label: 'Shaded' },
                  { value: 'solid', label: 'Solid' }
                ]}
              />
              <Segmented
                label='Position'
                value={d.caption_style.position}
                disabled={lock}
                hook='caption-position'
                onChange={(v) => set({ caption_style: { ...d.caption_style, position: v } })}
                choices={[
                  { value: 'bottom', label: 'Bottom' },
                  { value: 'top', label: 'Top' }
                ]}
              />
              <p className={noteClass}>Viewers who set their own caption look keep theirs.</p>
            </div>
            <div className={groupClass}>
              <div className='flex items-center justify-between gap-3'>
                <label htmlFor={ids.intro} className={labelClass}>
                  Intro card
                </label>
                <Switch
                  id={ids.intro}
                  checked={d.intro.enabled}
                  disabled={lock}
                  onCheckedChange={(v) => set({ intro: { ...d.intro, enabled: v } })}
                  data-hv-house='intro'
                />
              </div>
              {d.intro.enabled && (
                <div className='space-y-2' data-hv-house-intro>
                  <div className='flex items-center justify-between gap-2'>
                    <label htmlFor={ids.introMs} className='text-[12px] text-muted-foreground'>
                      Length (seconds)
                    </label>
                    {msInput(
                      ids.introMs,
                      d.intro.duration_ms,
                      (ms) => set({ intro: { ...d.intro, duration_ms: ms } }),
                      'intro-ms'
                    )}
                  </div>
                  <div className='flex items-center justify-between gap-2'>
                    <span className='text-[12px] text-muted-foreground'>List the chapters</span>
                    <Switch
                      checked={d.intro.show_chapters}
                      disabled={lock}
                      aria-label='List the chapters on the intro card'
                      onCheckedChange={(v) => set({ intro: { ...d.intro, show_chapters: v } })}
                    />
                  </div>
                  <div className='grid grid-cols-2 gap-2'>
                    <SimpleSelect
                      value={d.intro.animation}
                      onChange={(v) =>
                        set({
                          intro: { ...d.intro, animation: v as HouseStyle['intro']['animation'] }
                        })
                      }
                      options={ANIMATIONS}
                      ariaLabel='Intro card motion'
                      disabled={lock}
                      className='h-8 w-full text-[12.5px]'
                    />
                    <SimpleSelect
                      value={d.intro.transition}
                      onChange={(v) =>
                        set({
                          intro: { ...d.intro, transition: v as HouseStyle['intro']['transition'] }
                        })
                      }
                      options={TRANSITIONS}
                      ariaLabel='Intro card transition'
                      disabled={lock}
                      className='h-8 w-full text-[12.5px]'
                    />
                  </div>
                  <p className={noteClass}>Shows the video's own title and description.</p>
                </div>
              )}
            </div>
            <div className={groupClass}>
              <div className='flex items-center justify-between gap-3'>
                <label htmlFor={ids.outro} className={labelClass}>
                  End card
                </label>
                <Switch
                  id={ids.outro}
                  checked={d.outro.enabled}
                  disabled={lock}
                  onCheckedChange={(v) => set({ outro: { ...d.outro, enabled: v } })}
                  data-hv-house='outro'
                />
              </div>
              {d.outro.enabled && (
                <div className='space-y-2' data-hv-house-outro>
                  <div className='flex items-center justify-between gap-2'>
                    <label htmlFor={ids.outroMs} className='text-[12px] text-muted-foreground'>
                      Length (seconds)
                    </label>
                    {msInput(
                      ids.outroMs,
                      d.outro.duration_ms,
                      (ms) => set({ outro: { ...d.outro, duration_ms: ms } }),
                      'outro-ms'
                    )}
                  </div>
                  <input
                    type='text'
                    value={d.outro.text}
                    maxLength={EDIT_LIMITS.outroText}
                    placeholder={OUTRO_DEFAULT_TEXT}
                    aria-label='End card text'
                    disabled={lock}
                    onChange={(e) => set({ outro: { ...d.outro, text: e.target.value } })}
                    className='h-8 w-full rounded-md border border-border bg-background px-2 text-[12.5px] text-foreground placeholder:text-muted-foreground disabled:opacity-60'
                    data-hv-house='outro-text'
                  />
                  <div className='grid grid-cols-2 gap-2'>
                    <SimpleSelect
                      value={d.outro.animation}
                      onChange={(v) =>
                        set({
                          outro: { ...d.outro, animation: v as HouseStyle['outro']['animation'] }
                        })
                      }
                      options={ANIMATIONS}
                      ariaLabel='End card motion'
                      disabled={lock}
                      className='h-8 w-full text-[12.5px]'
                    />
                    <SimpleSelect
                      value={d.outro.transition}
                      onChange={(v) =>
                        set({
                          outro: { ...d.outro, transition: v as HouseStyle['outro']['transition'] }
                        })
                      }
                      options={TRANSITIONS}
                      ariaLabel='End card transition'
                      disabled={lock}
                      className='h-8 w-full text-[12.5px]'
                    />
                  </div>
                </div>
              )}
            </div>
            <div className={groupClass}>
              <div className='flex items-center justify-between gap-3'>
                <label htmlFor={ids.audio} className={labelClass}>
                  Improve audio
                </label>
                <Switch
                  id={ids.audio}
                  checked={d.improve_audio}
                  disabled={lock}
                  onCheckedChange={(v) => set({ improve_audio: v })}
                  data-hv-house='audio'
                />
              </div>
              <p className={noteClass}>
                Evens out the narration and lowers background noise when a video renders.
              </p>
            </div>
            {error && (
              <p className={errorClass} role='alert'>
                {error}
              </p>
            )}
            <div className='flex items-center justify-between gap-2 border-t border-border pt-3'>
              <Button
                size='sm'
                variant='ghost'
                disabled={lock || dto.is_default}
                onClick={() => void save(null)}
                data-hv-house-reset
              >
                Use the standard look
              </Button>
              <div className='flex items-center gap-2'>
                {saved && !dirty && (
                  <span
                    className='text-[12px] text-emerald-700 dark:text-emerald-300'
                    role='status'
                  >
                    Saved
                  </span>
                )}
                <Button
                  size='sm'
                  disabled={lock || !dirty}
                  onClick={() => void save(d)}
                  data-hv-house-save
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
