import React, { useState } from 'react'
import type {
  ComponentOverrides,
  FormFieldDescriptor,
  FormGroupDescriptor,
  UseNivaroFormReturn,
} from '../types'
import { NivaroField } from './NivaroField'

type LayoutFormProps = {
  form: UseNivaroFormReturn
  components?: ComponentOverrides
  /** CSS class applied to the <form> element */
  className?: string
  style?: React.CSSProperties
  /** CSS class for a section group wrapper */
  sectionClassName?: string
  /** CSS class for a tab strip wrapper */
  tabStripClassName?: string
  /** CSS class for the active tab button */
  activeTabClassName?: string
  /** CSS class for inactive tab buttons */
  inactiveTabClassName?: string
  /** CSS class for the 12-col grid row (col_span chips snap to this) */
  gridClassName?: string
}

function colSpanStyle(span: number | undefined): React.CSSProperties {
  const s = span ?? 12
  return { gridColumn: `span ${s}` }
}

function getColSpan(field: FormFieldDescriptor): number {
  return (field.options?.col_span as number | undefined) ?? 12
}

/**
 * Full layout-aware form renderer.
 *
 * Renders the form exactly as configured in the Layout tab:
 * - Tab-type groups become clickable tabs
 * - Section-type groups become collapsible sections
 * - Ungrouped fields appear at the position set in the Layout tab
 * - Fields honour their col_span width inside a 12-column grid
 *
 * Zero CSS shipped — style via className props or data-* attributes.
 */
export function LayoutForm({
  form,
  components,
  className,
  style,
  sectionClassName,
  tabStripClassName,
  activeTabClassName,
  inactiveTabClassName,
  gridClassName = 'nivaro-grid',
}: LayoutFormProps) {
  const { schema, values, errors, setValue, isVisible, isLocked, isSubmitting } = form

  const [activeTab, setActiveTab] = useState<string | null>(null)
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())

  if (!schema) return null

  const tabGroups = schema.groups.filter((g) => g.type === 'tab')
  const sectionGroups = schema.groups.filter((g) => g.type === 'section')
  const hasTabs = tabGroups.length > 0
  const currentTab = activeTab ?? tabGroups[0]?.key ?? null

  const ungroupedFields = (form.fieldsByGroup.get(null) ?? []).filter((f) => isVisible(f.field))

  function renderField(field: FormFieldDescriptor) {
    if (!isVisible(field.field)) return null
    return (
      <div key={field.field} style={colSpanStyle(getColSpan(field))} data-nivaro-field={field.field}>
        <NivaroField
          field={field}
          value={values[field.field]}
          onChange={(v) => setValue(field.field, v)}
          error={errors[field.field]}
          disabled={isSubmitting}
          readOnly={isLocked(field.field)}
          components={components}
        />
      </div>
    )
  }

  function renderGrid(fields: FormFieldDescriptor[]) {
    const visible = fields.filter((f) => isVisible(f.field))
    if (visible.length === 0) return null
    return (
      <div
        className={gridClassName}
        style={{ display: 'grid', gridTemplateColumns: 'repeat(12, minmax(0, 1fr))', gap: '1rem' }}
      >
        {visible.map(renderField)}
      </div>
    )
  }

  function renderSection(group: FormGroupDescriptor) {
    const fields = form.fieldsByGroup.get(group.key) ?? []
    const visible = fields.filter((f) => isVisible(f.field))
    if (visible.length === 0) return null
    const isCollapsed = collapsed.has(group.key)
    return (
      <div key={group.key} className={sectionClassName} data-nivaro-section={group.key}>
        <button
          type='button'
          data-nivaro-section-toggle={group.key}
          aria-expanded={!isCollapsed}
          onClick={() =>
            setCollapsed((prev) => {
              const next = new Set(prev)
              isCollapsed ? next.delete(group.key) : next.add(group.key)
              return next
            })
          }
        >
          {group.label}
        </button>
        {!isCollapsed && renderGrid(visible)}
      </div>
    )
  }

  function renderUngrouped() {
    if (ungroupedFields.length === 0) return null
    return (
      <div key='__ungrouped__' data-nivaro-ungrouped>
        {renderGrid(ungroupedFields)}
      </div>
    )
  }

  // Build ordered items (sections + ungrouped at configured position)
  function renderSectionMode() {
    const pos = schema!.ungroupedSort ?? schema!.groups.length
    const clamped = Math.min(pos, sectionGroups.length)
    const items: Array<FormGroupDescriptor | '__ungrouped__'> = [...sectionGroups]
    items.splice(clamped, 0, '__ungrouped__')
    return (
      <>
        {items.map((item) =>
          item === '__ungrouped__' ? renderUngrouped() : renderSection(item)
        )}
      </>
    )
  }

  function renderTabMode() {
    const ungroupedAbove = schema!.ungroupedSort == null || schema!.ungroupedSort < schema!.groups.length
      ? schema!.ungroupedSort === null || (schema!.ungroupedSort ?? schema!.groups.length) < (tabGroups.findIndex((g) => g.key === currentTab) + 1)
      : false
    // Simple rule: ungrouped_sort < groups.length = above strip, otherwise below content
    const belowStrip = schema!.ungroupedSort != null && schema!.ungroupedSort >= schema!.groups.length

    return (
      <>
        {!belowStrip && renderUngrouped()}
        <div className={tabStripClassName} data-nivaro-tab-strip role='tablist'>
          {tabGroups.map((g) => (
            <button
              key={g.key}
              type='button'
              role='tab'
              aria-selected={currentTab === g.key}
              onClick={() => setActiveTab(g.key)}
              className={currentTab === g.key ? activeTabClassName : inactiveTabClassName}
            >
              {g.label}
            </button>
          ))}
          {sectionGroups.length > 0 && (
            <button
              type='button'
              role='tab'
              aria-selected={currentTab === '__general__'}
              onClick={() => setActiveTab('__general__')}
              className={currentTab === '__general__' ? activeTabClassName : inactiveTabClassName}
            >
              General
            </button>
          )}
        </div>
        {tabGroups.map((g) => {
          if (currentTab !== g.key) return null
          const fields = (form.fieldsByGroup.get(g.key) ?? []).filter((f) => isVisible(f.field))
          return (
            <div key={g.key} role='tabpanel' data-nivaro-tab={g.key}>
              {renderGrid(fields)}
            </div>
          )
        })}
        {currentTab === '__general__' && sectionGroups.length > 0 && (
          <div role='tabpanel' data-nivaro-tab='__general__'>
            {sectionGroups.map(renderSection)}
          </div>
        )}
        {belowStrip && renderUngrouped()}
      </>
    )
  }

  return (
    <form className={className} style={style} onSubmit={form.handleSubmit}>
      {hasTabs ? renderTabMode() : renderSectionMode()}
    </form>
  )
}
