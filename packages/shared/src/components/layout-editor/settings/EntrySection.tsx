import { useEffect, useRef, useState } from 'react'
import { badgeClasses } from '../../../lib/entry-badge-style'
import {
  BADGE_COLORS,
  type BadgeColor,
  ENTRY_BADGE_TAG_MAX,
  ENTRY_THRESHOLD_DEFAULT,
  ENTRY_THRESHOLD_MAX,
  type EntryConfig,
  entryConfigOf,
  sanitizeEntryConfig
} from '../../../lib/entry-config'
import { cn } from '../../../lib/utils'
import { useEntryEditor } from '../entry/entry-editor-context'
import { presetSummary, withPresets } from '../entry/presets'
import { inputCls, quietText, Setting, smallBtn, Toggle } from './controls'
import type { SectionProps } from './section-props'

/** Entering data: keyboard, tab order, guided steps, the form badge, glossary, presets. */
export function EntrySection(props: SectionProps) {
  const config = entryConfigOf(props.layout)
  const editor = useEntryEditor()
  const save = (patch: Partial<EntryConfig>, label: string, text = false) => {
    const next = sanitizeEntryConfig({ ...config, ...patch })
    ;(text ? props.setText : props.set)({ entry_config: next }, label)
  }
  const tabCount = config.tab_order?.length ?? 0
  const presets = config.presets ?? []
  return (
    <>
      <Setting
        k='layout.focus_first'
        control={
          <Toggle
            label='Start on the first empty required field'
            checked={config.focus_first === true}
            onChange={(on) =>
              save(
                { focus_first: on || undefined },
                on ? 'Start on the first empty required field' : 'Stop starting on a required field'
              )
            }
          />
        }
      />
      <Setting
        k='layout.enter_next'
        control={
          <Toggle
            label='Enter moves to the next field'
            checked={config.enter_next === true}
            onChange={(on) =>
              save(
                { enter_next: on || undefined },
                on ? 'Make Enter move to the next field' : 'Make Enter save again'
              )
            }
          />
        }
      />
      <Setting
        k='layout.tab_order'
        control={
          <div className='flex flex-wrap items-center gap-2'>
            <button
              type='button'
              data-tab-order-start=''
              className={smallBtn}
              disabled={editor.tabOrderActive}
              onClick={editor.startTabOrder}
            >
              {tabCount ? 'Change order on the canvas' : 'Set order on the canvas'}
            </button>
            {tabCount > 0 && (
              <button
                type='button'
                className={smallBtn}
                onClick={() => save({ tab_order: undefined }, 'Clear the tab order')}
              >
                Clear
              </button>
            )}
          </div>
        }
        note={
          <span className={quietText}>
            {tabCount
              ? `${tabCount} ${tabCount === 1 ? 'field' : 'fields'} in order; the rest follow in page order.`
              : 'Not set: Tab follows the page order.'}
          </span>
        }
      />
      <Setting
        k='layout.adaptive_mode'
        control={
          <Toggle
            label='Guided steps for new people'
            checked={config.adaptive === true}
            onChange={(on) =>
              save(
                { adaptive: on || undefined },
                on ? 'Show steps to new people' : 'Stop switching between steps and tabs'
              )
            }
          />
        }
      />
      <Setting
        k='layout.adaptive_threshold'
        control={
          <NumberInput
            value={config.adaptive_threshold ?? ENTRY_THRESHOLD_DEFAULT}
            label='Records before tabs'
            disabled={config.adaptive !== true}
            onChange={(n) => save({ adaptive_threshold: n }, 'Change records before tabs', true)}
            onBlur={props.flush}
          />
        }
      />
      <Setting k='layout.badge'>
        <BadgeEditor
          config={config}
          onChange={(badge, text) => save({ badge }, 'Change the form badge', text)}
          onBlur={props.flush}
        />
      </Setting>
      <Setting
        k='layout.glossary'
        control={
          <Toggle
            label='Glossary tooltips in help text'
            checked={config.glossary !== false}
            onChange={(on) =>
              save(
                { glossary: on ? undefined : false },
                on ? 'Turn on glossary tooltips' : 'Turn off glossary tooltips'
              )
            }
          />
        }
      />
      <Setting
        k='layout.presets'
        control={
          <button
            type='button'
            className={smallBtn}
            disabled={presets.length === 0}
            onClick={() => save({ presets: undefined }, 'Delete all presets')}
          >
            Delete all
          </button>
        }
      >
        {presets.length === 0 ? (
          <p className={quietText}>None yet. Select a field and use Presets in its inspector.</p>
        ) : (
          <ul className='m-0 list-none space-y-1 p-0' data-preset-list=''>
            {presets.map((p) => (
              <li
                key={p.id}
                className='flex items-center justify-between gap-2 rounded-md border border-slate-200 px-2 py-1 dark:border-border'
              >
                <span className='min-w-0'>
                  <span className='block truncate text-[12.5px] font-medium text-slate-800 dark:text-foreground'>
                    {p.name}
                  </span>
                  <span className={cn(quietText, 'block truncate')}>{presetSummary(p)}</span>
                </span>
                <button
                  type='button'
                  className={smallBtn}
                  aria-label={`Delete preset ${p.name}`}
                  onClick={() =>
                    save(
                      {
                        presets: withPresets(
                          config,
                          presets.filter((x) => x.id !== p.id)
                        )?.presets
                      },
                      `Delete preset ${p.name}`
                    )
                  }
                >
                  Delete
                </button>
              </li>
            ))}
          </ul>
        )}
      </Setting>
    </>
  )
}

function NumberInput({
  value,
  onChange,
  onBlur,
  label,
  disabled
}: {
  value: number
  onChange: (n: number) => void
  onBlur: () => void
  label: string
  disabled?: boolean
}) {
  const [text, setText] = useState(String(value))
  const typing = useRef(false)
  useEffect(() => {
    if (!typing.current) setText(String(value))
  }, [value])
  return (
    <input
      type='number'
      min={1}
      max={ENTRY_THRESHOLD_MAX}
      aria-label={label}
      disabled={disabled}
      value={text}
      className={cn(inputCls, 'w-20')}
      onFocus={() => {
        typing.current = true
      }}
      onChange={(e) => {
        setText(e.target.value)
        const n = Number(e.target.value)
        if (Number.isFinite(n) && n >= 1) onChange(n)
      }}
      onBlur={() => {
        typing.current = false
        setText(String(value))
        onBlur()
      }}
    />
  )
}

function BadgeEditor({
  config,
  onChange,
  onBlur
}: {
  config: EntryConfig
  onChange: (badge: EntryConfig['badge'] | undefined, text: boolean) => void
  onBlur: () => void
}) {
  const badge = config.badge
  const [tag, setTag] = useState(badge?.tag ?? '')
  const typing = useRef(false)
  useEffect(() => {
    if (!typing.current) setTag(badge?.tag ?? '')
  }, [badge?.tag])
  const color: BadgeColor = badge?.color ?? 'orange'
  return (
    <div className='space-y-2' data-badge-editor=''>
      <div className='flex items-center gap-2'>
        <input
          type='text'
          aria-label='Badge text'
          placeholder='Short tag, e.g. Sparing'
          maxLength={ENTRY_BADGE_TAG_MAX}
          value={tag}
          className={cn(inputCls, 'min-w-0 flex-1')}
          onFocus={() => {
            typing.current = true
          }}
          onChange={(e) => {
            setTag(e.target.value)
            onChange(e.target.value.trim() ? { tag: e.target.value, color } : undefined, true)
          }}
          onBlur={() => {
            typing.current = false
            onBlur()
          }}
        />
        {badge && (
          <span
            data-badge-preview=''
            className={cn(
              'inline-flex h-5 shrink-0 items-center rounded-full px-2 text-[11px] font-medium',
              badgeClasses(badge.color)
            )}
          >
            {badge.tag}
          </span>
        )}
      </div>
      <fieldset
        aria-label='Badge colour'
        className='m-0 flex min-w-0 flex-wrap gap-1.5 border-0 p-0'
      >
        {BADGE_COLORS.map((c) => (
          <button
            key={c}
            type='button'
            aria-pressed={color === c && !!badge}
            aria-label={c}
            data-tip={c}
            disabled={!tag.trim()}
            onClick={() => onChange({ tag, color: c }, false)}
            className={cn(
              'h-5 w-5 rounded-full border transition-shadow disabled:opacity-40',
              badgeClasses(c),
              color === c &&
                !!badge &&
                'ring-2 ring-nvr-cyan/60 ring-offset-1 ring-offset-white dark:ring-offset-card'
            )}
          />
        ))}
      </fieldset>
    </div>
  )
}
