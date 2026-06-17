import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useMutation, useQuery } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, Clock, RotateCcw } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { useNivaroClient } from '../../context';
import { get, post } from '../../lib/commands';
import { cn, formatRelative } from '../../lib/utils';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from '../ui/sheet';
import { Skeleton } from '../ui/skeleton';
const ACTION_VARIANTS = {
    create: 'success',
    update: 'default',
    delete: 'destructive'
};
function revisionUserName(rev) {
    if (rev.first_name || rev.last_name)
        return [rev.first_name, rev.last_name].filter(Boolean).join(' ');
    return rev.user_email ?? rev.user_id?.slice(0, 8) ?? 'System';
}
function stringifyValue(value) {
    if (value === null || value === undefined)
        return '';
    if (typeof value === 'object')
        return JSON.stringify(value);
    return String(value);
}
const TRUNCATE_AT = 120;
function ValueCell({ value, tone }) {
    const [expanded, setExpanded] = useState(false);
    const str = stringifyValue(value);
    if (value === null || value === undefined || str === '')
        return _jsx("span", { className: 'text-slate-300 dark:text-slate-600 italic text-[11px]', children: "\u2014" });
    const isLong = str.length > TRUNCATE_AT;
    const shown = expanded || !isLong ? str : `${str.slice(0, TRUNCATE_AT)}…`;
    return (_jsxs("span", { className: 'break-all text-[11px] text-slate-700 dark:text-slate-300', children: [typeof value === 'object' ? _jsx("span", { className: 'font-mono text-[10.5px]', children: shown }) : shown, isLong && (_jsx("button", { type: 'button', onClick: () => setExpanded((e) => !e), className: cn('ml-1 text-[10px] font-medium hover:underline', tone === 'before' ? 'text-rose-500' : 'text-emerald-600'), children: expanded ? 'less' : 'more' }))] }));
}
const STATUS_ROW_CLS = {
    added: 'bg-emerald-50/70 dark:bg-emerald-950/20',
    removed: 'bg-red-50/70 dark:bg-red-950/20',
    changed: 'bg-amber-50/70 dark:bg-amber-950/20',
    unchanged: ''
};
function SideBySideView({ before, after }) {
    const fields = Array.from(new Set([...Object.keys(before), ...Object.keys(after)])).sort();
    if (fields.length === 0)
        return _jsx("p", { className: 'text-[12px] text-slate-400', children: "No snapshot data available." });
    return (_jsxs("div", { className: 'overflow-hidden rounded-lg border border-slate-200 dark:border-border', children: [_jsxs("div", { className: 'grid grid-cols-[1fr_1fr] border-b border-slate-200 bg-slate-50 dark:border-border dark:bg-muted/40', children: [_jsx("div", { className: 'px-2.5 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-slate-400', children: "Before" }), _jsx("div", { className: 'border-l border-slate-200 px-2.5 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-slate-400 dark:border-border', children: "After" })] }), fields.map((field) => {
                const inBefore = field in before && before[field] !== undefined;
                const inAfter = field in after && after[field] !== undefined;
                const status = !inBefore
                    ? 'added'
                    : !inAfter
                        ? 'removed'
                        : stringifyValue(before[field]) !== stringifyValue(after[field])
                            ? 'changed'
                            : 'unchanged';
                return (_jsxs("div", { className: cn('border-b border-slate-100 last:border-0 dark:border-border/60', STATUS_ROW_CLS[status]), children: [_jsxs("div", { className: 'flex items-center gap-1.5 px-2.5 pt-1.5', children: [_jsx("span", { className: 'font-mono text-[10.5px] text-slate-500', children: field }), status !== 'unchanged' && (_jsx("span", { className: cn('rounded px-1 py-px text-[9px] font-semibold uppercase', status === 'added' &&
                                        'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-400', status === 'removed' &&
                                        'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-400', status === 'changed' &&
                                        'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-400'), children: status }))] }), _jsxs("div", { className: 'grid grid-cols-[1fr_1fr]', children: [_jsx("div", { className: 'px-2.5 py-1.5', children: inBefore ? (_jsx(ValueCell, { value: before[field], tone: 'before' })) : (_jsx("span", { className: 'text-[11px] italic text-slate-300 dark:text-slate-600', children: "not set" })) }), _jsx("div", { className: 'border-l border-slate-100 px-2.5 py-1.5 dark:border-border/60', children: inAfter ? (_jsx(ValueCell, { value: after[field], tone: 'after' })) : (_jsx("span", { className: 'text-[11px] italic text-slate-300 dark:text-slate-600', children: "removed" })) })] })] }, field));
            })] }));
}
function DeltaView({ delta }) {
    const entries = Object.entries(delta);
    if (entries.length === 0)
        return _jsx("p", { className: 'text-[12px] text-slate-400', children: "No changes recorded" });
    return (_jsxs("table", { className: 'w-full text-[12px]', children: [_jsx("thead", { children: _jsxs("tr", { className: 'text-left text-slate-400', children: [_jsx("th", { className: 'pr-4 pb-1 font-medium w-2/5', children: "Field" }), _jsx("th", { className: 'pb-1 font-medium', children: "New value" })] }) }), _jsx("tbody", { children: entries.map(([field, value]) => (_jsxs("tr", { className: 'border-t border-slate-100', children: [_jsx("td", { className: 'pr-4 py-1.5 font-mono text-slate-500 align-top', children: field }), _jsx("td", { className: 'py-1.5 text-slate-700 break-all align-top', children: value === null || value === undefined ? (_jsx("span", { className: 'text-slate-400 italic', children: "null" })) : typeof value === 'object' ? (_jsx("span", { className: 'font-mono text-[11px] text-slate-500', children: JSON.stringify(value) })) : (String(value)) })] }, field))) })] }));
}
function SnapshotDataView({ data }) {
    return (_jsx("pre", { className: 'text-[11px] font-mono text-slate-600 bg-slate-50 rounded p-3 overflow-x-auto whitespace-pre-wrap break-all max-h-64', children: JSON.stringify(data, null, 2) }));
}
function RevisionRow({ revision, previousData, onRollback }) {
    const client = useNivaroClient();
    const [expanded, setExpanded] = useState(false);
    const [confirmRollback, setConfirmRollback] = useState(false);
    const [view, setView] = useState('delta');
    const isUpdate = revision.action === 'update';
    const isCreate = revision.action === 'create';
    const isDelete = revision.action === 'delete';
    const sideBefore = isDelete
        ? (revision.data ?? {})
        : isCreate
            ? {}
            : (previousData ?? {});
    const sideAfter = isDelete ? {} : (revision.data ?? {});
    const deltaCount = revision.delta ? Object.keys(revision.delta).length : 0;
    const canRollback = isUpdate || isCreate;
    const rollbackMut = useMutation({
        mutationFn: () => client.request(post(`/revisions/${revision.id}/rollback`, {})),
        onSuccess: () => {
            setConfirmRollback(false);
            toast.success('Rolled back to this revision');
            onRollback?.();
        },
        onError: () => toast.error('Failed to rollback')
    });
    return (_jsxs("div", { className: 'border-b last:border-0 border-slate-100', children: [_jsxs("button", { type: 'button', onClick: () => setExpanded((e) => !e), className: 'w-full flex items-center gap-2.5 py-3 text-left hover:bg-slate-50 transition-colors px-1 rounded', children: [expanded ? (_jsx(ChevronDown, { className: 'h-3.5 w-3.5 text-slate-400 shrink-0' })) : (_jsx(ChevronRight, { className: 'h-3.5 w-3.5 text-slate-400 shrink-0' })), _jsx(Badge, { variant: ACTION_VARIANTS[revision.action ?? ''] ?? 'secondary', className: 'text-[10px] capitalize w-14 justify-center shrink-0', children: revision.action ?? '—' }), _jsx("span", { className: 'text-[12px] text-slate-700 flex-1 truncate', children: revisionUserName(revision) }), _jsxs("div", { className: 'flex flex-col items-end gap-0.5 shrink-0', children: [isUpdate && deltaCount > 0 && (_jsxs("span", { className: 'text-[10px] text-slate-400', children: [deltaCount, " field", deltaCount !== 1 ? 's' : ''] })), _jsx("span", { className: 'text-[11px] text-slate-400', children: revision.timestamp ? formatRelative(revision.timestamp) : '—' })] })] }), expanded && (_jsxs("div", { className: 'px-6 pb-3 space-y-2', children: [_jsxs("div", { className: 'flex items-center justify-between', children: [_jsx("p", { className: 'text-[10px] font-medium text-slate-500', children: view === 'side'
                                    ? 'Before / After'
                                    : isUpdate && revision.delta
                                        ? 'Changes'
                                        : 'Snapshot' }), _jsx("div", { className: 'flex items-center overflow-hidden rounded border border-slate-200 dark:border-border', children: ['delta', 'side'].map((v) => (_jsx("button", { type: 'button', onClick: () => setView(v), className: view === v
                                        ? 'bg-nvr-cyan/10 px-2 py-0.5 text-[10px] font-medium text-nvr-navy dark:text-nvr-cyan'
                                        : 'px-2 py-0.5 text-[10px] text-slate-400 transition-colors hover:text-slate-600', children: v === 'delta' ? 'Delta' : 'Side-by-side' }, v))) })] }), view === 'side' ? (_jsx(SideBySideView, { before: sideBefore, after: sideAfter })) : isUpdate && revision.delta ? (_jsx(DeltaView, { delta: revision.delta })) : (_jsx(SnapshotDataView, { data: revision.data })), canRollback && (_jsx("div", { className: 'flex items-center justify-end gap-2 pt-1', children: confirmRollback ? (_jsxs(_Fragment, { children: [_jsx("span", { className: 'text-[11px] text-slate-500', children: "Restore this revision?" }), _jsx(Button, { size: 'sm', variant: 'destructive', className: 'h-6 text-[11px]', disabled: rollbackMut.isPending, onClick: () => rollbackMut.mutate(), children: "Yes, restore" }), _jsx(Button, { size: 'sm', variant: 'outline', className: 'h-6 text-[11px]', onClick: () => setConfirmRollback(false), children: "Cancel" })] })) : (_jsxs(Button, { size: 'sm', variant: 'outline', className: 'h-6 text-[11px]', disabled: rollbackMut.isPending, onClick: () => setConfirmRollback(true), children: [_jsx(RotateCcw, { className: 'mr-1 h-3 w-3' }), "Rollback"] })) }))] }))] }));
}
function RevisionsList({ collection, item, onRollback }) {
    const client = useNivaroClient();
    const { data, isLoading } = useQuery({
        queryKey: ['revisions', collection, item],
        queryFn: () => client
            .request(get('/revisions', { collection, item }))
            .then((r) => r.data ?? []),
        staleTime: 30_000
    });
    const count = data?.length ?? 0;
    if (isLoading)
        return (_jsx("div", { className: 'space-y-2 pt-2', children: [1, 2, 3, 4].map((i) => (_jsx(Skeleton, { className: 'h-10 rounded' }, i))) }));
    if (count === 0)
        return _jsx("p", { className: 'text-[13px] text-slate-400 pt-4', children: "No revisions recorded yet." });
    return (_jsx("div", { className: 'pt-2', children: (data ?? []).map((rev, i) => (_jsx(RevisionRow, { revision: rev, previousData: data?.[i + 1]?.data ?? null, onRollback: onRollback }, rev.id))) }));
}
export function RevisionsPanel({ collection, item, onRollback, triggerClassName }) {
    return (_jsxs(Sheet, { children: [_jsx(SheetTrigger, { asChild: true, children: _jsxs(Button, { variant: 'outline', size: 'sm', className: triggerClassName ?? 'gap-1.5', children: [_jsx(Clock, { className: 'h-3.5 w-3.5' }), "History"] }) }), _jsxs(SheetContent, { className: 'w-[420px] sm:max-w-[420px] overflow-y-auto', children: [_jsx(SheetHeader, { children: _jsxs(SheetTitle, { className: 'flex items-center gap-2 text-base', children: [_jsx(Clock, { className: 'h-4 w-4 text-slate-400' }), "Revision History"] }) }), _jsx(RevisionsList, { collection: collection, item: item, onRollback: onRollback })] })] }));
}
//# sourceMappingURL=RevisionsPanel.js.map