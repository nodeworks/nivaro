import { useQueryClient } from '@tanstack/react-query'
import { Eye } from 'lucide-react'
import { memo, useId, useRef, useState } from 'react'
import { toast } from 'sonner'
import { useItemEditAuth, useNivaroClient } from '../../../context'
import { patch } from '../../../lib/commands'
import { Button } from '../../ui/button'
import { Input } from '../../ui/input'
import { Switch } from '../../ui/switch'
import { useCardBrand } from '../api'
import type { CardAnimation, CardTransition } from '../cardDesign'
import { firstLine } from '../cards'
import {
  EDIT_LIMITS,
  OUTRO_DEFAULT_TEXT,
  setBannerAnimation,
  setCardBrand,
  setChapterBanners,
  setIntro,
  setOutro
} from '../edits'
import type { VideoEdits } from '../types'

const SECONDS = [2, 3, 4, 5, 6]
const ANIMATIONS: Array<{ value: CardAnimation; label: string }> = [
  { value: 'none', label: 'None' },
  { value: 'subtle', label: 'Subtle' },
  { value: 'lively', label: 'Lively' }
]
const TRANSITIONS: Array<{ value: CardTransition; label: string }> = [
  { value: 'cut', label: 'Cut' },
  { value: 'fade', label: 'Fade' },
  { value: 'fade_black', label: 'Through black' },
  { value: 'slide', label: 'Slide' },
  { value: 'zoom', label: 'Zoom' },
  { value: 'wipe', label: 'Wipe' }
]

/**
 * The intro card, the outro card and chapter banners. Each card adds its own
 * time before or after the recording (it never covers any of it) and is drawn
 * in the instance's brand; the switches store nothing while they are off.
 */
/** The picked file as a data URI (the stored form of the card logo). */
function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result))
    r.onerror = () => reject(r.error)
    r.readAsDataURL(file)
  })
}

/** What the render can draw as a logo (help-video-cards.ts). */
const MAX_LOGO_BYTES = 2 * 1024 * 1024
const LOGO_TYPES = /^image\/(png|jpe?g|gif|webp|svg\+xml)$/i

export const CardsPanel = memo(function CardsPanel({
  headless,
  edits,
  videoTitle,
  videoDescription,
  onChange,
  onShow
}: {
  /** The side panel shows the title itself (the heading stays for screen readers). */
  headless?: boolean
  edits: VideoEdits
  videoTitle: string
  videoDescription: string | null
  onChange: (e: VideoEdits, key?: string) => void
  /** Moves the preview to the start of a card. */
  onShow: (card: 'intro' | 'outro') => void
}) {
  const headingId = useId()
  const ids = {
    intro: useId(),
    introTitle: useId(),
    introSub: useId(),
    introCh: useId(),
    outro: useId(),
    outroText: useId(),
    banners: useId(),
    brand: useId()
  }
  const intro = edits.intro
  const outro = edits.outro
  const descLine = firstLine(videoDescription)
  // The instance name: what a blank "Name on the cards" shows, and whether
  // the instance has a logo at all.
  const instance = useCardBrand(!!(intro || outro || edits.chapter_banners), '')
  const { isAdmin } = useItemEditAuth()
  const client = useNivaroClient()
  const qc = useQueryClient()
  const fileRef = useRef<HTMLInputElement>(null)
  const [uploading, setUploading] = useState(false)
  // A logo for the help-video cards only, stored as the image itself
  // (help_video_card_logo_image) so it travels with the settings to every
  // environment. The instance logo (sign-in page, admin sidebar) is never
  // changed from here.
  const uploadLogo = async (file: File | null) => {
    if (!file) return
    // The render draws only these (help-video-cards.ts): anything else would
    // show in the preview here and be left off the published video.
    const refusal = !LOGO_TYPES.test(file.type)
      ? 'Use a PNG, JPEG, GIF, WebP or SVG image for the logo.'
      : file.size > MAX_LOGO_BYTES
        ? 'That logo is over 2 MB. Use a smaller image.'
        : null
    if (refusal) {
      toast.error(refusal)
      if (fileRef.current) fileRef.current.value = ''
      return
    }
    setUploading(true)
    try {
      const image = await readAsDataUrl(file)
      await client.request(patch('/settings', { help_video_card_logo_image: image }))
      await qc.invalidateQueries({ queryKey: ['help-video-card-brand'] })
      toast.success('Logo set for the help-video cards.')
    } catch (err) {
      const msg = (err as { response?: { error?: string } })?.response?.error
      toast.error(
        msg ? `Could not set the card logo: ${msg}` : 'Could not set the card logo. Try again.'
      )
    } finally {
      setUploading(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }
  return (
    <section className='space-y-3' aria-labelledby={headingId} data-hv-cards>
      <div>
        <h3
          id={headingId}
          className={headless ? 'sr-only' : 'text-[13px] font-semibold text-foreground'}
        >
          Intro, outro and banners
        </h3>
        <p className='mt-1 text-[12px] leading-snug text-muted-foreground'>
          Cards add their own seconds before and after the recording, in your brand colours. They
          never cover any of it.
        </p>
      </div>

      <div className='space-y-2'>
        <ToggleRow
          id={ids.intro}
          label='Title card at the start'
          checked={!!intro}
          onChange={(on) => onChange(setIntro(edits, on ? {} : null))}
          data='data-hv-intro-toggle'
        />
        {intro && (
          <div className='space-y-2 border-l border-border pl-3' data-hv-intro-settings>
            <Seconds
              label='Intro length'
              value={intro.duration_ms}
              onPick={(ms) => onChange(setIntro(edits, { duration_ms: ms }))}
              data='intro'
            />
            <Choice
              label='Animation'
              value={intro.animation ?? 'none'}
              options={ANIMATIONS}
              onPick={(v) => onChange(setIntro(edits, { animation: v }))}
              data={(v) => ({ 'data-hv-card-animation': `intro:${v}` })}
            />
            <Choice
              label='Transition into the recording'
              value={intro.transition ?? 'cut'}
              options={TRANSITIONS}
              onPick={(v) => onChange(setIntro(edits, { transition: v }))}
              data={(v) => ({ 'data-hv-card-transition': `intro:${v}` })}
            />
            <div className='space-y-1'>
              <label htmlFor={ids.introTitle} className='text-[12px] font-medium text-foreground'>
                Title
              </label>
              <Input
                id={ids.introTitle}
                value={intro.title}
                maxLength={EDIT_LIMITS.introTitle}
                placeholder={videoTitle.trim() || 'The video’s title'}
                onChange={(e) =>
                  onChange(setIntro(edits, { title: e.target.value }), 'intro:title')
                }
                className='h-8 text-[13px]'
                data-hv-intro-title
              />
            </div>
            <div className='space-y-1'>
              <label htmlFor={ids.introSub} className='text-[12px] font-medium text-foreground'>
                Subtitle
              </label>
              <Input
                id={ids.introSub}
                value={intro.subtitle}
                maxLength={EDIT_LIMITS.introSubtitle}
                placeholder={descLine || 'None'}
                onChange={(e) =>
                  onChange(setIntro(edits, { subtitle: e.target.value }), 'intro:subtitle')
                }
                className='h-8 text-[13px]'
                data-hv-intro-subtitle
              />
              <p className='text-[11.5px] leading-snug text-muted-foreground'>
                Left blank, the card shows the video’s title and the first line of its description.
              </p>
            </div>
            <ToggleRow
              id={ids.introCh}
              label='List the chapters'
              hint={edits.chapters.length ? undefined : 'Add chapters to list them here.'}
              checked={intro.show_chapters}
              onChange={(on) => onChange(setIntro(edits, { show_chapters: on }))}
              data='data-hv-intro-chapters'
            />
            <ShowButton onClick={() => onShow('intro')} data='intro' />
          </div>
        )}
      </div>

      <div className='space-y-2'>
        <ToggleRow
          id={ids.outro}
          label='End card'
          checked={!!outro}
          onChange={(on) => onChange(setOutro(edits, on ? {} : null))}
          data='data-hv-outro-toggle'
        />
        {outro && (
          <div className='space-y-2 border-l border-border pl-3' data-hv-outro-settings>
            <Seconds
              label='End card length'
              value={outro.duration_ms}
              onPick={(ms) => onChange(setOutro(edits, { duration_ms: ms }))}
              data='outro'
            />
            <Choice
              label='Animation'
              value={outro.animation ?? 'none'}
              options={ANIMATIONS}
              onPick={(v) => onChange(setOutro(edits, { animation: v }))}
              data={(v) => ({ 'data-hv-card-animation': `outro:${v}` })}
            />
            <Choice
              label='Transition from the recording'
              value={outro.transition ?? 'cut'}
              options={TRANSITIONS}
              onPick={(v) => onChange(setOutro(edits, { transition: v }))}
              data={(v) => ({ 'data-hv-card-transition': `outro:${v}` })}
            />
            <div className='space-y-1'>
              <label htmlFor={ids.outroText} className='text-[12px] font-medium text-foreground'>
                Closing line
              </label>
              <Input
                id={ids.outroText}
                value={outro.text}
                maxLength={EDIT_LIMITS.outroText}
                placeholder={OUTRO_DEFAULT_TEXT}
                onChange={(e) => onChange(setOutro(edits, { text: e.target.value }), 'outro:text')}
                className='h-8 text-[13px]'
                data-hv-outro-text
              />
            </div>
            <ShowButton onClick={() => onShow('outro')} data='outro' />
          </div>
        )}
      </div>

      {(intro || outro) && (
        <div className='space-y-1' data-hv-card-brand>
          <label htmlFor={ids.brand} className='text-[12px] font-medium text-foreground'>
            Name on the cards
          </label>
          <Input
            id={ids.brand}
            value={edits.card_brand ?? ''}
            maxLength={EDIT_LIMITS.cardBrand}
            placeholder={instance.name || 'None'}
            onChange={(e) => onChange(setCardBrand(edits, e.target.value), 'card:brand')}
            className='h-8 text-[13px]'
            aria-describedby={`${ids.brand}-hint`}
            data-hv-card-brand-input
          />
          <p id={`${ids.brand}-hint`} className='text-[11.5px] leading-snug text-muted-foreground'>
            {instance.name
              ? `Left blank, the cards show ${instance.name}. Your logo and colour stay either way.`
              : 'Shown beside your logo on the title and end cards.'}
          </p>
        </div>
      )}

      {(intro || outro) && !instance.logo && (
        <div
          className='rounded-md border border-dashed border-border p-2.5 text-[11.5px] leading-snug text-muted-foreground'
          data-hv-logo-missing
        >
          The cards have no logo, so they show the name instead.
          {isAdmin ? (
            <>
              {' '}
              <button
                type='button'
                className='font-medium text-foreground underline underline-offset-2 hover:no-underline disabled:opacity-60'
                onClick={() => fileRef.current?.click()}
                disabled={uploading}
                data-hv-logo-upload
              >
                {uploading ? 'Uploading…' : 'Upload a logo'}
              </button>
              <input
                ref={fileRef}
                type='file'
                accept='image/png,image/jpeg,image/webp,image/svg+xml,image/gif'
                className='sr-only'
                tabIndex={-1}
                aria-hidden
                onChange={(ev) => void uploadLogo(ev.target.files?.[0] ?? null)}
              />
            </>
          ) : (
            ' An administrator can add one here.'
          )}
        </div>
      )}

      <ToggleRow
        id={ids.banners}
        label='Chapter banners'
        hint={
          edits.chapters.length
            ? 'Each chapter’s title shows for a few seconds as it starts.'
            : 'Each chapter’s title shows for a few seconds as it starts. Add chapters first.'
        }
        checked={edits.chapter_banners === true}
        onChange={(on) => onChange(setChapterBanners(edits, on))}
        data='data-hv-banners-toggle'
      />
      {edits.chapter_banners && (
        <div className='border-l border-border pl-3'>
          <Choice
            label='Banner animation'
            value={edits.banner_animation ?? 'none'}
            options={ANIMATIONS}
            onPick={(v) => onChange(setBannerAnimation(edits, v))}
            data={(v) => ({ 'data-hv-banner-animation': v })}
          />
        </div>
      )}
    </section>
  )
})

function ToggleRow({
  id,
  label,
  hint,
  checked,
  onChange,
  data
}: {
  id: string
  label: string
  hint?: string
  checked: boolean
  onChange: (on: boolean) => void
  data: string
}) {
  const hintId = `${id}-hint`
  return (
    <div className='flex items-start justify-between gap-3'>
      <div className='min-w-0'>
        <label htmlFor={id} className='text-[12.5px] font-medium text-foreground'>
          {label}
        </label>
        {hint && (
          <p id={hintId} className='text-[11.5px] leading-snug text-muted-foreground'>
            {hint}
          </p>
        )}
      </div>
      <Switch
        id={id}
        checked={checked}
        onCheckedChange={onChange}
        aria-describedby={hint ? hintId : undefined}
        className='mt-0.5 h-5 w-9 shrink-0 [&>span]:h-4 [&>span]:w-4 [&>span]:data-[state=checked]:translate-x-4'
        {...{ [data]: '' }}
      />
    </div>
  )
}

function Seconds({
  label,
  value,
  onPick,
  data
}: {
  label: string
  value: number
  onPick: (ms: number) => void
  data: 'intro' | 'outro'
}) {
  return (
    <fieldset className='space-y-1'>
      <legend className='text-[12px] font-medium text-foreground'>{label}</legend>
      <div className='flex w-fit overflow-hidden rounded-md border border-input'>
        {SECONDS.map((s) => {
          const active = Math.round(value / 1000) === s
          return (
            <button
              key={s}
              type='button'
              aria-pressed={active}
              aria-label={`${s} seconds`}
              onClick={() => onPick(s * 1000)}
              className={`h-7 min-w-[34px] border-l border-input px-1.5 text-[12px] tabular-nums transition-colors duration-150 first:border-l-0 focus-visible:relative focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-nvr-cyan motion-reduce:transition-none ${active ? 'bg-nvr-cyan/15 font-semibold text-foreground' : 'bg-background text-foreground hover:bg-muted'}`}
              data-hv-card-seconds={`${data}:${s}`}
            >
              {s}s
            </button>
          )
        })}
      </div>
    </fieldset>
  )
}

function ShowButton({ onClick, data }: { onClick: () => void; data: 'intro' | 'outro' }) {
  return (
    <Button
      size='sm'
      variant='ghost'
      className='h-7 px-2 text-[12px]'
      onClick={onClick}
      data-hv-card-show={data}
    >
      <Eye className='!size-3.5' aria-hidden /> Play it
    </Button>
  )
}

/** A row of choices for one setting (wraps when there are many). */
function Choice<T extends string>({
  label,
  value,
  options,
  onPick,
  data
}: {
  label: string
  value: T
  options: Array<{ value: T; label: string }>
  onPick: (v: T) => void
  data: (v: T) => Record<string, string>
}) {
  return (
    <fieldset className='space-y-1'>
      <legend className='text-[12px] font-medium text-foreground'>{label}</legend>
      <div className='flex flex-wrap gap-1'>
        {options.map((o) => {
          const active = o.value === value
          return (
            <button
              key={o.value}
              type='button'
              aria-pressed={active}
              onClick={() => onPick(o.value)}
              className={`h-7 rounded-md border border-input px-2 text-[12px] transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan motion-reduce:transition-none ${active ? 'bg-nvr-cyan/15 font-semibold text-foreground' : 'bg-background text-foreground hover:bg-muted'}`}
              {...data(o.value)}
            >
              {o.label}
            </button>
          )
        })}
      </div>
    </fieldset>
  )
}
