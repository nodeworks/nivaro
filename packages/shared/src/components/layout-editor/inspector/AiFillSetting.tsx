import { useMemo } from 'react'
import { AI_FILL_KEY, PROMPT_MAX, promptTokens, readAiFill } from '../../../lib/ai-fill'
import { SimpleSelect } from '../../ui/SimpleSelect'
import { useFieldCtx } from './field-context'
import { Setting, TextArea, Toggle } from './kit'

/**
 * AI fill per field (#2692): an AI button on this field of this form, and the
 * prompt it runs. `{{field}}` in the prompt stands for another field's value
 * at the moment the button is pressed (only fields the person may read). The
 * form-wide "AI generate buttons" switch still covers fields without their
 * own setting.
 */
export function AiFillSetting() {
  const ctx = useFieldCtx()
  const { ov, info, globals } = ctx
  const cfg = readAiFill(ov)
  const on = !!cfg?.enabled
  const prompt = cfg?.prompt ?? ''
  const name = info.label

  const known = useMemo(() => new Set(globals.map((g) => g.field)), [globals])
  const unknown = promptTokens(prompt).filter((t) => !known.has(t))
  const options = useMemo(
    () => [
      { value: '', label: 'Insert a field…' },
      ...globals
        .filter((g) => g.field !== info.field && !g.field.startsWith('__'))
        .map((g) => ({ value: g.field, label: g.label?.trim() || g.field }))
    ],
    [globals, info.field]
  )

  const write = (next: { enabled: boolean; prompt: string }, label: string, text?: boolean) =>
    ctx.setOverride(
      AI_FILL_KEY,
      { enabled: next.enabled, prompt: next.prompt.slice(0, PROMPT_MAX) },
      label,
      text
    )

  return (
    <div className='space-y-3' data-ai-fill-setting=''>
      <Toggle
        k='field.ai_generate'
        label='AI fill button'
        effect={`Shows an AI button on ${name} that writes a value from your prompt. Overrides the form-wide AI switch for this field.`}
        checked={on}
        onChange={(v) =>
          write(
            {
              enabled: v,
              prompt: prompt || `Write the ${name.toLowerCase()} for this record.`
            },
            v ? `Turn on AI fill for ${name}` : `Turn off AI fill for ${name}`
          )
        }
      />
      {on && (
        <Setting
          k='field.ai_generate_prompt'
          label='AI prompt'
          effect='What the AI is asked. {{field_name}} is replaced by that field’s current value; nothing else from the record is sent.'
        >
          <TextArea
            ariaLabel='AI prompt'
            rows={4}
            value={prompt}
            onChange={(v) =>
              write({ enabled: true, prompt: v }, `Edit the AI prompt of ${name}`, true)
            }
          />
          <div className='flex items-center gap-2'>
            <SimpleSelect
              value=''
              ariaLabel='Insert a field into the prompt'
              className='h-7 flex-1 text-[12px]'
              options={options}
              onChange={(f) => {
                if (!f) return
                const sep = prompt && !/\s$/.test(prompt) ? ' ' : ''
                write(
                  { enabled: true, prompt: `${prompt}${sep}{{${f}}}` },
                  `Edit the AI prompt of ${name}`
                )
              }}
            />
          </div>
          {unknown.length > 0 && (
            <p className='text-[12px] text-amber-700 dark:text-amber-300' data-ai-fill-unknown=''>
              Not fields of this collection: {unknown.map((t) => `{{${t}}}`).join(', ')} — they stay
              empty.
            </p>
          )}
        </Setting>
      )}
    </div>
  )
}
