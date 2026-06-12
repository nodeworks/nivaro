import { useCallback, useMemo, useState } from 'react'
import type { FormFieldDescriptor, FormGroupDescriptor, UseNivaroFormReturn } from '../types'

// ─── useFieldState ────────────────────────────────────────────────────────────
// All per-field state in one call. Use this inside custom field renderers so
// you only re-render when that one field changes.

export type FieldState = {
  value: unknown
  error: string[] | undefined
  visible: boolean
  locked: boolean
  required: boolean
  colSpan: number
  descriptor: FormFieldDescriptor | null
  onChange: (v: unknown) => void
}

export function useFieldState(form: UseNivaroFormReturn, field: string): FieldState {
  const descriptor = useMemo(
    () => form.schema?.fields.find((f) => f.field === field) ?? null,
    [form.schema, field]
  )
  const onChange = useCallback((v: unknown) => form.setValue(field, v), [form, field])
  return {
    value: form.values[field],
    error: form.errors[field],
    visible: form.isVisible(field),
    locked: form.isLocked(field),
    required: descriptor?.required ?? false,
    colSpan: (descriptor?.options?.col_span as number | undefined) ?? 12,
    descriptor,
    onChange,
  }
}

// ─── useWatchFields ───────────────────────────────────────────────────────────
// Reactive slice of values. Only the listed fields; doesn't subscribe to the
// rest of the form. Use for conditional logic, computed displays, cross-field
// validation without triggering a whole-form re-render.

export function useWatchFields(
  form: UseNivaroFormReturn,
  fields: string[]
): Record<string, unknown> {
  return useMemo(() => {
    const out: Record<string, unknown> = {}
    for (const f of fields) out[f] = form.values[f]
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.values, fields.join(',')])
}

// ─── useFormDirty ─────────────────────────────────────────────────────────────
// Already on UseNivaroFormReturn, but this gives per-field granularity and a
// list of changed fields — useful for partial-save or "unsaved changes" banners.

export type FormDirtyState = {
  isDirty: boolean
  dirtyFields: string[]
  isFieldDirty: (field: string) => boolean
}

export function useFormDirty(
  form: UseNivaroFormReturn,
  initialValues?: Record<string, unknown>
): FormDirtyState {
  const initial = initialValues ?? {}
  const dirtyFields = useMemo(
    () =>
      Object.keys(form.values).filter((f) => {
        const cur = JSON.stringify(form.values[f])
        const orig = JSON.stringify(initial[f])
        return cur !== orig
      }),
    [form.values, initial]
  )
  const isFieldDirty = useCallback((f: string) => dirtyFields.includes(f), [dirtyFields])
  return { isDirty: dirtyFields.length > 0, dirtyFields, isFieldDirty }
}

// ─── useTabState ──────────────────────────────────────────────────────────────
// Tab management for tab-mode layouts. Pairs with useOrderedLayout.

export type TabState = {
  activeTab: string | null
  setActiveTab: (key: string) => void
  tabs: FormGroupDescriptor[]
  hasTabs: boolean
}

export function useTabState(form: UseNivaroFormReturn): TabState {
  const tabs = useMemo(
    () => (form.schema?.groups ?? []).filter((g) => g.type === 'tab'),
    [form.schema]
  )
  const [activeTab, setActiveTab] = useState<string | null>(null)
  const current = activeTab ?? tabs[0]?.key ?? null
  return { activeTab: current, setActiveTab, tabs, hasTabs: tabs.length > 0 }
}

// ─── useSectionState ─────────────────────────────────────────────────────────
// Collapsed state for section-mode groups.

export type SectionState = {
  isCollapsed: (key: string) => boolean
  toggle: (key: string) => void
  collapseAll: () => void
  expandAll: () => void
}

export function useSectionState(
  form: UseNivaroFormReturn,
  defaultCollapsed: string[] = []
): SectionState {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set(defaultCollapsed))
  const isCollapsed = useCallback((key: string) => collapsed.has(key), [collapsed])
  const toggle = useCallback(
    (key: string) =>
      setCollapsed((prev) => {
        const next = new Set(prev)
        next.has(key) ? next.delete(key) : next.add(key)
        return next
      }),
    []
  )
  const sections = useMemo(
    () => (form.schema?.groups ?? []).filter((g) => g.type === 'section').map((g) => g.key),
    [form.schema]
  )
  const collapseAll = useCallback(() => setCollapsed(new Set(sections)), [sections])
  const expandAll = useCallback(() => setCollapsed(new Set()), [])
  return { isCollapsed, toggle, collapseAll, expandAll }
}

// ─── useOrderedLayout ─────────────────────────────────────────────────────────
// The fully-resolved render order respecting ungroupedSort.
// Returns an array where each entry is either a group descriptor or the
// '__ungrouped__' sentinel, in the order they should appear on screen.

export type LayoutItem = FormGroupDescriptor | '__ungrouped__'

export function useOrderedLayout(form: UseNivaroFormReturn): {
  items: LayoutItem[]
  hasTabs: boolean
  tabGroups: FormGroupDescriptor[]
  sectionGroups: FormGroupDescriptor[]
  ungroupedFields: FormFieldDescriptor[]
} {
  return useMemo(() => {
    const groups = form.schema?.groups ?? []
    const tabGroups = groups.filter((g) => g.type === 'tab')
    const sectionGroups = groups.filter((g) => g.type === 'section')
    const hasTabs = tabGroups.length > 0

    const ungroupedFields = (form.fieldsByGroup.get(null) ?? []).filter((f) =>
      form.isVisible(f.field)
    )

    // In tab mode, sections live inside a General tab — only tabs need ordering.
    // Ungrouped position is above/below the strip, handled separately.
    if (hasTabs) {
      return { items: tabGroups, hasTabs, tabGroups, sectionGroups, ungroupedFields }
    }

    // Section mode: splice __ungrouped__ at the configured position
    const pos = form.schema?.ungroupedSort ?? sectionGroups.length
    const clamped = Math.min(pos, sectionGroups.length)
    const items: LayoutItem[] = [...sectionGroups]
    items.splice(clamped, 0, '__ungrouped__')
    return { items, hasTabs, tabGroups, sectionGroups, ungroupedFields }
  }, [form.schema, form.fieldsByGroup, form.isVisible])
}

// ─── useFormStatus ────────────────────────────────────────────────────────────
// Consolidated status for submit buttons and save indicators.

export type FormStatus = {
  isDirty: boolean
  isValid: boolean
  isSubmitting: boolean
  isLoading: boolean
  canSubmit: boolean
}

export function useFormStatus(form: UseNivaroFormReturn): FormStatus {
  const hasErrors = Object.keys(form.errors).length > 0
  return {
    isDirty: form.isDirty,
    isValid: !hasErrors,
    isSubmitting: form.isSubmitting,
    isLoading: form.isLoading,
    canSubmit: form.isDirty && !hasErrors && !form.isSubmitting,
  }
}

// ─── useFieldArray ────────────────────────────────────────────────────────────
// Repeater/array field management.

export type FieldArrayReturn = {
  items: unknown[]
  append: (item?: unknown) => void
  remove: (index: number) => void
  move: (from: number, to: number) => void
  update: (index: number, value: unknown) => void
  replace: (items: unknown[]) => void
}

export function useFieldArray(form: UseNivaroFormReturn, field: string): FieldArrayReturn {
  const raw = form.values[field]
  const items: unknown[] = Array.isArray(raw) ? raw : []

  const replace = useCallback(
    (next: unknown[]) => form.setValue(field, next),
    [form, field]
  )
  const append = useCallback(
    (item: unknown = {}) => replace([...items, item]),
    [items, replace]
  )
  const remove = useCallback(
    (index: number) => replace(items.filter((_, i) => i !== index)),
    [items, replace]
  )
  const move = useCallback(
    (from: number, to: number) => {
      const next = [...items]
      const [el] = next.splice(from, 1)
      next.splice(to, 0, el)
      replace(next)
    },
    [items, replace]
  )
  const update = useCallback(
    (index: number, value: unknown) => {
      const next = [...items]
      next[index] = value
      replace(next)
    },
    [items, replace]
  )

  return { items, append, remove, move, update, replace }
}
