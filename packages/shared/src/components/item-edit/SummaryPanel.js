import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useQuery } from '@tanstack/react-query';
import { useNivaroClient } from '../../context';
import { get } from '../../lib/commands';
import { cn, titleCase } from '../../lib/utils';
import { parseJson, SENTINEL_FIELDS, SYSTEM_FIELDS } from './helpers';
import { RelatedItemLabel } from './RelationCombobox';
// ─── M2MSummaryCount ──────────────────────────────────────────────────────────
function M2MSummaryCount({ relation, parentId, allRelations, staging, maxValues }) {
    const client = useNivaroClient();
    const manyField = relation.many_field ?? '';
    const junctionField = relation.junction_field ??
        (() => {
            const other = allRelations.find((r) => r.many_collection === relation.many_collection && r.id !== relation.id);
            return other?.many_field ?? '';
        })();
    const stagingKey = relation.one_field ?? `${relation.many_collection}.${junctionField}`;
    const relatedCollection = allRelations.find((r) => r.many_collection === relation.many_collection &&
        r.many_field === junctionField &&
        r.id !== relation.id)?.one_collection ?? null;
    const { data: junctionItems = [] } = useQuery({
        queryKey: ['m2m-items', relation.many_collection, manyField, parentId],
        queryFn: () => client
            .request(get(`/items/${relation.many_collection}`, {
            filter: JSON.stringify({ [manyField]: { _eq: parentId } }),
            limit: 200,
            fields: `id,${junctionField}`
        }))
            .then((r) => r.data ?? []),
        staleTime: 30_000
    });
    const { data: colMeta } = useQuery({
        queryKey: ['col-meta', relatedCollection],
        queryFn: () => client
            .request(get(`/collections/${relatedCollection}`))
            .then((r) => r.data),
        enabled: !!relatedCollection && maxValues === 1,
        staleTime: 300_000
    });
    const stagedLinks = staging?.getStagedLinks(stagingKey) ?? [];
    const stagedUnlinks = staging?.getStagedUnlinks(stagingKey) ?? new Set();
    const committedItems = junctionItems.filter((i) => !stagedUnlinks.has(i.id));
    const count = committedItems.length + stagedLinks.length;
    if (count === 0)
        return _jsx("span", { className: 'text-slate-300', children: "\u2014" });
    if (maxValues === 1 && relatedCollection) {
        const relatedId = stagedLinks[0] ?? committedItems[0]?.[junctionField];
        if (relatedId != null) {
            return (_jsx(RelatedItemLabel, { collection: relatedCollection, id: relatedId, displayTemplate: colMeta?.display_template }));
        }
    }
    return (_jsxs("span", { className: 'text-slate-800', children: [count, " item", count !== 1 ? 's' : ''] }));
}
// ─── SummaryFieldValue ─────────────────────────────────────────────────────────
function SummaryFieldValue({ field, val, relations, collection, itemId, staging }) {
    const iface = field.interface ?? '';
    const m2mRel = (() => {
        const r = relations.find((rel) => rel.one_collection === collection && rel.one_field === field.field);
        if (!r)
            return null;
        if (r.junction_field)
            return r;
        const companion = relations.find((c) => c.many_collection === r.many_collection && c.id !== r.id);
        return companion ? { ...r, junction_field: companion.many_field } : null;
    })();
    if (m2mRel && itemId && itemId !== 'new') {
        const fieldOpts = parseJson(field.options);
        return (_jsx(M2MSummaryCount, { relation: m2mRel, parentId: itemId, allRelations: relations, staging: staging, maxValues: fieldOpts?.max_values }));
    }
    const isEmpty = val === null || val === undefined || val === '';
    if (isEmpty)
        return _jsx("span", { className: 'text-slate-300', children: "\u2014" });
    if (iface === 'extension-editorjs') {
        try {
            const doc = JSON.parse(String(val));
            const text = (doc.blocks ?? [])
                .map((b) => b.data?.text ?? '')
                .join(' ')
                .trim();
            return _jsx("span", { className: 'text-slate-800 truncate', children: text || '—' });
        }
        catch {
            /* fall through */
        }
    }
    if (iface === 'input-rich-text-html') {
        const div = typeof document !== 'undefined' ? document.createElement('div') : null;
        if (div) {
            div.innerHTML = String(val);
            return _jsx("span", { className: 'text-slate-800 truncate', children: div.textContent || '—' });
        }
    }
    if (typeof val === 'boolean')
        return _jsx("span", { className: 'text-slate-800', children: val ? 'Yes' : 'No' });
    const m2oRel = relations.find((r) => r.many_collection === collection && r.many_field === field.field && !r.junction_field);
    if (m2oRel?.one_collection) {
        return _jsx(RelatedItemLabel, { collection: m2oRel.one_collection, id: val });
    }
    if (field.type === 'datetime' || field.type === 'date') {
        try {
            return _jsx("span", { className: 'text-slate-800', children: new Date(String(val)).toLocaleDateString() });
        }
        catch {
            /* fall through */
        }
    }
    return _jsx("span", { className: 'text-slate-800 truncate', children: String(val) });
}
// ─── SummaryPanel ──────────────────────────────────────────────────────────────
export function SummaryPanel({ allSteps, groupedMap, ungroupedFields, sectionGroups, draft, relations, collection, itemId, staging, onFieldClick }) {
    const stepSections = allSteps
        .map((step) => {
        const fields = (step.key === '__general__'
            ? [...ungroupedFields, ...sectionGroups.flatMap((g) => groupedMap[g.key] ?? [])]
            : (groupedMap[step.key] ?? [])).filter((f) => !f.hidden && !SYSTEM_FIELDS.has(f.field) && !SENTINEL_FIELDS.has(f.field));
        return { step, fields };
    })
        .filter((s) => s.fields.length > 0);
    if (stepSections.length === 0)
        return null;
    return (_jsxs("div", { className: 'bg-white overflow-hidden', children: [_jsx("div", { className: 'px-4 py-2.5 border-b border-slate-100', children: _jsx("p", { className: 'text-[11px] font-semibold uppercase tracking-wider text-slate-500', children: "Summary" }) }), stepSections.map(({ step, fields }, si) => (_jsxs("div", { children: [si > 0 && _jsx("div", { className: 'border-t border-slate-200' }), _jsx("div", { className: 'px-4 py-1.5 bg-slate-50 border-b border-slate-100', children: _jsx("span", { className: 'text-[10px] font-semibold uppercase tracking-wider text-slate-400', children: step.label }) }), fields.map((f, fi) => {
                        const val = draft[f.field];
                        const label = f.label ?? titleCase(f.field);
                        return (_jsxs("button", { type: 'button', onClick: () => onFieldClick(step.key, f.field), className: cn('flex w-full flex-col px-4 py-2 text-left hover:bg-slate-50 transition-colors', fi < fields.length - 1 && 'border-b border-slate-50'), children: [_jsx("span", { className: 'text-[10px] font-medium text-slate-400 truncate', children: label }), _jsx("span", { className: 'mt-0.5 w-full text-[12px] min-w-0 overflow-hidden', children: _jsx(SummaryFieldValue, { field: f, val: val, relations: relations, collection: collection, itemId: itemId, staging: staging }) })] }, f.field));
                    })] }, step.key)))] }));
}
//# sourceMappingURL=SummaryPanel.js.map