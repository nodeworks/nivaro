import React, { useMemo, useState } from 'react'
import { GridFlushContext } from '../context'
import type {
  ComponentOverrides,
  FormFieldDescriptor,
  FormGroupDescriptor,
  FormSlotAssignment,
  UseNivaroFormReturn
} from '../types'
import { NivaroField } from './NivaroField'
import { CommentsSlot } from './slots/CommentsSlot'
import { PipelineSlot } from './slots/PipelineSlot'
import { TasksSlot } from './slots/TasksSlot'

const BUILT_IN_SLOT_RENDERERS: Record<string, (props: SlotRendererProps) => React.ReactNode> = {
  __pipeline__: (props) => <PipelineSlot {...props} />,
  __comments__: (props) => <CommentsSlot {...props} />,
  __tasks__: (props) => <TasksSlot {...props} />
}

export type SlotRendererProps = {
  slot: string
  collection: string
  itemId: string | number | null | undefined
  labelOverride: string | null
  defaultExpanded: boolean
}

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
  /**
   * Slot renderers — keyed by slot name (__pipeline__, __comments__, __tasks__).
   * Called with { slot, collection, itemId, labelOverride, defaultExpanded }.
   * If omitted, slots are silently skipped.
   */
  slotRenderers?: Record<string, (props: SlotRendererProps) => React.ReactNode>
  /**
   * itemId of the currently-loaded item — needed for slot renderers.
   * For edit mode: pass the item id. For create mode: leave undefined.
   */
  itemId?: string | number | null
  /** CSS class for the stepper strip wrapper (steps mode) */
  stepperClassName?: string
  /** CSS class for the prev/next button bar (steps mode) */
  stepNavClassName?: string
  /** CSS class for the Prev button */
  prevButtonClassName?: string
  /** CSS class for the Next/Save button */
  nextButtonClassName?: string
  /** Extra content rendered before the Save button on the last step (steps mode only) */
  lastStepActions?: React.ReactNode
  /**
   * Layout slug that was used to load this form's schema.
   * Informational only — schema resolution happens in useNivaroForm.
   */
  layoutSlug?: string
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
 * - Tab-type groups become clickable tabs (or step wizards when tabMode='steps')
 * - Section-type groups become collapsible sections
 * - Ungrouped fields appear at the position set in the Layout tab
 * - Fields honour their col_span width inside a 12-column grid
 * - Page slots (__pipeline__, __comments__, __tasks__) rendered via slotRenderers
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
  slotRenderers,
  itemId,
  stepperClassName,
  stepNavClassName,
  prevButtonClassName,
  nextButtonClassName,
  lastStepActions,
  layoutSlug: _layoutSlug
}: LayoutFormProps) {
  const { schema, values, errors, setValue, isVisible, isLocked, isSubmitting, gridFlushersRef } =
    form

  const gridFlushCtx = useMemo(
    () => ({
      register: (key: string, fn: () => Promise<void>) => {
        gridFlushersRef.current.set(key, fn)
      },
      unregister: (key: string) => {
        gridFlushersRef.current.delete(key)
      }
    }),
    [gridFlushersRef]
  )

  const [activeTabIndex, setActiveTabIndex] = useState(0)
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  // For tab mode: key-based active tab
  const [activeTabKey, setActiveTabKey] = useState<string | null>(null)

  if (!schema) return null

  const tabGroups = schema.groups.filter((g) => g.type === 'tab')
  const sectionGroups = schema.groups.filter((g) => g.type === 'section')
  const hasTabs = tabGroups.length > 0
  const isStepsMode = hasTabs && schema.tabMode === 'steps'

  const currentTabKey = activeTabKey ?? tabGroups[0]?.key ?? null

  const ungroupedFields = (form.fieldsByGroup.get(null) ?? []).filter((f) => isVisible(f.field))

  function renderField(field: FormFieldDescriptor) {
    if (!isVisible(field.field)) return null
    return (
      <div
        key={field.field}
        style={colSpanStyle(getColSpan(field))}
        data-nivaro-field={field.field}
      >
        <NivaroField
          field={field}
          value={values[field.field]}
          onChange={(v) => setValue(field.field, v)}
          error={errors[field.field]}
          disabled={isSubmitting}
          readOnly={isLocked(field.field)}
          components={components}
          itemId={itemId}
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

  function renderSlot(sa: FormSlotAssignment) {
    if (!sa.isVisible) return null
    const renderer = slotRenderers?.[sa.slot] ?? BUILT_IN_SLOT_RENDERERS[sa.slot]
    if (!renderer) return null
    return (
      <div key={sa.slot} data-nivaro-slot={sa.slot}>
        {renderer({
          slot: sa.slot,
          collection: schema!.collection,
          itemId: itemId ?? null,
          labelOverride: sa.labelOverride,
          defaultExpanded: sa.defaultExpanded
        })}
      </div>
    )
  }

  // Build interleaved section content: groups + ungrouped + slots, ordered by sort
  function buildSectionOrder(): Array<{
    key: string
    sort: number
    render: () => React.ReactNode
  }> {
    const items: Array<{ key: string; sort: number; render: () => React.ReactNode }> = []
    for (const g of sectionGroups) {
      items.push({ key: g.key, sort: g.sort, render: () => renderSection(g) })
    }
    const ungroupedSort = schema!.ungroupedSort ?? sectionGroups.length
    items.push({ key: '__ungrouped__', sort: ungroupedSort, render: renderUngrouped })
    for (const sa of schema!.slotAssignments) {
      if (!sa.isVisible) continue
      const hasRenderer = !!(slotRenderers?.[sa.slot] ?? BUILT_IN_SLOT_RENDERERS[sa.slot])
      if (!hasRenderer) continue
      items.push({ key: sa.slot, sort: sa.sort, render: () => renderSlot(sa) })
    }
    return items.sort((a, b) => a.sort - b.sort)
  }

  function renderSectionMode() {
    return (
      <>
        {buildSectionOrder().map((item) => (
          <React.Fragment key={item.key}>{item.render()}</React.Fragment>
        ))}
      </>
    )
  }

  function renderTabMode() {
    const belowStrip =
      schema!.ungroupedSort != null && schema!.ungroupedSort >= schema!.groups.length

    // Slots that are not in any specific tab (group_key = null) render below tab content
    const globalSlots = schema!.slotAssignments.filter(
      (sa) =>
        sa.isVisible &&
        sa.groupKey == null &&
        !!(slotRenderers?.[sa.slot] ?? BUILT_IN_SLOT_RENDERERS[sa.slot])
    )

    return (
      <>
        {!belowStrip && renderUngrouped()}
        <div className={tabStripClassName} data-nivaro-tab-strip role='tablist'>
          {tabGroups.map((g) => (
            <button
              key={g.key}
              type='button'
              role='tab'
              aria-selected={currentTabKey === g.key}
              onClick={() => setActiveTabKey(g.key)}
              className={currentTabKey === g.key ? activeTabClassName : inactiveTabClassName}
            >
              {g.label}
            </button>
          ))}
          {sectionGroups.length > 0 && (
            <button
              type='button'
              role='tab'
              aria-selected={currentTabKey === '__general__'}
              onClick={() => setActiveTabKey('__general__')}
              className={
                currentTabKey === '__general__' ? activeTabClassName : inactiveTabClassName
              }
            >
              General
            </button>
          )}
        </div>
        {tabGroups.map((g) => {
          const fields = (form.fieldsByGroup.get(g.key) ?? []).filter((f) => isVisible(f.field))
          return (
            <div
              key={g.key}
              role='tabpanel'
              data-nivaro-tab={g.key}
              style={currentTabKey !== g.key ? { display: 'none' } : undefined}
            >
              {renderGrid(fields)}
            </div>
          )
        })}
        {currentTabKey === '__general__' && sectionGroups.length > 0 && (
          <div role='tabpanel' data-nivaro-tab='__general__'>
            {sectionGroups.map(renderSection)}
          </div>
        )}
        {belowStrip && renderUngrouped()}
        {globalSlots.sort((a, b) => a.sort - b.sort).map(renderSlot)}
      </>
    )
  }

  // ─── Steps mode ─────────────────────────────────────────────────────────────
  function renderStepsMode() {
    const totalSteps = tabGroups.length
    const currentStep = Math.min(Math.max(activeTabIndex, 0), totalSteps - 1)
    const currentGroup = tabGroups[currentStep]

    // Slots with no group_key are global — render below current step content
    const globalSlots = schema!.slotAssignments
      .filter((sa) => sa.isVisible && sa.groupKey == null && sa.slot !== '__pipeline__')
      .sort((a, b) => a.sort - b.sort)

    const pipelineSlot = schema!.slotAssignments.find(
      (sa) => sa.slot === '__pipeline__' && sa.isVisible
    )

    // Ungrouped fields: show only when their sort position matches the current step area
    // In steps mode ungrouped fields appear after all steps, so only show on last step
    const ungroupedSort = schema!.ungroupedSort
    const showUngrouped =
      ungroupedFields.length > 0 && (ungroupedSort == null || ungroupedSort >= tabGroups.length)
        ? currentStep === totalSteps - 1
        : false

    const _fields = (form.fieldsByGroup.get(currentGroup?.key ?? '') ?? []).filter((f) =>
      isVisible(f.field)
    )

    return (
      <>
        {/* Pipeline slot above stepper */}
        {pipelineSlot && renderSlot(pipelineSlot)}

        {/* Stepper strip */}
        <div className={stepperClassName} data-nf-stepper data-nf-steps={totalSteps}>
          {tabGroups.map((g, i) => (
            <React.Fragment key={g.key}>
              {i > 0 && (
                <div
                  data-nf-step-connector
                  data-completed={itemId != null || i <= currentStep ? 'true' : 'false'}
                />
              )}
              <button
                type='button'
                data-nf-step={g.key}
                data-nf-step-index={i}
                data-active={i === currentStep ? 'true' : 'false'}
                data-completed={
                  (itemId != null ? i !== currentStep : i < currentStep) ? 'true' : 'false'
                }
                onClick={() => setActiveTabIndex(i)}
                aria-current={i === currentStep ? 'step' : undefined}
              >
                <span data-nf-step-circle>
                  {(itemId != null ? i !== currentStep : i < currentStep) ? '✓' : i + 1}
                </span>
                <span data-nf-step-label>{g.label}</span>
              </button>
            </React.Fragment>
          ))}
        </div>

        {/* All step content — always mounted, hidden when not active to avoid remount/refetch */}
        {tabGroups.map((g, i) => {
          const stepFields = (form.fieldsByGroup.get(g.key) ?? []).filter((f) => isVisible(f.field))
          const isLastStep = i === totalSteps - 1
          return (
            <div
              key={g.key}
              data-nf-step-content={g.key}
              style={i !== currentStep ? { display: 'none' } : undefined}
            >
              {renderGrid(stepFields)}
              {isLastStep && showUngrouped && renderUngrouped()}
              {isLastStep && sectionGroups.map(renderSection)}
            </div>
          )
        })}

        {/* Global slots below current step */}
        {globalSlots.map(renderSlot)}

        {/* Prev / Next navigation */}
        <div className={stepNavClassName} data-nf-step-nav>
          <button
            type='button'
            data-nf-prev
            className={prevButtonClassName}
            disabled={currentStep === 0}
            onClick={() => setActiveTabIndex((s) => Math.max(0, s - 1))}
          >
            Previous
          </button>
          <span data-nf-step-indicator>
            Step {currentStep + 1} of {totalSteps}
          </span>
          {currentStep < totalSteps - 1 ? (
            <button
              type='button'
              data-nf-next
              className={nextButtonClassName}
              onClick={() => setActiveTabIndex((s) => Math.min(totalSteps - 1, s + 1))}
            >
              Next
            </button>
          ) : (
            <>
              {lastStepActions}
              <button
                type='submit'
                data-nf-save
                className={nextButtonClassName}
                disabled={isSubmitting}
              >
                Save
              </button>
            </>
          )}
        </div>
      </>
    )
  }

  return (
    <GridFlushContext.Provider value={gridFlushCtx}>
      <form className={className} style={style} onSubmit={form.handleSubmit}>
        {isStepsMode ? renderStepsMode() : hasTabs ? renderTabMode() : renderSectionMode()}
      </form>
    </GridFlushContext.Provider>
  )
}
