import { Eye } from 'lucide-react'
import { memo, useId } from 'react'
import { Button } from '../../ui/button'
import { Input } from '../../ui/input'
import { Switch } from '../../ui/switch'
import { useCardBrand } from '../api'
import { firstLine } from '../cards'
import {
  EDIT_LIMITS,
  OUTRO_DEFAULT_TEXT,
  setCardBrand,
  setChapterBanners,
  setIntro,
  setOutro
} from '../edits'
import type { VideoEdits } from '../types'

const SECONDS = [2, 3, 4, 5, 6]

/**
 * The intro card, the outro card and chapter banners. Each card adds its own
 * time before or after the recording (it never covers any of it) and is drawn
 * in the instance's brand; the switches store nothing while they are off.
 */
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
  // The instance name: what a blank "Name on the cards" shows.
  const instance = useCardBrand(!!(intro || outro), '')
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
      <Eye className='!size-3.5' aria-hidden /> Show it
    </Button>
  )
}
