import { jsxs as _jsxs, jsx as _jsx } from "react/jsx-runtime";
import { useQuery } from '@tanstack/react-query';
import { Check, ChevronDown, Loader2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useNivaroClient } from '../../context';
import { get } from '../../lib/commands';
import { cn } from '../../lib/utils';
import { applyDisplayTemplate } from './helpers';
// ─── RelationCombobox (M2O) ────────────────────────────────────────────────────
export function RelationCombobox({ collection, value, onChange, disabled, placeholder, extraFilter, requiredParent }) {
    const client = useNivaroClient();
    const [open, setOpen] = useState(false);
    const [query, setQuery] = useState('');
    const inputRef = useRef(null);
    const rootRef = useRef(null);
    useEffect(() => {
        if (open)
            setTimeout(() => inputRef.current?.focus(), 30);
        else
            setQuery('');
    }, [open]);
    useEffect(() => {
        if (!open)
            return;
        const handler = (e) => {
            if (rootRef.current && !rootRef.current.contains(e.target)) {
                setOpen(false);
            }
        };
        document.addEventListener('mousedown', handler);
        return () => document.removeEventListener('mousedown', handler);
    }, [open]);
    const { data: colMeta } = useQuery({
        queryKey: ['col-meta', collection],
        queryFn: () => client
            .request(get(`/collections/${collection}`))
            .then((r) => r.data),
        staleTime: 300_000,
        retry: false
    });
    const filterStr = extraFilter ? JSON.stringify(extraFilter) : undefined;
    const { data, isFetching: isLoadingOptions } = useQuery({
        queryKey: ['relation-opts', collection, query, filterStr],
        queryFn: () => client
            .request(get(`/items/${collection}`, {
            limit: 200,
            ...(query ? { search: query } : {}),
            ...(filterStr ? { filter: filterStr } : {})
        }))
            .then((r) => (r.data ?? [])),
        enabled: open,
        staleTime: filterStr ? 0 : 30_000
    });
    const { data: selected, isLoading: isLoadingSelected } = useQuery({
        queryKey: ['relation-single', collection, String(value)],
        queryFn: () => client.request(get(`/items/${collection}/${value}`)).then((r) => r.data),
        enabled: !!value,
        staleTime: 60_000
    });
    const tmpl = colMeta?.display_template;
    const selectedLabel = selected ? applyDisplayTemplate(tmpl, selected) : null;
    const showLoader = !!value && isLoadingSelected && !selected;
    if (requiredParent) {
        return (_jsxs("button", { type: 'button', disabled: true, className: 'flex h-9 w-full items-center justify-between gap-2 rounded-md border border-input bg-background px-3 text-sm text-left opacity-50 cursor-not-allowed', children: [_jsxs("span", { className: 'truncate text-muted-foreground', children: ["Select ", requiredParent, " first"] }), _jsx(ChevronDown, { className: 'h-4 w-4 shrink-0 opacity-50' })] }));
    }
    return (_jsxs("div", { ref: rootRef, className: 'relative', children: [_jsxs("button", { type: 'button', disabled: disabled, onClick: () => setOpen((v) => !v), className: 'flex h-9 w-full items-center justify-between gap-2 rounded-md border border-input bg-background px-3 text-sm text-left hover:bg-accent disabled:opacity-50', children: [showLoader ? (_jsx(Loader2, { className: 'h-3.5 w-3.5 animate-spin text-muted-foreground' })) : (_jsx("span", { className: cn('truncate', !selectedLabel && 'text-muted-foreground'), children: selectedLabel ?? placeholder ?? 'Select…' })), _jsx(ChevronDown, { className: 'h-4 w-4 shrink-0 opacity-50' })] }), !!value && !disabled && (_jsx("button", { type: 'button', onClick: () => onChange(null), className: 'absolute right-8 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground p-0.5 rounded', children: _jsx("span", { className: 'text-xs', children: "\u00D7" }) })), open && (_jsxs("div", { className: 'absolute z-50 mt-1 w-full rounded-md border border-border bg-popover shadow-md', children: [_jsx("div", { className: 'border-b p-1.5', children: _jsx("input", { ref: inputRef, value: query, onChange: (e) => setQuery(e.target.value), placeholder: 'Search\u2026', className: 'w-full rounded px-2 py-1 text-sm bg-muted/40 focus:outline-none' }) }), _jsx("div", { className: 'max-h-52 overflow-y-auto py-1', children: isLoadingOptions ? (_jsx("div", { className: 'flex items-center justify-center py-4', children: _jsx(Loader2, { className: 'h-4 w-4 animate-spin text-muted-foreground' }) })) : (data ?? []).length === 0 ? (_jsx("p", { className: 'px-3 py-2 text-sm text-muted-foreground', children: "No results" })) : ([...(data ?? [])]
                            .sort((a, b) => applyDisplayTemplate(tmpl, a).localeCompare(applyDisplayTemplate(tmpl, b)))
                            .map((item) => {
                            const label = applyDisplayTemplate(tmpl, item);
                            const sel = String(item.id) === String(value);
                            return (_jsxs("button", { type: 'button', onClick: () => {
                                    onChange(item.id);
                                    setOpen(false);
                                }, className: cn('flex w-full items-center gap-2 px-3 py-1.5 text-sm hover:bg-accent', sel && 'font-medium'), children: [_jsx(Check, { className: cn('h-3.5 w-3.5', sel ? 'text-primary' : 'opacity-0') }), label] }, String(item.id)));
                        })) })] }))] }));
}
// ─── RelatedItemLabel ──────────────────────────────────────────────────────────
export function RelatedItemLabel({ collection, id, displayTemplate }) {
    const client = useNivaroClient();
    const { data, isLoading } = useQuery({
        queryKey: ['relation-single', collection, String(id)],
        queryFn: () => client
            .request(get(`/items/${collection}/${id}`))
            .then((r) => r.data),
        enabled: !!id && !!collection,
        staleTime: 60_000
    });
    if (isLoading)
        return _jsx(Loader2, { className: 'h-3 w-3 animate-spin text-slate-400' });
    return _jsx("span", { children: data ? applyDisplayTemplate(displayTemplate, data) : String(id ?? '') });
}
//# sourceMappingURL=RelationCombobox.js.map