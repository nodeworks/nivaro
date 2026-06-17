import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useQueries, useQueryClient } from '@tanstack/react-query';
import { AlertCircle, Info, SlidersHorizontal } from 'lucide-react';
import { useNivaroClient } from '../../context';
import { get } from '../../lib/commands';
import { cn, titleCase } from '../../lib/utils';
import { Label } from '../ui/label';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../ui/tooltip';
import { FieldRenderer } from './FieldRenderer';
import { CascadeEffectController, getCascadeFilters, getColSpanClass, SYSTEM_FIELDS } from './helpers';
import { useM2MStaging } from './M2MStagingContext';
export function FieldRow({ field, draft, onChange, relations, collection, itemId, error, visible, locked, renderField }) {
    // Hooks must be called before any early return
    const m2mStaging = useM2MStaging();
    const queryClient = useQueryClient();
    const client = useNivaroClient();
    // Compute cascade rules before early return so useQueries can subscribe
    const cascadeRules = getCascadeFilters(field.dependency_config);
    const parentM2mRelPairs = cascadeRules.flatMap((rule) => {
        const r = relations.find((r) => r.one_collection === collection && r.one_field === rule.parent_field);
        if (!r)
            return [];
        if (r.junction_field)
            return [{ rule, rel: r }];
        const companion = relations.find((c) => c.many_collection === r.many_collection && c.id !== r.id);
        if (!companion?.many_field)
            return [];
        return [{ rule, rel: { ...r, junction_field: companion.many_field } }];
    });
    const m2mParentResults = useQueries({
        queries: parentM2mRelPairs.map(({ rel }) => ({
            queryKey: ['m2m-items', rel.many_collection, rel.many_field, itemId],
            queryFn: () => client
                .request(get(`/items/${rel.many_collection}`, {
                filter: JSON.stringify({ [rel.many_field]: { _eq: itemId } }),
                limit: 1,
                fields: `id,${rel.junction_field}`
            }))
                .then((r) => r.data ?? []),
            enabled: !!itemId && itemId !== 'new',
            staleTime: 30_000
        }))
    });
    const m2mParentCommitted = Object.fromEntries(parentM2mRelPairs.map(({ rule, rel }, i) => [
        rule.parent_field,
        (m2mParentResults[i]?.data ?? []).map((ji) => ji[rel.junction_field])
    ]));
    if (!visible || field.hidden || SYSTEM_FIELDS.has(field.field))
        return null;
    const value = draft[field.field] ?? null;
    const label = field.label ?? titleCase(field.field);
    // Resolve M2M / M2O relation for this field (for cascade clear logic)
    const m2mRelForField = (() => {
        const r = relations.find((rel) => rel.one_collection === collection && rel.one_field === field.field);
        if (!r)
            return null;
        if (r.junction_field)
            return r;
        const companion = relations.find((c) => c.many_collection === r.many_collection && c.id !== r.id);
        return companion ? { ...r, junction_field: companion.many_field } : null;
    })();
    const m2oRelForField = m2mRelForField
        ? null
        : (relations.find((r) => r.many_collection === collection && r.many_field === field.field) ??
            null);
    const m2mFarEndRel = m2mRelForField
        ? (relations.find((r) => r.many_collection === m2mRelForField.many_collection &&
            r.many_field === m2mRelForField.junction_field &&
            r.id !== m2mRelForField.id) ?? null)
        : null;
    const m2mStagingKey = m2mRelForField
        ? (m2mRelForField.one_field ??
            `${m2mRelForField.many_collection}.${m2mRelForField.junction_field}`)
        : null;
    const m2mStagedForCascade = m2mStagingKey
        ? (m2mStaging?.getStagedLinks(m2mStagingKey) ?? [])
        : [];
    const m2mCommittedForCascade = m2mRelForField
        ? (queryClient.getQueryData([
            'm2m-items',
            m2mRelForField.many_collection,
            m2mRelForField.many_field,
            itemId
        ]) ?? []).map((ji) => ji[m2mRelForField.junction_field])
        : [];
    const cascadeCurrentValue = m2mRelForField
        ? (m2mStagedForCascade[0] ?? m2mCommittedForCascade[0] ?? null)
        : value;
    const cascadeRelatedCollection = m2mFarEndRel?.one_collection ?? m2oRelForField?.one_collection ?? undefined;
    // Cascade filter computation
    let cascadeFilter;
    const cascadeParentLabels = [];
    let unsatisfiedParentLabel = null;
    let requiredParentLabel = null;
    for (const rule of cascadeRules) {
        const parentVal = draft[rule.parent_field] ??
            (() => {
                const r = relations.find((r) => r.one_collection === collection && r.one_field === rule.parent_field);
                if (!r)
                    return null;
                let parentM2mRel = r;
                if (!parentM2mRel.junction_field) {
                    const companion = relations.find((c) => c.many_collection === r.many_collection && c.id !== r.id);
                    if (companion?.many_field)
                        parentM2mRel = { ...r, junction_field: companion.many_field };
                    else
                        return null;
                }
                const key = parentM2mRel.one_field ??
                    `${parentM2mRel.many_collection}.${parentM2mRel.junction_field}`;
                const staged = m2mStaging?.getStagedLinks(key) ?? [];
                if (staged.length > 0)
                    return staged[0];
                const committed = m2mParentCommitted[rule.parent_field] ?? [];
                if (committed.length > 0)
                    return committed[0];
                return null;
            })();
        if (parentVal != null && parentVal !== '') {
            if (!cascadeFilter)
                cascadeFilter = {};
            cascadeFilter[rule.filter_column] = rule.filter_is_m2m
                ? { _some: { id: { _eq: parentVal } } }
                : { _eq: parentVal };
            cascadeParentLabels.push(titleCase(String(rule.parent_field)));
        }
        else {
            if (!unsatisfiedParentLabel)
                unsatisfiedParentLabel = titleCase(String(rule.parent_field));
            if (rule.show_all_if_no_parent === false && !requiredParentLabel) {
                requiredParentLabel = titleCase(String(rule.parent_field));
            }
        }
    }
    const handleCascadeClear = () => {
        if (m2mRelForField && m2mStagingKey) {
            for (const rid of m2mStagedForCascade)
                m2mStaging?.unstageLink(m2mStagingKey, rid);
            const junctionItems = queryClient.getQueryData([
                'm2m-items',
                m2mRelForField.many_collection,
                m2mRelForField.many_field,
                itemId
            ]) ?? [];
            for (const ji of junctionItems)
                m2mStaging?.stageUnlink(m2mStagingKey, ji.id);
        }
        else {
            onChange(field.field, null);
        }
    };
    return (_jsxs("div", { "data-field": field.field, className: 'space-y-1.5', children: [cascadeRules.length > 0 && (_jsx(CascadeEffectController, { cascadeRules: cascadeRules, cascadeFilter: cascadeFilter, currentValue: cascadeCurrentValue, relatedCollection: cascadeRelatedCollection, onClear: handleCascadeClear })), _jsxs("div", { className: 'flex flex-wrap items-center gap-1.5 min-h-[1.5rem]', children: [_jsxs(Label, { className: 'text-sm font-medium', children: [label, field.required && _jsx("span", { className: 'ml-0.5 text-destructive', children: "*" })] }), field.note && (_jsx(TooltipProvider, { delayDuration: 100, children: _jsxs(Tooltip, { children: [_jsx(TooltipTrigger, { asChild: true, children: _jsx(Info, { className: 'h-3.5 w-3.5 shrink-0 cursor-help text-slate-400 hover:text-slate-600' }) }), _jsx(TooltipContent, { side: 'top', className: 'max-w-[240px] text-[12px]', children: field.note })] }) })), locked && _jsx("span", { className: 'text-[10px] text-amber-500 font-medium', children: "(locked)" }), cascadeFilter && Object.keys(cascadeFilter).length > 0 && cascadeParentLabels.length > 0 && (_jsx(TooltipProvider, { delayDuration: 100, children: _jsxs(Tooltip, { children: [_jsx(TooltipTrigger, { asChild: true, children: _jsxs("span", { className: 'inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium bg-[rgba(0,206,255,0.12)] text-[#00ceff] dark:bg-nvr-cyan/15 dark:text-nvr-cyan max-w-[180px] min-w-0', children: [_jsx(SlidersHorizontal, { className: 'h-2.5 w-2.5 shrink-0' }), _jsxs("span", { className: 'truncate', children: ["Filtered by ", cascadeParentLabels.join(', ')] })] }) }), _jsxs(TooltipContent, { side: 'top', className: 'text-[12px]', children: ["Filtered by ", cascadeParentLabels.join(', ')] })] }) }))] }), _jsx("div", { className: cn(locked && 'pointer-events-none opacity-60'), children: renderField ? (renderField({
                    field,
                    value,
                    onChange: (v) => onChange(field.field, v),
                    disabled: locked,
                    collection,
                    itemId,
                    relations,
                    cascadeFilter,
                    unsatisfiedParentLabel,
                    requiredParentLabel
                })) : (_jsx(FieldRenderer, { field: field, value: value, onChange: (v) => onChange(field.field, v), relations: relations, collection: collection, itemId: itemId, cascadeFilter: cascadeFilter, requiredParentLabel: requiredParentLabel })) }), error && (_jsxs("p", { className: 'text-[12px] text-destructive flex items-center gap-1', children: [_jsx(AlertCircle, { className: 'h-3 w-3' }), error] }))] }));
}
// ─── re-export getColSpanClass for GroupSection usage ─────────────────────────
export { getColSpanClass };
//# sourceMappingURL=FieldRow.js.map