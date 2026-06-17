import { useCallback, useMemo, useState } from 'react';
export function useFieldState(form, field) {
    const descriptor = useMemo(() => form.schema?.fields.find((f) => f.field === field) ?? null, [form.schema, field]);
    // Depend on form.setValue directly so onChange stays stable when other form
    // state (values, errors) changes but setValue does not.
    const onChange = useCallback((v) => form.setValue(field, v), [form.setValue, field]);
    return {
        value: form.values[field],
        error: form.errors[field],
        visible: form.isVisible(field),
        locked: form.isLocked(field),
        required: descriptor?.required ?? false,
        colSpan: descriptor?.options?.col_span ?? 12,
        descriptor,
        onChange
    };
}
// ─── useWatchFields ───────────────────────────────────────────────────────────
// Reactive slice of values. Only the listed fields; doesn't subscribe to the
// rest of the form. Use for conditional logic, computed displays, cross-field
// validation without triggering a whole-form re-render.
export function useWatchFields(form, fields) {
    return useMemo(() => {
        const out = {};
        for (const f of fields)
            out[f] = form.values[f];
        return out;
    }, [form.values, fields]);
}
export function useFormDirty(form, initialValuesOverride) {
    // Use the form's own tracked initialValues by default so callers don't have
    // to supply a snapshot manually.
    const initial = initialValuesOverride ?? form.initialValues;
    const dirtyFields = useMemo(() => Object.keys(form.values).filter((f) => {
        const cur = JSON.stringify(form.values[f]);
        const orig = JSON.stringify(initial[f]);
        return cur !== orig;
    }), [form.values, initial]);
    const isFieldDirty = useCallback((f) => dirtyFields.includes(f), [dirtyFields]);
    return { isDirty: dirtyFields.length > 0, dirtyFields, isFieldDirty };
}
export function useTabState(form) {
    const tabs = useMemo(() => (form.schema?.groups ?? []).filter((g) => g.type === 'tab'), [form.schema]);
    const [activeTab, setActiveTab] = useState(null);
    const current = activeTab ?? tabs[0]?.key ?? null;
    return { activeTab: current, setActiveTab, tabs, hasTabs: tabs.length > 0 };
}
export function useSectionState(form, defaultCollapsed = []) {
    const [collapsed, setCollapsed] = useState(new Set(defaultCollapsed));
    const isCollapsed = useCallback((key) => collapsed.has(key), [collapsed]);
    const toggle = useCallback((key) => setCollapsed((prev) => {
        const next = new Set(prev);
        next.has(key) ? next.delete(key) : next.add(key);
        return next;
    }), []);
    const sections = useMemo(() => (form.schema?.groups ?? []).filter((g) => g.type === 'section').map((g) => g.key), [form.schema]);
    const collapseAll = useCallback(() => setCollapsed(new Set(sections)), [sections]);
    const expandAll = useCallback(() => setCollapsed(new Set()), []);
    return { isCollapsed, toggle, collapseAll, expandAll };
}
export function useOrderedLayout(form) {
    return useMemo(() => {
        const groups = form.schema?.groups ?? [];
        const tabGroups = groups.filter((g) => g.type === 'tab');
        const sectionGroups = groups.filter((g) => g.type === 'section');
        const hasTabs = tabGroups.length > 0;
        const ungroupedFields = (form.fieldsByGroup.get(null) ?? []).filter((f) => form.isVisible(f.field));
        // In tab mode, sections live inside a General tab — only tabs need ordering.
        // Ungrouped position is above/below the strip, handled separately.
        if (hasTabs) {
            return { items: tabGroups, hasTabs, tabGroups, sectionGroups, ungroupedFields };
        }
        // Section mode: splice __ungrouped__ at the configured position
        const pos = form.schema?.ungroupedSort ?? sectionGroups.length;
        const clamped = Math.min(pos, sectionGroups.length);
        const items = [...sectionGroups];
        items.splice(clamped, 0, '__ungrouped__');
        return { items, hasTabs, tabGroups, sectionGroups, ungroupedFields };
    }, [form.schema, form.fieldsByGroup, form.isVisible]);
}
export function useFormStatus(form) {
    const hasErrors = Object.keys(form.errors).length > 0;
    return {
        isDirty: form.isDirty,
        isValid: !hasErrors,
        isSubmitting: form.isSubmitting,
        isLoading: form.isLoading,
        canSubmit: form.isDirty && !hasErrors && !form.isSubmitting
    };
}
export function useFieldArray(form, field) {
    const raw = form.values[field];
    const items = Array.isArray(raw) ? raw : [];
    // Depend on form.setValue directly, not the entire form object.
    const { setValue } = form;
    const replace = useCallback((next) => setValue(field, next), [setValue, field]);
    const append = useCallback((item = {}) => replace([...items, item]), [items, replace]);
    const remove = useCallback((index) => replace(items.filter((_, i) => i !== index)), [items, replace]);
    const move = useCallback((from, to) => {
        const next = [...items];
        const [el] = next.splice(from, 1);
        next.splice(to, 0, el);
        replace(next);
    }, [items, replace]);
    const update = useCallback((index, value) => {
        const next = [...items];
        next[index] = value;
        replace(next);
    }, [items, replace]);
    return { items, append, remove, move, update, replace };
}
//# sourceMappingURL=useLayoutHooks.js.map