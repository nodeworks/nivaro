import { useEffect, useRef, useState } from 'react';
import { get } from '../lib/commands';
function renderLabel(row, template, idValue) {
    if (template) {
        let any = false;
        const out = template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_m, path) => {
            let val = resolvePath(row, path);
            if ((val == null || val === '') && path.includes('.')) {
                val = resolvePath(row, path.split('.').pop());
            }
            if (val != null && val !== '') {
                any = true;
                return String(val);
            }
            return '';
        });
        const trimmed = out.replace(/\s+/g, ' ').trim();
        if (any && trimmed)
            return trimmed;
    }
    for (const key of ['name', 'title', 'label', 'display_name']) {
        const v = row[key];
        if (typeof v === 'string' && v.trim())
            return v;
    }
    const skip = new Set(['id', 'uuid', '_id', 'created', 'changed', 'updated', 'deleted']);
    for (const [k, v] of Object.entries(row)) {
        if (skip.has(k) || k.endsWith('_at') || k.endsWith('_id') || k === 'machine_name')
            continue;
        if (typeof v === 'string' && v.trim() && !/^[a-z0-9_-]+$/.test(v))
            return v;
    }
    return String(idValue ?? '');
}
function resolvePath(obj, path) {
    return path.split('.').reduce((acc, seg) => {
        if (acc && typeof acc === 'object')
            return acc[seg];
        return undefined;
    }, obj);
}
function pickId(row) {
    const id = row.id ?? row.uuid ?? row._id;
    if (typeof id === 'string' || typeof id === 'number')
        return id;
    return String(id ?? '');
}
export function useRelationOptions(client, relatedCollection, options) {
    const { search, limit = 50, displayTemplate = null, enabled = true, filter } = options ?? {};
    const [opts, setOpts] = useState([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);
    const reqIdRef = useRef(0);
    useEffect(() => {
        if (!client || !relatedCollection || !enabled) {
            setLoading(false);
            return;
        }
        const reqId = ++reqIdRef.current;
        let active = true;
        setLoading(true);
        setError(null);
        const params = { limit };
        if (search)
            params.search = search;
        if (filter)
            params.filter = JSON.stringify(filter);
        client
            .request(get(`/items/${relatedCollection}`, params))
            .then((res) => {
            if (!active || reqId !== reqIdRef.current)
                return;
            const rows = res.data ?? [];
            setOpts(rows
                .map((row) => {
                const id = pickId(row);
                return { id, label: renderLabel(row, displayTemplate, id), raw: row };
            })
                .sort((a, b) => a.label.localeCompare(b.label)));
            setLoading(false);
        })
            .catch((err) => {
            if (!active || reqId !== reqIdRef.current)
                return;
            setError(err instanceof Error ? err : new Error(String(err)));
            setLoading(false);
        });
        return () => {
            active = false;
        };
    }, [client, relatedCollection, search, limit, displayTemplate, enabled, filter]);
    return { options: opts, loading, error };
}
//# sourceMappingURL=useRelationOptions.js.map