import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useCallback, useEffect, useRef, useState } from 'react';
import { useGridFlush, useOptionalNivaroClient } from '../context';
import { del, get, patch, post } from '../lib/commands';
function titleCase(s) {
    return s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}
export function InlineGridField({ field, itemId }) {
    const client = useOptionalNivaroClient();
    const gridFlush = useGridFlush();
    const rel = field.relation;
    const relCol = rel?.relatedCollection ?? '';
    const manyField = rel?.manyField ?? '';
    const [columns, setColumns] = useState([]);
    const [rows, setRows] = useState([]);
    const [stagedEdits, setStagedEdits] = useState(new Map());
    const [stagedNew, setStagedNew] = useState([]);
    const [stagedDeletes, setStagedDeletes] = useState(new Set());
    const mountedRef = useRef(true);
    useEffect(() => {
        mountedRef.current = true;
        return () => {
            mountedRef.current = false;
        };
    }, []);
    const hasPending = stagedEdits.size > 0 || stagedNew.length > 0 || stagedDeletes.size > 0;
    const fetchRows = useCallback(async () => {
        if (!client || !itemId || !relCol || !manyField)
            return;
        try {
            const res = await client.request(get(`/items/${relCol}`, {
                filter: JSON.stringify({ [manyField]: { _eq: itemId } }),
                limit: 200,
                fields: '*'
            }));
            if (mountedRef.current)
                setRows(res.data ?? []);
        }
        catch {
            if (mountedRef.current)
                setRows([]);
        }
    }, [client, itemId, relCol, manyField]);
    useEffect(() => {
        if (!client || !relCol)
            return;
        client
            .request(get(`/field-config/${relCol}`))
            .then((res) => {
            if (!mountedRef.current)
                return;
            const cols = (res.data ?? []).filter((c) => !c.field.startsWith('_') && c.field !== 'id' && c.field !== manyField);
            setColumns(cols);
        })
            .catch(() => { });
    }, [client, relCol, manyField]);
    useEffect(() => {
        void fetchRows();
    }, [fetchRows]);
    const flush = useCallback(async () => {
        if (!client)
            return;
        for (const id of stagedDeletes) {
            await client.request(del(`/items/${relCol}/${id}`));
        }
        for (const row of stagedNew) {
            await client.request(post(`/items/${relCol}`, { ...row, [manyField]: itemId }));
        }
        for (const [id, changes] of stagedEdits) {
            if (!stagedDeletes.has(id))
                await client.request(patch(`/items/${relCol}/${id}`, changes));
        }
        if (mountedRef.current) {
            setStagedEdits(new Map());
            setStagedNew([]);
            setStagedDeletes(new Set());
            await fetchRows();
        }
    }, [client, relCol, manyField, itemId, stagedDeletes, stagedNew, stagedEdits, fetchRows]);
    const flushKey = `inline-grid:${relCol}:${manyField}`;
    useEffect(() => {
        gridFlush?.register(flushKey, flush);
        return () => gridFlush?.unregister(flushKey);
    }, [gridFlush, flushKey, flush]);
    function getVal(row, f, isNew, ni) {
        if (isNew)
            return stagedNew[ni]?.[f] ?? '';
        return stagedEdits.get(String(row.id))?.[f] ?? row[f] ?? '';
    }
    function setVal(row, f, value, isNew, ni) {
        if (isNew) {
            setStagedNew((p) => p.map((r, i) => (i === ni ? { ...r, [f]: value } : r)));
            return;
        }
        const id = String(row.id);
        setStagedEdits((p) => {
            const n = new Map(p);
            n.set(id, { ...(n.get(id) ?? {}), [f]: value });
            return n;
        });
    }
    function renderCell(col, row, isNew, ni) {
        const val = getVal(row, col.field, isNew, ni);
        const set = (v) => setVal(row, col.field, v, isNew, ni);
        const isNum = ['integer', 'bigInteger', 'float', 'decimal', 'numeric'].includes(col.type);
        if (col.type === 'boolean') {
            return (_jsx("input", { type: 'checkbox', checked: !!val, onChange: (e) => set(e.target.checked), "data-nf-grid-cell-checkbox": true }));
        }
        if (isNum) {
            return (_jsx("input", { type: 'number', value: val === null || val === undefined ? '' : String(val), onChange: (e) => set(e.target.value === '' ? null : Number(e.target.value)), placeholder: col.note ?? undefined, "data-nf-grid-cell": true }));
        }
        if (col.type === 'datetime' || col.interface === 'datetime') {
            return (_jsx("input", { type: 'datetime-local', value: val ? String(val).slice(0, 16) : '', onChange: (e) => set(e.target.value ? new Date(e.target.value).toISOString() : null), "data-nf-grid-cell": true }));
        }
        return (_jsx("input", { type: 'text', value: val === null || val === undefined ? '' : String(val), onChange: (e) => set(e.target.value || null), placeholder: col.note ?? undefined, "data-nf-grid-cell": true }));
    }
    if (!itemId) {
        return (_jsx("div", { "data-nf-inline-grid": true, "data-nf-inline-grid-empty": true, children: _jsx("p", { "data-nf-empty": true, children: "Save the record first to manage related rows." }) }));
    }
    const visibleRows = rows.filter((r) => !stagedDeletes.has(String(r.id)));
    const allRows = [
        ...visibleRows.map((r) => ({ ...r, ...(stagedEdits.get(String(r.id)) ?? {}) })),
        ...stagedNew
    ];
    const numericCols = columns.filter((c) => ['integer', 'bigInteger', 'float', 'decimal', 'numeric'].includes(c.type));
    return (_jsxs("div", { "data-nf-inline-grid": true, children: [_jsxs("span", { "data-nf-inline-grid-label": true, children: [field.label ?? titleCase(field.field), field.note ? (_jsxs("span", { "data-nf-inline-grid-note": true, title: field.note, children: [' ', "?"] })) : null] }), hasPending && (_jsx("div", { "data-nf-inline-grid-pending": true, children: "Unsaved changes \u2014 will save with the record" })), _jsxs("div", { "data-nf-inline-grid-wrap": true, children: [_jsx("div", { "data-nf-inline-grid-scroll": true, children: _jsxs("table", { "data-nf-inline-grid-table": true, children: [_jsx("thead", { children: _jsxs("tr", { children: [columns.map((col) => (_jsx("th", { "data-nf-grid-th": true, children: col.label ?? titleCase(col.field) }, col.field))), _jsx("th", { "data-nf-grid-th-action": true })] }) }), _jsxs("tbody", { children: [visibleRows.map((row) => (_jsxs("tr", { "data-nf-grid-row": true, children: [columns.map((col) => (_jsx("td", { "data-nf-grid-td": true, children: renderCell(col, row, false, -1) }, col.field))), _jsx("td", { "data-nf-grid-td-action": true, children: _jsx("button", { type: 'button', "data-nf-grid-delete": true, "aria-label": 'Delete row', onClick: () => setStagedDeletes((p) => {
                                                            const n = new Set(p);
                                                            n.add(String(row.id));
                                                            return n;
                                                        }), children: "\u00D7" }) })] }, String(row.id)))), stagedNew.map((row, idx) => (_jsxs("tr", { "data-nf-grid-row": true, "data-nf-grid-row-new": true, children: [columns.map((col) => (_jsx("td", { "data-nf-grid-td": true, children: renderCell(col, row, true, idx) }, col.field))), _jsx("td", { "data-nf-grid-td-action": true, children: _jsx("button", { type: 'button', "data-nf-grid-delete": true, "aria-label": 'Remove new row', onClick: () => setStagedNew((p) => p.filter((_, i) => i !== idx)), children: "\u00D7" }) })] }, row._rowId ?? `new-${idx}`))), allRows.length === 0 && (_jsx("tr", { children: _jsx("td", { colSpan: columns.length + 1, "data-nf-grid-empty-row": true, children: "No rows yet" }) }))] }), numericCols.length > 0 && allRows.length > 0 && (_jsx("tfoot", { children: _jsxs("tr", { "data-nf-grid-totals": true, children: [columns.map((col) => {
                                                const isNum = numericCols.some((c) => c.field === col.field);
                                                if (!isNum)
                                                    return _jsx("td", { "data-nf-grid-total-cell": true }, col.field);
                                                const sum = allRows.reduce((a, r) => a + (Number(r[col.field]) || 0), 0);
                                                return (_jsx("td", { "data-nf-grid-total-cell": true, "data-nf-grid-total-num": true, children: sum.toLocaleString(undefined, {
                                                        minimumFractionDigits: 2,
                                                        maximumFractionDigits: 2
                                                    }) }, col.field));
                                            }), _jsx("td", { "data-nf-grid-total-cell": true })] }) }))] }) }), _jsx("div", { "data-nf-inline-grid-footer": true, children: _jsx("button", { type: 'button', "data-nf-grid-add": true, onClick: () => setStagedNew((p) => [...p, { _rowId: crypto.randomUUID() }]), children: "+ Add row" }) })] })] }));
}
//# sourceMappingURL=InlineGridField.js.map