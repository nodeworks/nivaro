import { PickList, quietText, Segmented, Setting, Toggle } from './controls'
import { changeLabel, type SectionProps, toggleLabel } from './section-props'
import { fieldOptions, numericFieldNames, useFieldSources } from './settings-api'
import { ToggleSetting } from './ToggleSetting'

export function LayoutSection(props: SectionProps) {
  const { layout } = props
  const tabMode = layout.tab_mode === 'steps' ? 'steps' : 'tabs'
  return (
    <>
      <Setting
        k='layout.tab_mode'
        control={
          <Segmented<'tabs' | 'steps'>
            ariaLabel='Loose tabs show as'
            value={tabMode}
            options={[
              { value: 'tabs', label: 'Tabs' },
              { value: 'steps', label: 'Steps' }
            ]}
            onChange={(v) => props.set({ tab_mode: v }, changeLabel('layout.tab_mode'))}
          />
        }
      />
      <ToggleSetting k='layout.validate_before_next' props={props} />
      <ToggleSetting k='layout.accordion_mode' props={props} />
      <RowOrderSetting {...props} />
    </>
  )
}

function RowOrderSetting(props: SectionProps) {
  const { fields, columns, relations } = useFieldSources(props.collection)
  const numeric = numericFieldNames(props.collection, fields, columns, relations)
  const current = props.layout.row_order_field ? String(props.layout.row_order_field) : null
  const options = fieldOptions(fields, numeric)
  return (
    <Setting
      k='layout.row_order_field'
      control={
        <Toggle
          label='Let people reorder rows'
          checked={!!current}
          disabled={!current && numeric.length === 0}
          onChange={(on) =>
            props.set(
              { row_order_field: on ? (options[0]?.value ?? null) : null },
              toggleLabel('layout.row_order_field', on)
            )
          }
        />
      }
    >
      {current ? (
        <div className='flex items-center gap-2'>
          <span className={quietText}>Order is saved in</span>
          <PickList
            ariaLabel='Order field'
            value={current}
            options={options}
            onChange={(v) =>
              v && props.set({ row_order_field: v }, 'Change the field rows are ordered by')
            }
          />
        </div>
      ) : numeric.length === 0 ? (
        <p className={quietText}>This collection has no number field to keep the order in.</p>
      ) : null}
    </Setting>
  )
}
