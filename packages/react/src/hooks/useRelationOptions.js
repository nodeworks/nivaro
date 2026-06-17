import { useEffect, useRef, useState } from 'react';
import { get } from '../lib/commands';
/**
 * Render a display template like "{{first_name}} {{last_name}}" against a row.
 * Falls back to the row id (as string) when no template / no fields resolve.
 */
function renderLabel(row, template, idValue) {
    if (template) {
        let any = false;
        const out = template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_m, path) => {
            let val = resolvePath(row, path);
            // Junction-prefixed templates like {{divisions_id.short_name}} won't resolve
            // on the target collection rows — fall back to just the last path segment.
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
    // Common label fallbacks before resorting to the id.
    for (const key of ['name', 'title', 'label', 'display_name']) {
        const v = row[key];
        if (typeof v === 'string' && v.trim())
            return v;
    }
    // Last resort: first string field that looks like a human label (not id/slug/date).
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
/**
 * Fetch selectable options for a relation field's related collection.
 * Re-fetches when `search` changes. Pass `enabled: false` to skip fetching
 * (e.g. while the related collection name is still unknown).
 *
 * When `enabled` transitions to false, previously-loaded options are retained
 * so cascading pickers don't flash blank while a parent field is being cleared.
 */
export function useRelationOptions(client, relatedCollection, options) {
    const { search, limit = 50, displayTemplate = null, enabled = true, filter } = options ?? {};
    const [opts, setOpts] = useState([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);
    const reqIdRef = useRef(0);
    useEffect(() => {
        if (!client || !relatedCollection || !enabled) {
            // Do NOT clear opts when disabled — retains previously-loaded list so
            // cascade pickers don't flash blank when a parent value is being cleared.
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