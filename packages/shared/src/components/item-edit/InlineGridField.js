import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronRight, Loader2, X } from 'lucide-react';
import { useState } from 'react';
import { useNivaroClient } from '../../context';
import { del, get, patch, post } from '../../lib/commands';
import { cn, titleCase } from '../../lib/utils';
const NON_DISPLAY_TYPES = new Set([
    'alias',
    'o2m',
    'm2m',
    'm2a',
    'presentation',
    'group',
    'divider'
]);
export function InlineGridField({ relatedCollection, manyField, parentId }) {
    const client = useNivaroClient();
    const qc = useQueryClient();
    const [editingId, setEditingId] = useState(null);
    const [editDraft, setEditDraft] = useState({});
    const [addingNew, setAddingNew] = useState(false);
    const [newDraft, setNewDraft] = useState({});
    const [saving, setSaving] = useState(false);
    const { data: cols = [] } = useQuery({
        queryKey: ['field-config', relatedCollection],
        queryFn: () => client
            .request(get(`/field-config/${relatedCollection}`))
            .then((r) => r.data ?? []),
        staleTime: 60_000
    });
    const { data: rows = [], isLoading } = useQuery({
        queryKey: ['o2m-rows', relatedCollection, manyField, parentId],
        queryFn: () => client
            .request(get(`/items/${relatedCollection}`, {
            filter: JSON.stringify({ [manyField]: { _eq: parentId } }),
            limit: 200
        }))
            .then((r) => r.data ?? []),
        staleTime: 30_000
    });
    const displayCols = cols.filter((c) => !c.hidden && !NON_DISPLAY_TYPES.has(c.type) && c.field !== manyField && c.field !== 'id');
    async function saveEdit(id) {
        setSaving(true);
        try {
            await client.request(patch(`/items/${relatedCollection}/${id}`, editDraft));
            qc.invalidateQueries({ queryKey: ['o2m-rows', relatedCollection, manyField, parentId] });
            setEditingId(null);
        }
        catch {
            /* ignore */
        }
        finally {
            setSaving(false);
        }
    }
    async function saveNew() {
        setSaving(true);
        try {
            await client.request(post(`/items/${relatedCollection}`, { ...newDraft, [manyField]: parentId }));
            qc.invalidateQueries({ queryKey: ['o2m-rows', relatedCollection, manyField, parentId] });
            setAddingNew(false);
            setNewDraft({});
        }
        catch {
            /* ignore */
        }
        finally {
            setSaving(false);
        }
    }
    async function deleteRow(id) {
        try {
            await client.request(del(`/items/${relatedCollection}/${id}`));
            qc.invalidateQueries({ queryKey: ['o2m-rows', relatedCollection, manyField, parentId] });
        }
        catch {
            /* ignore */
        }
    }
    function renderCell(col, val) {
        if (val === null || val === undefined)
            return _jsx("span", { className: 'text-slate-300', children: "\u2014" });
        if (col.type === 'boolean')
            return (_jsx("span", { className: val ? 'text-emerald-600' : 'text-slate-400', children: val ? 'Yes' : 'No' }));
        if (col.type === 'datetime' || col.type === 'date') {
            try {
                return _jsx("span", { children: new Date(String(val)).toLocaleDateString() });
            }
            catch {
                /* fall */
            }
        }
        return _jsx("span", { className: 'truncate', children: String(val) });
    }
    function renderEditCell(col, draft, set) {
        const v = draft[col.field] ?? '';
        if (col.type === 'boolean')
            return (_jsx("input", { type: 'checkbox', checked: Boolean(v), onChange: (e) => set(col.field, e.target.checked), className: 'h-4 w-4' }));
        if (col.type === 'integer' ||
            col.type === 'bigInteger' ||
            col.type === 'float' ||
            col.type === 'decimal') {
            return (_jsx("input", { type: 'number', value: String(v), onChange: (e) => set(col.field, e.target.value === '' ? null : Number(e.target.value)), className: 'w-full rounded border border-slate-200 px-1.5 py-0.5 text-[12px] focus:outline-none focus:border-[#00ceff]' }));
        }
        if (col.type === 'date')
            return (_jsx("input", { type: 'date', value: String(v).slice(0, 10), onChange: (e) => set(col.field, e.target.value || null), className: 'w-full rounded border border-slate-200 px-1.5 py-0.5 text-[12px] focus:outline-none focus:border-[#00ceff]' }));
        if (col.type === 'datetime')
            return (_jsx("input", { type: 'datetime-local', value: String(v).slice(0, 16), onChange: (e) => set(col.field, e.target.value ? new Date(e.target.value).toISOString() : null), className: 'w-full rounded border border-slate-200 px-1.5 py-0.5 text-[12px] focus:outline-none focus:border-[#00ceff]' }));
        return (_jsx("input", { type: 'text', value: String(v), onChange: (e) => set(col.field, e.target.value), className: 'w-full rounded border border-slate-200 px-1.5 py-0.5 text-[12px] focus:outline-none focus:border-[#00ceff]' }));
    }
    if (isLoading)
        return (_jsx("div", { className: 'py-3 text-center text-[12px] text-slate-400', children: _jsx(Loader2, { className: 'h-4 w-4 animate-spin inline' }) }));
    return (_jsxs("div", { className: 'rounded-lg border border-slate-200 overflow-hidden text-[12px]', children: [_jsxs("table", { className: 'w-full', children: [_jsx("thead", { className: 'bg-slate-50 border-b border-slate-200', children: _jsxs("tr", { children: [displayCols.map((c) => (_jsx("th", { className: 'px-3 py-2 text-left font-medium text-slate-500 text-[11px]', children: c.label ?? titleCase(c.field) }, c.field))), _jsx("th", { className: 'w-16' })] }) }), _jsxs("tbody", { children: [rows.map((row, ri) => {
                                const id = String(row.id);
                                const isEditing = editingId === id;
                                return (_jsxs("tr", { className: cn('border-b border-slate-100', ri % 2 === 0 ? 'bg-white' : 'bg-slate-50/50'), children: [displayCols.map((c) => (_jsx("td", { className: 'px-3 py-1.5', children: isEditing
                                                ? renderEditCell(c, editDraft, (k, v) => setEditDraft((d) => ({ ...d, [k]: v })))
                                                : renderCell(c, row[c.field]) }, c.field))), _jsx("td", { className: 'px-2 py-1.5', children: _jsx("div", { className: 'flex items-center gap-1 justify-end', children: isEditing ? (_jsxs(_Fragment, { children: [_jsx("button", { type: 'button', disabled: saving, onClick: () => saveEdit(id), className: 'rounded px-1.5 py-0.5 bg-[#00ceff] text-white text-[11px] font-medium hover:brightness-110 disabled:opacity-50', children: saving ? '…' : 'Save' }), _jsx("button", { type: 'button', onClick: () => setEditingId(null), className: 'rounded px-1.5 py-0.5 text-slate-400 hover:text-slate-700 text-[11px]', children: "Cancel" })] })) : (_jsxs(_Fragment, { children: [_jsx("button", { type: 'button', onClick: () => {
                                                                setEditingId(id);
                                                                setEditDraft({ ...row });
                                                            }, className: 'rounded p-0.5 text-slate-400 hover:text-slate-700', children: _jsx(ChevronRight, { className: 'h-3.5 w-3.5' }) }), _jsx("button", { type: 'button', onClick: () => deleteRow(row.id), className: 'rounded p-0.5 text-slate-400 hover:text-red-500', children: _jsx(X, { className: 'h-3 w-3' }) })] })) }) })] }, id));
                            }), addingNew && (_jsxs("tr", { className: 'border-b border-slate-100 bg-nvr-cyan/5', children: [displayCols.map((c) => (_jsx("td", { className: 'px-3 py-1.5', children: renderEditCell(c, newDraft, (k, v) => setNewDraft((d) => ({ ...d, [k]: v }))) }, c.field))), _jsx("td", { className: 'px-2 py-1.5', children: _jsxs("div", { className: 'flex items-center gap-1 justify-end', children: [_jsx("button", { type: 'button', disabled: saving, onClick: saveNew, className: 'rounded px-1.5 py-0.5 bg-[#00ceff] text-white text-[11px] font-medium hover:brightness-110 disabled:opacity-50', children: saving ? '…' : 'Add' }), _jsx("button", { type: 'button', onClick: () => {
                                                        setAddingNew(false);
                                                        setNewDraft({});
                                                    }, className: 'rounded px-1.5 py-0.5 text-slate-400 hover:text-slate-700 text-[11px]', children: "Cancel" })] }) })] })), rows.length === 0 && !addingNew && (_jsx("tr", { children: _jsx("td", { colSpan: displayCols.length + 1, className: 'px-3 py-4 text-center text-slate-400', children: "No rows" }) }))] })] }), !addingNew && (_jsx("div", { className: 'border-t border-slate-100 px-3 py-1.5', children: _jsx("button", { type: 'button', onClick: () => setAddingNew(true), className: 'text-[11px] font-medium text-[#00ceff] hover:underline', children: "+ Add row" }) }))] }));
}
//# sourceMappingURL=InlineGridField.js.map