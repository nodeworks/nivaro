import { SlidersHorizontal } from 'lucide-react'
import { useMemo } from 'react'
import { useMyPreferences, useSetMyPreferences } from '../../chat/chat-core'
import { Popover, PopoverContent, PopoverTrigger } from '../../ui/popover'
import type { CaptionStyle } from '../types'
import { captionStyleFrom, captionStylePatch } from './moments'

// Caption size, background and position (#1529), remembered per person in
// preferences.help_video_captions (only what differs from the default).

/** The signed-in person's caption settings and a setter that saves them. */
export function useCaptionStyle(): [CaptionStyle, (next: CaptionStyle) => void] {
  const prefs = useMyPreferences()
  const save = useSetMyPreferences()
  const style = useMemo(() => captionStyleFrom(prefs), [prefs])
  return [style, (next) => save.mutate({ help_video_captions: captionStylePatch(next) })]
}

const OPTIONS: {
  key: keyof CaptionStyle
  label: string
  choices: Array<{ value: string; label: string }>
}[] = [
  {
    key: 'size',
    label: 'Size',
    choices: [
      { value: 's', label: 'Small' },
      { value: 'm', label: 'Medium' },
      { value: 'l', label: 'Large' },
      { value: 'xl', label: 'Largest' }
    ]
  },
  {
    key: 'background',
    label: 'Background',
    choices: [
      { value: 'none', label: 'None' },
      { value: 'shaded', label: 'Shaded' },
      { value: 'solid', label: 'Solid' }
    ]
  },
  {
    key: 'position',
    label: 'Position',
    choices: [
      { value: 'bottom', label: 'Bottom' },
      { value: 'top', label: 'Top' }
    ]
  }
]

export function CaptionSettingsButton({
  style,
  onChange,
  className
}: {
  style: CaptionStyle
  onChange: (next: CaptionStyle) => void
  className: string
}) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type='button'
          aria-label='Caption settings'
          data-tip='Caption settings'
          className={className}
          data-hv-caption-settings
        >
          <SlidersHorizontal className='h-4 w-4' aria-hidden />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align='end'
        side='top'
        className='w-64 space-y-3 p-3 text-[12.5px]'
        data-hv-caption-settings-panel
      >
        <p className='text-[12px] font-semibold text-foreground'>Captions</p>
        {OPTIONS.map((o) => (
          <fieldset key={o.key} className='space-y-1'>
            <legend className='mb-1 text-[11.5px] text-muted-foreground'>{o.label}</legend>
            <div className='flex rounded-md border border-border p-0.5'>
              {o.choices.map((c) => {
                const on = style[o.key] === c.value
                return (
                  <button
                    key={c.value}
                    type='button'
                    aria-pressed={on}
                    onClick={() => onChange({ ...style, [o.key]: c.value } as CaptionStyle)}
                    className={`h-7 flex-1 rounded-[5px] px-1.5 text-[12px] transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan motion-reduce:transition-none ${
                      on
                        ? 'bg-[#0f172a] font-medium text-white dark:bg-[#334155]'
                        : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                    }`}
                    data-hv-caption-choice={`${o.key}:${c.value}`}
                  >
                    {c.label}
                  </button>
                )
              })}
            </div>
          </fieldset>
        ))}
        <p className='text-[11.5px] leading-snug text-muted-foreground'>
          Saved for you on every video.
        </p>
      </PopoverContent>
    </Popover>
  )
}
