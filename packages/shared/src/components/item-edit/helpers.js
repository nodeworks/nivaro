import { useEffect, useRef } from 'react';
import { useNivaroClient } from '../../context';
import { get } from '../../lib/commands';
// ─── Display template ──────────────────────────────────────────────────────────
export function applyDisplayTemplate(template, item) {
    if (!template)
        return String(item.name ?? item.title ?? item.label ?? item.type ?? item.description ?? item.id ?? '');
    return template.replace(/\{\{([^}]+)\}\}/g, (_, k) => String(item[k.trim()] ?? ''));
}
// ─── JSON parsing ──────────────────────────────────────────────────────────────
export function parseJson(v) {
    if (v === null || v === undefined)
        return null;
    if (typeof v === 'object')
        return v;
    if (typeof v !== 'string')
        return null;
    try {
        return JSON.parse(v);
    }
    catch {
        return null;
    }
}
export function getCascadeFilters(depConfig) {
    const parsed = parseJson(depConfig);
    return Array.isArray(parsed?.cascade_filters) ? parsed.cascade_filters : [];
}
// ─── CascadeEffectController ───────────────────────────────────────────────────
export function CascadeEffectController({ cascadeRules, cascadeFilter, currentValue, relatedCollection, onClear }) {
    const client = useNivaroClient();
    const cascadeFilterStr = JSON.stringify(cascadeFilter);
    const prevFilterRef = useRef(undefined);
    const onClearRef = useRef(onClear);
    onClearRef.current = onClear;
    useEffect(() => {
        const prev = prevFilterRef.current;
        prevFilterRef.current = cascadeFilterStr;
        if (prev === undefined)
            return;
        if (prev === cascadeFilterStr)
            return;
        if (cascadeRules.some((r) => r.clear_on_parent_change))
            onClearRef.current();
    }, [cascadeFilterStr, cascadeRules]);
    useEffect(() => {
        if (!cascadeFilter || Object.keys(cascadeFilter).length === 0)
            return;
        if (!cascadeRules.some((r) => r.clear_on_unavailable))
            return;
        if (currentValue == null || !relatedCollection)
            return;
        client
            .request(get(`/items/${relatedCollection}`, {
            filter: JSON.stringify({ ...cascadeFilter, id: { _eq: currentValue } }),
            limit: 1,
            fields: 'id'
        }))
            .then((r) => {
            if ((r.data ?? []).length === 0)
                onClearRef.current();
        })
            .catch(() => { });
    }, [cascadeFilter, cascadeRules, client, currentValue, relatedCollection]);
    return null;
}
// ─── Column span ───────────────────────────────────────────────────────────────
export const COL_SPAN_CLASS = {
    3: 'col-span-12 sm:col-span-3',
    4: 'col-span-12 sm:col-span-4',
    6: 'col-span-12 sm:col-span-6',
    12: 'col-span-12'
};
export function getColSpanClass(options) {
    const parsed = parseJson(options);
    return COL_SPAN_CLASS[parsed?.col_span ?? 0] ?? 'col-span-12';
}
// ─── Date/time helpers ─────────────────────────────────────────────────────────
export function toLocalDatetime(value) {
    if (!value)
        return '';
    try {
        return new Date(String(value)).toISOString().slice(0, 16);
    }
    catch {
        return '';
    }
}
// ─── Constants ─────────────────────────────────────────────────────────────────
export const SYSTEM_FIELDS = new Set([
    'id',
    'date_created',
    'date_updated',
    'user_created',
    'user_updated'
]);
export const SENTINEL_FIELDS = new Set(['__pipeline__', '__comments__', '__tasks__']);
//# sourceMappingURL=helpers.js.map