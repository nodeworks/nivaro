import React from 'react'
import type {
  ComponentOverrides,
  FormFieldDescriptor,
  FormGroupDescriptor,
  UseNivaroFormReturn
} from '../types'
import { NivaroField } from './NivaroField'

type NivaroFormProps = {
  /** the object returned by useNivaroForm */
  form: UseNivaroFormReturn
  /** custom render children; if omitted the form auto-renders all fields/groups */
  children?: React.ReactNode
  /** override specific field-type renderers */
  components?: ComponentOverrides
  /** wrap/replace the rendering of a single field */
  renderField?: (
    field: FormFieldDescriptor,
    defaultRender: () => React.ReactNode
  ) => React.ReactNode
  /** wrap/replace the rendering of a group + its fields */
  renderGroup?: (
    group: FormGroupDescriptor | null,
    fields: React.ReactNode
  ) => React.ReactNode
  className?: string
  style?: React.CSSProperties
}

/**
 * Optional convenience wrapper that renders a <form> driven by useNivaroForm.
 * Provide `children` to fully control layout, or omit them to auto-render every
 * group and its fields via NivaroField.
 */
export function NivaroForm({
  form,
  children,
  components,
  renderField,
  renderGroup,
  className,
  style
}: NivaroFormProps) {
  const { schema, values, errors, setValue, isVisible, isLocked, isSubmitting } = form

  const renderOneField = (field: FormFieldDescriptor): React.ReactNode => {
    if (!isVisible(field.field)) return null
    const defaultRender = () => (
      <NivaroField
        key={field.field}
        field={field}
        value={values[field.field]}
        onChange={(v) => setValue(field.field, v)}
        error={errors[field.field]}
        disabled={isSubmitting}
        readOnly={isLocked(field.field)}
        components={components}
      />
    )
    if (renderField) return <React.Fragment key={field.field}>{renderField(field, defaultRender)}</React.Fragment>
    return defaultRender()
  }

  const renderGroupBlock = (
    group: FormGroupDescriptor | null,
    fields: FormFieldDescriptor[]
  ): React.ReactNode => {
    const renderedFields = <>{fields.map((f) => renderOneField(f))}</>
    if (renderGroup) {
      const key = group?.key ?? '__ungrouped__'
      return <React.Fragment key={key}>{renderGroup(group, renderedFields)}</React.Fragment>
    }
    if (!group) {
      return <React.Fragment key="__ungrouped__">{renderedFields}</React.Fragment>
    }
    return (
      <fieldset key={group.key} data-nivaro-group={group.key} data-group-type={group.type}>
        <legend>{group.label}</legend>
        {renderedFields}
      </fieldset>
    )
  }

  const autoBody = () => {
    if (!schema) return null
    const ungrouped = form.fieldsByGroup.get(null) ?? []
    return (
      <>
        {ungrouped.length > 0 ? renderGroupBlock(null, ungrouped) : null}
        {form.visibleGroups.map((g) =>
          renderGroupBlock(g, form.fieldsByGroup.get(g.key) ?? [])
        )}
      </>
    )
  }

  return (
    <form className={className} style={style} onSubmit={form.handleSubmit}>
      {children ?? autoBody()}
    </form>
  )
}
