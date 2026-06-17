import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import React, { useMemo, useState } from 'react';
import { GridFlushContext } from '../context';
import { NivaroField } from './NivaroField';
import { CommentsSlot } from './slots/CommentsSlot';
import { PipelineSlot } from './slots/PipelineSlot';
import { TasksSlot } from './slots/TasksSlot';
const BUILT_IN_SLOT_RENDERERS = {
    __pipeline__: (props) => _jsx(PipelineSlot, { ...props }),
    __comments__: (props) => _jsx(CommentsSlot, { ...props }),
    __tasks__: (props) => _jsx(TasksSlot, { ...props })
};
function colSpanStyle(span) {
    const s = span ?? 12;
    return { gridColumn: `span ${s}` };
}
function getColSpan(field) {
    return field.options?.col_span ?? 12;
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
export function LayoutForm({ form, components, className, style, sectionClassName, tabStripClassName, activeTabClassName, inactiveTabClassName, gridClassName = 'nivaro-grid', slotRenderers, itemId, stepperClassName, stepNavClassName, prevButtonClassName, nextButtonClassName, lastStepActions, layoutSlug: _layoutSlug }) {
    const { schema, values, errors, setValue, isVisible, isLocked, isSubmitting, gridFlushersRef } = form;
    const gridFlushCtx = useMemo(() => ({
        register: (key, fn) => {
            gridFlushersRef.current.set(key, fn);
        },
        unregister: (key) => {
            gridFlushersRef.current.delete(key);
        }
    }), [gridFlushersRef]);
    const [activeTabIndex, setActiveTabIndex] = useState(0);
    const [collapsed, setCollapsed] = useState(new Set());
    // For tab mode: key-based active tab
    const [activeTabKey, setActiveTabKey] = useState(null);
    if (!schema)
        return null;
    const tabGroups = schema.groups.filter((g) => g.type === 'tab');
    const sectionGroups = schema.groups.filter((g) => g.type === 'section');
    const hasTabs = tabGroups.length > 0;
    const isStepsMode = hasTabs && schema.tabMode === 'steps';
    const currentTabKey = activeTabKey ?? tabGroups[0]?.key ?? null;
    const ungroupedFields = (form.fieldsByGroup.get(null) ?? []).filter((f) => isVisible(f.field));
    function renderField(field) {
        if (!isVisible(field.field))
            return null;
        return (_jsx("div", { style: colSpanStyle(getColSpan(field)), "data-nivaro-field": field.field, children: _jsx(NivaroField, { field: field, value: values[field.field], onChange: (v) => setValue(field.field, v), error: errors[field.field], disabled: isSubmitting, readOnly: isLocked(field.field), components: components, itemId: itemId }) }, field.field));
    }
    function renderGrid(fields) {
        const visible = fields.filter((f) => isVisible(f.field));
        if (visible.length === 0)
            return null;
        return (_jsx("div", { className: gridClassName, style: { display: 'grid', gridTemplateColumns: 'repeat(12, minmax(0, 1fr))', gap: '1rem' }, children: visible.map(renderField) }));
    }
    function renderSection(group) {
        const fields = form.fieldsByGroup.get(group.key) ?? [];
        const visible = fields.filter((f) => isVisible(f.field));
        if (visible.length === 0)
            return null;
        const isCollapsed = collapsed.has(group.key);
        return (_jsxs("div", { className: sectionClassName, "data-nivaro-section": group.key, children: [_jsx("button", { type: 'button', "data-nivaro-section-toggle": group.key, "aria-expanded": !isCollapsed, onClick: () => setCollapsed((prev) => {
                        const next = new Set(prev);
                        isCollapsed ? next.delete(group.key) : next.add(group.key);
                        return next;
                    }), children: group.label }), !isCollapsed && renderGrid(visible)] }, group.key));
    }
    function renderUngrouped() {
        if (ungroupedFields.length === 0)
            return null;
        return (_jsx("div", { "data-nivaro-ungrouped": true, children: renderGrid(ungroupedFields) }, '__ungrouped__'));
    }
    function renderSlot(sa) {
        if (!sa.isVisible)
            return null;
        const renderer = slotRenderers?.[sa.slot] ?? BUILT_IN_SLOT_RENDERERS[sa.slot];
        if (!renderer)
            return null;
        return (_jsx("div", { "data-nivaro-slot": sa.slot, children: renderer({
                slot: sa.slot,
                collection: schema.collection,
                itemId: itemId ?? null,
                labelOverride: sa.labelOverride,
                defaultExpanded: sa.defaultExpanded
            }) }, sa.slot));
    }
    // Build interleaved section content: groups + ungrouped + slots, ordered by sort
    function buildSectionOrder() {
        const items = [];
        for (const g of sectionGroups) {
            items.push({ key: g.key, sort: g.sort, render: () => renderSection(g) });
        }
        const ungroupedSort = schema.ungroupedSort ?? sectionGroups.length;
        items.push({ key: '__ungrouped__', sort: ungroupedSort, render: renderUngrouped });
        for (const sa of schema.slotAssignments) {
            if (!sa.isVisible)
                continue;
            const hasRenderer = !!(slotRenderers?.[sa.slot] ?? BUILT_IN_SLOT_RENDERERS[sa.slot]);
            if (!hasRenderer)
                continue;
            items.push({ key: sa.slot, sort: sa.sort, render: () => renderSlot(sa) });
        }
        return items.sort((a, b) => a.sort - b.sort);
    }
    function renderSectionMode() {
        return (_jsx(_Fragment, { children: buildSectionOrder().map((item) => (_jsx(React.Fragment, { children: item.render() }, item.key))) }));
    }
    function renderTabMode() {
        const belowStrip = schema.ungroupedSort != null && schema.ungroupedSort >= schema.groups.length;
        // Slots that are not in any specific tab (group_key = null) render below tab content
        const globalSlots = schema.slotAssignments.filter((sa) => sa.isVisible &&
            sa.groupKey == null &&
            !!(slotRenderers?.[sa.slot] ?? BUILT_IN_SLOT_RENDERERS[sa.slot]));
        return (_jsxs(_Fragment, { children: [!belowStrip && renderUngrouped(), _jsxs("div", { className: tabStripClassName, "data-nivaro-tab-strip": true, role: 'tablist', children: [tabGroups.map((g) => (_jsx("button", { type: 'button', role: 'tab', "aria-selected": currentTabKey === g.key, onClick: () => setActiveTabKey(g.key), className: currentTabKey === g.key ? activeTabClassName : inactiveTabClassName, children: g.label }, g.key))), sectionGroups.length > 0 && (_jsx("button", { type: 'button', role: 'tab', "aria-selected": currentTabKey === '__general__', onClick: () => setActiveTabKey('__general__'), className: currentTabKey === '__general__' ? activeTabClassName : inactiveTabClassName, children: "General" }))] }), tabGroups.map((g) => {
                    const fields = (form.fieldsByGroup.get(g.key) ?? []).filter((f) => isVisible(f.field));
                    return (_jsx("div", { role: 'tabpanel', "data-nivaro-tab": g.key, style: currentTabKey !== g.key ? { display: 'none' } : undefined, children: renderGrid(fields) }, g.key));
                }), currentTabKey === '__general__' && sectionGroups.length > 0 && (_jsx("div", { role: 'tabpanel', "data-nivaro-tab": '__general__', children: sectionGroups.map(renderSection) })), belowStrip && renderUngrouped(), globalSlots.sort((a, b) => a.sort - b.sort).map(renderSlot)] }));
    }
    // ─── Steps mode ─────────────────────────────────────────────────────────────
    function renderStepsMode() {
        const totalSteps = tabGroups.length;
        const currentStep = Math.min(Math.max(activeTabIndex, 0), totalSteps - 1);
        const currentGroup = tabGroups[currentStep];
        // Slots with no group_key are global — render below current step content
        const globalSlots = schema.slotAssignments
            .filter((sa) => sa.isVisible && sa.groupKey == null && sa.slot !== '__pipeline__')
            .sort((a, b) => a.sort - b.sort);
        const pipelineSlot = schema.slotAssignments.find((sa) => sa.slot === '__pipeline__' && sa.isVisible);
        // Ungrouped fields: show only when their sort position matches the current step area
        // In steps mode ungrouped fields appear after all steps, so only show on last step
        const ungroupedSort = schema.ungroupedSort;
        const showUngrouped = ungroupedFields.length > 0 && (ungroupedSort == null || ungroupedSort >= tabGroups.length)
            ? currentStep === totalSteps - 1
            : false;
        const _fields = (form.fieldsByGroup.get(currentGroup?.key ?? '') ?? []).filter((f) => isVisible(f.field));
        return (_jsxs(_Fragment, { children: [pipelineSlot && renderSlot(pipelineSlot), _jsx("div", { className: stepperClassName, "data-nf-stepper": true, "data-nf-steps": totalSteps, children: tabGroups.map((g, i) => (_jsxs(React.Fragment, { children: [i > 0 && (_jsx("div", { "data-nf-step-connector": true, "data-completed": itemId != null || i <= currentStep ? 'true' : 'false' })), _jsxs("button", { type: 'button', "data-nf-step": g.key, "data-nf-step-index": i, "data-active": i === currentStep ? 'true' : 'false', "data-completed": (itemId != null ? i !== currentStep : i < currentStep) ? 'true' : 'false', onClick: () => setActiveTabIndex(i), "aria-current": i === currentStep ? 'step' : undefined, children: [_jsx("span", { "data-nf-step-circle": true, children: (itemId != null ? i !== currentStep : i < currentStep) ? '✓' : i + 1 }), _jsx("span", { "data-nf-step-label": true, children: g.label })] })] }, g.key))) }), tabGroups.map((g, i) => {
                    const stepFields = (form.fieldsByGroup.get(g.key) ?? []).filter((f) => isVisible(f.field));
                    const isLastStep = i === totalSteps - 1;
                    return (_jsxs("div", { "data-nf-step-content": g.key, style: i !== currentStep ? { display: 'none' } : undefined, children: [renderGrid(stepFields), isLastStep && showUngrouped && renderUngrouped(), isLastStep && sectionGroups.map(renderSection)] }, g.key));
                }), globalSlots.map(renderSlot), _jsxs("div", { className: stepNavClassName, "data-nf-step-nav": true, children: [_jsx("button", { type: 'button', "data-nf-prev": true, className: prevButtonClassName, disabled: currentStep === 0, onClick: () => setActiveTabIndex((s) => Math.max(0, s - 1)), children: "Previous" }), _jsxs("span", { "data-nf-step-indicator": true, children: ["Step ", currentStep + 1, " of ", totalSteps] }), currentStep < totalSteps - 1 ? (_jsx("button", { type: 'button', "data-nf-next": true, className: nextButtonClassName, onClick: () => setActiveTabIndex((s) => Math.min(totalSteps - 1, s + 1)), children: "Next" })) : (_jsxs(_Fragment, { children: [lastStepActions, _jsx("button", { type: 'submit', "data-nf-save": true, className: nextButtonClassName, disabled: isSubmitting, children: "Save" })] }))] })] }));
    }
    return (_jsx(GridFlushContext.Provider, { value: gridFlushCtx, children: _jsx("form", { className: className, style: style, onSubmit: form.handleSubmit, children: isStepsMode ? renderStepsMode() : hasTabs ? renderTabMode() : renderSectionMode() }) }));
}
//# sourceMappingURL=LayoutForm.js.map