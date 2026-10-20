import { useQuery } from '@tanstack/react-query'
import { Combobox } from './controls'
import { useEditorApi } from './editor-api'

export function O2MAggFieldCombobox({
  relatedCollection,
  value,
  onChange
}: {
  relatedCollection: string | null
  value: string
  onChange: (fieldName: string, fieldOptions: string | null) => void
}) {
  const api = useEditorApi()
  const { data } = useQuery<{ data: Array<{ field: string; type: string; options: unknown }> }>({
    queryKey: ['field-config', relatedCollection],
    queryFn: () => api.get(`/field-config/${relatedCollection}`).then((r) => r.data),
    enabled: !!relatedCollection,
    staleTime: 120_000
  })
  const fields = (data?.data ?? []).filter((f) => !f.field.startsWith('_'))
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
