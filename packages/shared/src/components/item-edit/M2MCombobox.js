import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useQuery } from '@tanstack/react-query';
import { Check, ChevronsUpDown, Loader2, X } from 'lucide-react';
import { useState } from 'react';
import { useNivaroClient } from '../../context';
import { get } from '../../lib/commands';
import { cn } from '../../lib/utils';
import { Button } from '../ui/button';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '../ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover';
import { useM2MStaging } from './M2MStagingContext';
import { RelatedItemLabel } from './RelationCombobox';
// ─── M2MCombobox (multi-select) ────────────────────────────────────────────────
export function M2MCombobox({ relation, parentId, allRelations, extraFilter, requiredParent }) {
    const client = useNivaroClient();
    const staging = useM2MStaging();
    const [open, setOpen] = useState(false);
    const [search, setSearch] = useState('');
    const otherRel = allRelations.find((r) => r.many_collection === relation.many_collection &&
        r.many_field === relation.junction_field &&
        r.id !== relation.id);
    const relatedCollection = otherRel?.one_collection ?? null;
    const junctionField = relation.junction_field ?? '';
    const manyField = relation.many_field ?? '';
    const stagingKey = relation.one_field ?? `${relation.many_collection}.${junctionField}`;
    const { data: colMeta } = useQuery({
        queryKey: ['col-meta', relatedCollection],
        queryFn: () => client
            .request(get(`/collections/${relatedCollection}`))
            .then((r) => r.data),
        enabled: !!relatedCollection,
        staleTime: 300_000,
        retry: false
    });
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
    const filterParam = extraFilter ? JSON.stringify(extraFilter) : undefined;
    const { data: options = [], isFetching: isLoadingOptions } = useQuery({
        queryKey: ['m2m-options', relatedCollection, search, filterParam],
        queryFn: () => client
            .request(get(`/items/${relatedCollection}`, {
            limit: 200,
            search: search || undefined,
            filter: filterParam,
            picker: '1'
        }))
            .then((r) => r.data ?? []),
        enabled: open && !!relatedCollection,
        staleTime: filterParam ? 0 : 30_000
    });
    const stagedLinks = staging?.getStagedLinks(stagingKey) ?? [];
    const stagedUnlinks = staging?.getStagedUnlinks(stagingKey) ?? new Set();
    const committedItems = junctionItems.filter((i) => !stagedUnlinks.has(i.id));
    const committedIds = new Set(committedItems.map((i) => String(i[junctionField])));
    const stagedLinkIds = new Set(stagedLinks.map(String));
    const allSelectedIds = new Set([...committedIds, ...stagedLinkIds]);
    function handleToggle(optId) {
        const strId = String(optId);
        if (stagedLinkIds.has(strId)) {
            staging?.unstageLink(stagingKey, optId);
            return;
        }
        const existing = junctionItems.find((i) => String(i[junctionField]) === strId);
        if (existing) {
            if (stagedUnlinks.has(existing.id))
                staging?.unstageUnlink(stagingKey, existing.id);
            else
                staging?.stageUnlink(stagingKey, existing.id);
            return;
        }
        staging?.stageLink(stagingKey, optId);
    }
    function getLabel(item) {
        const tmpl = colMeta?.display_template ?? null;
        if (!tmpl)
            return String(item._display ?? item.id ?? '');
        return tmpl.replace(/\{\{([^}]+)\}\}/g, (_, k) => String(item[k.trim()] ?? ''));
    }
    if (requiredParent) {
        return (_jsxs("button", { type: 'button', disabled: true, className: 'flex h-8 w-full items-center gap-1.5 rounded-md border border-input bg-background px-3 text-[13px] text-muted-foreground opacity-50 cursor-not-allowed', children: [_jsx(ChevronsUpDown, { className: 'h-3.5 w-3.5 shrink-0 opacity-50' }), "Select ", requiredParent, " first"] }));
    }
    return (_jsxs("div", { className: 'space-y-1.5', children: [allSelectedIds.size > 0 && (_jsxs("div", { className: 'flex flex-wrap gap-1.5', children: [committedItems.map((ji) => {
                        const relId = ji[junctionField];
                        return (_jsxs("span", { className: 'inline-flex items-center gap-1 rounded-full border border-slate-200 bg-slate-50 pl-2.5 pr-1.5 py-0.5 text-[12px] text-slate-700', children: [relatedCollection && (_jsx(RelatedItemLabel, { collection: relatedCollection, id: relId, displayTemplate: colMeta?.display_template })), _jsx("button", { type: 'button', onClick: () => staging?.stageUnlink(stagingKey, ji.id), className: 'rounded-full p-0.5 text-slate-400 hover:text-red-500', children: _jsx(X, { className: 'h-3 w-3' }) })] }, String(ji.id)));
                    }), stagedLinks.map((relId) => (_jsxs("span", { className: 'inline-flex items-center gap-1 rounded-full border border-dashed border-nvr-cyan/50 bg-nvr-cyan/5 pl-2.5 pr-1.5 py-0.5 text-[12px] text-slate-600', children: [relatedCollection ? (_jsx(RelatedItemLabel, { collection: relatedCollection, id: relId, displayTemplate: colMeta?.display_template })) : (String(relId)), _jsx("button", { type: 'button', onClick: () => staging?.unstageLink(stagingKey, relId), className: 'rounded-full p-0.5 text-slate-400 hover:text-red-500', children: _jsx(X, { className: 'h-3 w-3' }) })] }, String(relId))))] })), _jsxs(Popover, { open: open, onOpenChange: (o) => {
                    setOpen(o);
                    if (!o)
                        setSearch('');
                }, children: [_jsx(PopoverTrigger, { asChild: true, children: _jsxs(Button, { variant: 'outline', size: 'sm', className: 'h-8 w-full justify-start gap-1.5 text-[13px] font-normal text-muted-foreground', children: [_jsx(ChevronsUpDown, { className: 'h-3.5 w-3.5 shrink-0 opacity-50' }), allSelectedIds.size > 0
                                    ? `${allSelectedIds.size} selected — click to change`
                                    : 'Select items…'] }) }), _jsx(PopoverContent, { className: 'w-[320px] p-0', align: 'start', children: _jsxs(Command, { shouldFilter: false, children: [_jsx(CommandInput, { placeholder: 'Search\u2026', value: search, onValueChange: setSearch, className: 'h-9 text-[13px]' }), _jsxs(CommandList, { children: [isLoadingOptions ? (_jsx("div", { className: 'flex items-center justify-center py-4', children: _jsx(Loader2, { className: 'h-4 w-4 animate-spin text-muted-foreground' }) })) : (_jsx(CommandEmpty, { className: 'py-3 text-center text-[12px] text-muted-foreground', children: "No results" })), _jsx(CommandGroup, { children: !isLoadingOptions && [...options]
                                                .sort((a, b) => getLabel(a).localeCompare(getLabel(b)))
                                                .map((opt) => {
                                                const optId = String(opt.id);
                                                const isSelected = allSelectedIds.has(optId);
                                                return (_jsxs(CommandItem, { value: optId, onSelect: () => handleToggle(opt.id), className: 'flex items-center gap-2 text-[13px]', children: [_jsx("div", { className: cn('flex h-4 w-4 shrink-0 items-center justify-center rounded border', isSelected ? 'border-nvr-cyan bg-nvr-cyan' : 'border-slate-300'), children: isSelected && _jsx(Check, { className: 'h-2.5 w-2.5 text-white' }) }), _jsx("span", { className: 'truncate', children: getLabel(opt) })] }, optId));
                                            }) })] })] }) })] })] }));
}
// ─── M2MSingleSelectCombobox (max_values=1) ────────────────────────────────────
export function M2MSingleSelectCombobox({ relation, parentId, allRelations, extraFilter, requiredParent }) {
    const client = useNivaroClient();
    const staging = useM2MStaging();
    const [open, setOpen] = useState(false);
    const [search, setSearch] = useState('');
    const otherRel = allRelations.find((r) => r.many_collection === relation.many_collection &&
        r.many_field === relation.junction_field &&
        r.id !== relation.id);
    const relatedCollection = otherRel?.one_collection ?? null;
    const junctionField = relation.junction_field ?? '';
    const manyField = relation.many_field ?? '';
    const stagingKey = relation.one_field ?? `${relation.many_collection}.${junctionField}`;
    const { data: colMeta } = useQuery({
        queryKey: ['col-meta', relatedCollection],
        queryFn: () => client
            .request(get(`/collections/${relatedCollection}`))
            .then((r) => r.data),
        enabled: !!relatedCollection,
        staleTime: 300_000,
        retry: false
    });
    const { data: junctionItems = [] } = useQuery({
        queryKey: ['m2m-items', relation.many_collection, manyField, parentId],
        queryFn: () => client
            .request(get(`/items/${relation.many_collection}`, {
            filter: JSON.stringify({ [manyField]: { _eq: parentId } }),
            limit: 1,
            fields: `id,${junctionField}`
        }))
            .then((r) => r.data ?? []),
        staleTime: 30_000
    });
    const filterParam = extraFilter ? JSON.stringify(extraFilter) : undefined;
    const { data: options = [], isFetching: isLoadingOptions } = useQuery({
        queryKey: ['m2m-options', relatedCollection, search, filterParam],
        queryFn: () => client
            .request(get(`/items/${relatedCollection}`, {
            limit: 200,
            search: search || undefined,
            filter: filterParam,
            picker: '1'
        }))
            .then((r) => r.data ?? []),
        enabled: open && !!relatedCollection,
        staleTime: filterParam ? 0 : 30_000
    });
    const stagedLinks = staging?.getStagedLinks(stagingKey) ?? [];
    const stagedUnlinks = staging?.getStagedUnlinks(stagingKey) ?? new Set();
    const committedItem = junctionItems.find((i) => !stagedUnlinks.has(i.id)) ?? null;
    const committedRelatedId = committedItem ? committedItem[junctionField] : null;
    const stagedRelatedId = stagedLinks.length > 0 ? stagedLinks[stagedLinks.length - 1] : null;
    const currentRelatedId = stagedRelatedId ?? committedRelatedId;
    const isPendingChange = stagedLinks.length > 0 || stagedUnlinks.size > 0;
    const { data: currentItemData } = useQuery({
        queryKey: ['relation-single', relatedCollection, String(currentRelatedId)],
        queryFn: () => client
            .request(get(`/items/${relatedCollection}/${currentRelatedId}`))
            .then((r) => r.data),
        enabled: !!relatedCollection && currentRelatedId != null,
        staleTime: 60_000
    });
    const tmpl = colMeta?.display_template ?? null;
    function getLabel(item) {
        return tmpl
            ? tmpl.replace(/\{\{([^}]+)\}\}/g, (_, k) => String(item[k.trim()] ?? ''))
            : String(item.name ?? item.title ?? item.label ?? item.id ?? '');
    }
    const currentOpt = options.find((o) => String(o.id) === String(currentRelatedId)) ?? currentItemData;
    const isLoadingLabel = currentRelatedId != null && !currentItemData && !currentOpt;
    const currentLabel = currentOpt ? getLabel(currentOpt) : null;
    function handleSelect(optId) {
        for (const id of stagedLinks)
            staging?.unstageLink(stagingKey, id);
        if (committedItem && !stagedUnlinks.has(committedItem.id))
            staging?.stageUnlink(stagingKey, committedItem.id);
        if (String(optId) === String(committedRelatedId) && committedItem) {
            staging?.unstageUnlink(stagingKey, committedItem.id);
        }
        else if (String(optId) !== String(currentRelatedId)) {
            staging?.stageLink(stagingKey, optId);
        }
        setOpen(false);
        setSearch('');
    }
    function handleClear() {
        for (const id of stagedLinks)
            staging?.unstageLink(stagingKey, id);
        if (committedItem)
            staging?.stageUnlink(stagingKey, committedItem.id);
        setOpen(false);
    }
    if (requiredParent) {
        return (_jsxs("button", { type: 'button', disabled: true, className: 'w-full h-9 px-3 text-[13px] border border-input rounded-md bg-background text-left flex items-center justify-between opacity-50 cursor-not-allowed', children: [_jsxs("span", { className: 'truncate text-muted-foreground', children: ["Select ", requiredParent, " first"] }), _jsx(ChevronsUpDown, { className: 'h-3.5 w-3.5 text-slate-400 shrink-0 ml-2' })] }));
    }
    return (_jsxs(Popover, { open: open, onOpenChange: (o) => {
            setOpen(o);
            if (!o)
                setSearch('');
        }, children: [_jsx(PopoverTrigger, { asChild: true, children: _jsxs("button", { type: 'button', className: cn('w-full h-9 px-3 text-[13px] border rounded-md bg-white text-left flex items-center justify-between hover:bg-slate-50 cursor-pointer transition-colors', isPendingChange ? 'border-nvr-cyan/50' : 'border-slate-200'), children: [isLoadingLabel ? (_jsx("span", { className: 'text-slate-400 text-[13px]', children: "Loading\u2026" })) : (_jsx("span", { className: cn('truncate', currentLabel
                                ? isPendingChange
                                    ? 'text-nvr-cyan'
                                    : 'text-slate-800'
                                : 'text-slate-400'), children: currentLabel ?? 'Select…' })), _jsx(ChevronsUpDown, { className: 'h-3.5 w-3.5 text-slate-400 shrink-0 ml-2' })] }) }), _jsx(PopoverContent, { className: 'w-[320px] p-0', align: 'start', children: _jsxs(Command, { shouldFilter: false, children: [_jsx(CommandInput, { placeholder: 'Search\u2026', value: search, onValueChange: setSearch, className: 'h-9 text-[13px]' }), _jsxs(CommandList, { children: [isLoadingOptions ? (_jsx("div", { className: 'flex items-center justify-center py-4', children: _jsx(Loader2, { className: 'h-4 w-4 animate-spin text-muted-foreground' }) })) : (_jsx(CommandEmpty, { className: 'py-3 text-center text-[12px] text-muted-foreground', children: "No results" })), !isLoadingOptions && (_jsxs(CommandGroup, { children: [_jsx(CommandItem, { value: '__clear__', onSelect: handleClear, className: 'text-[13px] text-slate-400', children: "Clear selection" }), [...options]
                                            .sort((a, b) => getLabel(a).localeCompare(getLabel(b)))
                                            .map((opt) => {
                                            const optId = String(opt.id);
                                            const isSelected = String(currentRelatedId) === optId;
                                            return (_jsxs(CommandItem, { value: optId, onSelect: () => handleSelect(opt.id), className: 'flex items-center gap-2 text-[13px]', children: [_jsx("div", { className: cn('flex h-4 w-4 shrink-0 items-center justify-center rounded-full border transition-colors', isSelected ? 'border-nvr-cyan bg-nvr-cyan' : 'border-slate-300'), children: isSelected && _jsx(Check, { className: 'h-2.5 w-2.5 text-white' }) }), _jsx("span", { className: 'truncate', children: getLabel(opt) })] }, optId));
                                        })] }))] })] }) })] }));
}
//# sourceMappingURL=M2MCombobox.js.map