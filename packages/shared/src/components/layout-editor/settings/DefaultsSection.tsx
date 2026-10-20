import { DefaultValuesEditor } from '../editors/DefaultValuesEditor'
import {
  QUICK_PICKER_MAX,
  QuickPickerStepsEditor,
  seedSteps
} from '../editors/QuickPickerStepsEditor'
import { quietText, Setting, smallBtn } from './controls'
import { changeLabel, type SectionProps } from './section-props'
import { useSettingsFields, useSettingsRelations } from './settings-api'

function stepsOf(raw: unknown): string[] {
  let v = raw
  if (typeof v === 'string') {
    try {
      v = JSON.parse(v)
    } catch {
      return []
    }
  }
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
}

export function DefaultsSection(props: SectionProps) {
  const { layout, collection } = props
  const fields = useSettingsFields(collection)
  const relations = useSettingsRelations(collection)
  const steps = stepsOf(layout.quick_picker)
  const setSteps = (next: string[], label: string) =>
    props.set({ quick_picker: next.length ? next.slice(0, QUICK_PICKER_MAX) : null }, label)
  const seeded = seedSteps(fields, relations, collection)
  return (
    <>
      <Setting k='layout.default_values'>
        <DefaultValuesEditor
          collection={collection}
          value={layout.default_values}
          fields={fields}
          relations={relations}
          onBlur={props.flush}
          onChange={(values, { text }) =>
            (text ? props.setText : props.set)(
              { default_values: values },
              changeLabel('layout.default_values')
            )
          }
        />
      </Setting>
      <Setting k='layout.quick_picker'>
        <QuickPickerStepsEditor
          steps={steps}
          fields={fields}
          relations={relations}
          collection={collection}
          showSeed={false}
          onChange={(next) => setSteps(next, changeLabel('layout.quick_picker'))}
        />
      </Setting>
      <Setting
        k='layout.quick_picker_seed'
        control={
          <button
            type='button'
            className={smallBtn}
            disabled={seeded.length === 0}
            onClick={() => setSteps(seeded, 'Fill quick picker steps from cascade rules')}
          >
            Fill steps
          </button>
        }
        note={
          seeded.length === 0 ? (
            <span className={quietText}>
              No cascade rules on this collection's relation fields.
            </span>
          ) : null
        }
      />
    </>
  )
}
