import { InlineDisplaySection } from '../editors/inline-display'
import { useFieldCtx } from './field-context'
import { interfaceLabel, interfaceOptions } from './interfaces'
import {
  Choice,
  DraftInput,
  Section,
  Segmented,
  Setting,
  TextInput,
  Toggle,
  useGlobalValue
} from './kit'
import { inlineDisplayOf, NUMERIC_TYPES, withInlineDisplay } from './model'

const WIDTHS = [
  { value: '12', label: 'Full' },
  { value: '6', label: '½' },
  { value: '4', label: '⅓' },
  { value: '3', label: '¼' }
]

const FORMATS = [
  { value: '', label: 'Default' },
  { value: 'int', label: 'Integer' },
  { value: 'decimal', label: 'Decimal' },
  { value: 'currency', label: 'Currency' }
]

const AGGREGATES = [
  { value: '', label: 'None' },
  { value: 'SUM', label: 'Sum' },
  { value: 'COUNT', label: 'Count' },
  { value: 'AVG', label: 'Average' },
  { value: 'MIN', label: 'Smallest' },
  { value: 'MAX', label: 'Largest' }
]

const str = (v: unknown) => (typeof v === 'string' ? v : '')

export function LookTab() {
  const ctx = useFieldCtx()
  const { info, ov, opts, env, row, globalOptions } = ctx
  const name = info.label
  const globalLabel = info.global?.label || name
  const labelHidden = ov.label === ''
  const isNumeric = NUMERIC_TYPES.has(info.type)
  const isDate = ['date', 'datetime', 'timestamp'].includes(info.type) || info.iface === 'datetime'
  const isText = info.type === 'string' || info.type === 'text'
  const ifaceOpts = interfaceOptions(info.abstractType)
  const fieldIface = interfaceLabel(info.abstractType, info.global?.interface ?? null)

  const format = useGlobalValue('field.format', str(globalOptions.format))
  const currency = useGlobalValue('field.currency', str(globalOptions.currency))
  const aggregate = useGlobalValue('field.aggregate', str(globalOptions.aggregate))
  const unit = useGlobalValue('field.unit', str(globalOptions.unit))
  const mask = useGlobalValue('field.input_mask', str(globalOptions.input_mask))

  const inline = inlineDisplayOf(row)
  const setInline = (next: typeof inline) =>
    ctx.setPlacement(
      { input_bindings: withInlineDisplay(row, next) },
      `Change what shows under ${name}`,
      true
    )

  return (
    <div className='space-y-4'>
      <Setting
        k='field.label'
        label='Label'
        effect={`What this form calls the field. Empty uses the field's own label (${globalLabel}).`}
      >
        <TextInput
          ariaLabel='Label'
          value={labelHidden ? '' : str(ov.label)}
          placeholder={globalLabel}
          onChange={(v) =>
            ctx.setOverride('label', v === '' ? undefined : v, `Rename ${name}`, true)
          }
        />
      </Setting>
      <Toggle
        k='field.label_hidden'
        label='Hide the label'
        effect='Shows the value without its label on this form.'
        checked={labelHidden}
        onChange={(v) =>
          ctx.setOverride(
            'label',
            v ? '' : undefined,
            v ? `Hide the label of ${name}` : `Show the label of ${name}`
          )
        }
      />
      <Setting k='field.interface' label='Input' effect='How the field is edited on this form.'>
        <Choice
          ariaLabel='Input'
          value={str(ov.interface)}
          options={[
            { value: '', label: fieldIface ? `Field's own (${fieldIface})` : "Field's own" },
            ...ifaceOpts
          ]}
          onChange={(v) =>
            ctx.setOverride('interface', v || undefined, `Change how ${name} is edited`)
          }
        />
      </Setting>
      <Setting k='field.placeholder' label='Placeholder' effect='Grey hint inside the empty input.'>
        <TextInput
          ariaLabel='Placeholder'
          value={str(ov.placeholder)}
          onChange={(v) =>
            ctx.setOverride(
              'placeholder',
              v || undefined,
              `Change the placeholder of ${name}`,
              true
            )
          }
        />
      </Setting>
      <Setting k='field.note' label='Help text' effect='A line of help under the field.'>
        <TextInput
          ariaLabel='Help text'
          value={str(ov.note)}
          placeholder={info.global?.note ?? ''}
          onChange={(v) =>
            ctx.setOverride('note', v || undefined, `Change the help text of ${name}`, true)
          }
        />
      </Setting>
      <Toggle
        k='field.hidden'
        label='Hidden'
        effect='Leaves the field off this form; its value is kept.'
        checked={ov.hidden === true}
        onChange={(v) =>
          ctx.setOverride('hidden', v ? true : undefined, v ? `Hide ${name}` : `Show ${name}`)
        }
      />
      {env.layoutType !== 'table' && (
        <Setting k='field.col_span' label='Width' effect='Share of the row the field takes.'>
          <Segmented
            value={String(row.col_span ?? 12)}
            options={WIDTHS}
            onChange={(v) =>
              ctx.setPlacement(
                { col_span: v === '12' ? null : Number(v) },
                `Set the width of ${name} to ${WIDTHS.find((w) => w.value === v)?.label}`
              )
            }
          />
        </Setting>
      )}

      {info.relKind === 'M2O' && info.relatedCollection && (
        <Section title='Show under the value'>
          <p className='text-[11px] text-muted-foreground'>
            Fields of the picked record shown with it on this form.
          </p>
          <div onBlurCapture={() => env.flush()}>
            <InlineDisplaySection
              relatedCollection={info.relatedCollection}
              entries={inline.entries}
              separator={inline.separator}
              onChange={(entries) => setInline({ ...inline, entries })}
              onSeparatorChange={(separator) => setInline({ ...inline, separator })}
            />
          </div>
        </Section>
      )}

      {isDate && (
        <Setting
          k='field.date_mode'
          label='Show'
          effect='Date only hides the time in the picker and wherever this form shows the value.'
        >
          <Segmented
            value={opts.date_mode === 'date' ? 'date' : 'datetime'}
            options={[
              { value: 'datetime', label: 'Date & time' },
              { value: 'date', label: 'Date only' }
            ]}
            onChange={(v) =>
              ctx.setOption(
                'date_mode',
                v === 'date' ? 'date' : undefined,
                v === 'date' ? `Show ${name} as a date only` : `Show ${name} with its time`
              )
            }
          />
        </Setting>
      )}

      {isNumeric && (
        <Section title='Numbers'>
          <Setting
            k='field.precision'
            label='Decimal places'
            effect='Rounds entry and display on this form.'
          >
            <TextInput
              type='number'
              ariaLabel='Decimal places'
              value={opts.precision == null ? '' : String(opts.precision)}
              placeholder='2'
              onChange={(v) => {
                const n = v === '' ? undefined : Math.max(0, Math.min(10, Math.round(Number(v))))
                if (n !== undefined && Number.isNaN(n)) return
                ctx.setOption('precision', n, `Set the decimal places of ${name}`, true)
              }}
            />
          </Setting>
          <Setting
            k='field.format'
            label='Number format'
            scope='field'
            effect='How the value is written everywhere it shows.'
          >
            <Segmented
              value={format}
              options={FORMATS}
              onChange={(v) =>
                ctx.proposeGlobalOption(
                  'field.format',
                  'format',
                  v || undefined,
                  `Show ${name} as ${FORMATS.find((f) => f.value === v)?.label.toLowerCase()}`
                )
              }
            />
          </Setting>
          {format === 'currency' && (
            <Setting
              k='field.currency'
              label='Currency'
              scope='field'
              effect='Three-letter code, for example USD.'
            >
              <DraftInput
                ariaLabel='Currency'
                value={currency}
                placeholder='USD'
                mono
                onCommit={(v) =>
                  ctx.proposeGlobalOption(
                    'field.currency',
                    'currency',
                    v.trim().toUpperCase() || undefined,
                    `Show ${name} in ${v.trim().toUpperCase() || 'USD'}`
                  )
                }
              />
            </Setting>
          )}
          <Setting
            k='field.aggregate'
            label='Grid footer'
            scope='field'
            effect='The figure under this column wherever it shows in a grid.'
          >
            <Choice
              ariaLabel='Grid footer'
              value={aggregate}
              options={AGGREGATES}
              onChange={(v) =>
                ctx.proposeGlobalOption(
                  'field.aggregate',
                  'aggregate',
                  v || undefined,
                  `Change the grid footer of ${name}`
                )
              }
            />
          </Setting>
          <Setting
            k='field.unit'
            label='Unit'
            scope='field'
            effect='"$" shows currency, "%" a percent; other text follows the number. A number format wins.'
          >
            <DraftInput
              ariaLabel='Unit'
              value={unit}
              onCommit={(v) =>
                ctx.proposeGlobalOption(
                  'field.unit',
                  'unit',
                  v || undefined,
                  `Set the unit of ${name}`
                )
              }
            />
          </Setting>
        </Section>
      )}

      {isText && (
        <Setting
          k='field.input_mask'
          label='Input mask'
          scope='field'
          effect='# a digit, A a letter, * anything. The value is stored without the mask.'
        >
          <DraftInput
            ariaLabel='Input mask'
            value={mask}
            mono
            placeholder='(###) ###-####'
            onCommit={(v) =>
              ctx.proposeGlobalOption(
                'field.input_mask',
                'input_mask',
                v || undefined,
                `Set the input mask of ${name}`
              )
            }
          />
        </Setting>
      )}
    </div>
  )
}
