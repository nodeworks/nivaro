import { Combobox } from './controls'
import { useEditorFieldList } from './editor-queries'

export function O2MAggFieldCombobox({
  relatedCollection,
  value,
  onChange
}: {
  relatedCollection: string | null
  value: string
  onChange: (fieldName: string, fieldOptions: string | null) => void
}) {
  const { data = [] } = useEditorFieldList(relatedCollection)
  const fields = data.filter((f) => !f.field.startsWith('_'))
  const options = fields.map((f) => ({ value: f.field, label: f.field }))
  return (
    <Combobox
      value={value}
      onChange={(v) => {
        const field = fields.find((f) => f.field === v)
        const opts = field?.options
          ? typeof field.options === 'string'
            ? field.options
            : JSON.stringify(field.options)
          : null
        onChange(v, opts)
      }}
      options={options}
      placeholder='Select column…'
    />
  )
}
