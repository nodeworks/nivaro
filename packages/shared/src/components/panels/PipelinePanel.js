import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRight, Check, CheckCircle2, ChevronDown, ChevronRight, GitBranch, Loader2, Search, UserPlus, Users, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { useNivaroClient } from '../../context';
import { del, get, post } from '../../lib/commands';
import { cn, formatRelative } from '../../lib/utils';
import { Button } from '../ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '../ui/dropdown-menu';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover';
import { Skeleton } from '../ui/skeleton';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../ui/tooltip';
// ─── State badge ──────────────────────────────────────────────────────────────
function StateBadge({ label, color, small }) {
    const size = small ? 'px-2 py-0.5 text-[11px]' : 'px-2.5 py-1 text-[12px]';
    return (_jsx("span", { className: `inline-flex items-center gap-1.5 rounded-full font-medium ${size}`, style: {
            backgroundColor: color ? `${color}22` : '#f1f5f9',
            color: color ?? '#475569',
            border: `1px solid ${color ? `${color}44` : '#e2e8f0'}`
        }, children: label }));
}
// ─── State track ─────────────────────────────────────────────────────────────
function StateTrack({ states, allTransitions, availableTransitions, currentStateId, history }) {
    const visitedIds = new Set(history.map((h) => h.to_state));
    const relevant = (() => {
        if (allTransitions.length === 0) {
            const show = new Set([...visitedIds]);
            if (currentStateId)
                show.add(currentStateId);
            return states.filter((s) => show.has(s.id)).sort((a, b) => a.sort - b.sort);
        }
        const takenEdges = new Set(history.filter((h) => h.from_state).map((h) => `${h.from_state}:${h.to_state}`));
        const visitedFromIds = new Set(history.map((h) => h.from_state).filter(Boolean));
        const explicit = allTransitions.filter((t) => t.from_state !== null);
        const fwd = new Map();
        for (const t of explicit) {
            const fromId = t.from_state;
            if (visitedFromIds.has(fromId) && !takenEdges.has(`${fromId}:${t.to_state}`))
                continue;
            const arr = fwd.get(fromId) ?? [];
            arr.push(t.to_state);
            fwd.set(fromId, arr);
        }
        if (currentStateId)
            fwd.set(currentStateId, availableTransitions.map((t) => t.to_state));
        const pathIds = new Set();
        const queue = states.filter((s) => s.is_initial).map((s) => s.id);
        while (queue.length) {
            const id = queue.shift();
            if (pathIds.has(id))
                continue;
            pathIds.add(id);
            for (const next of fwd.get(id) ?? [])
                if (!pathIds.has(next))
                    queue.push(next);
        }
        const show = new Set([...pathIds, ...visitedIds]);
        if (currentStateId)
            show.add(currentStateId);
        return states
            .filter((s) => show.has(s.id))
            .filter((s) => {
            const v = s.stage_visibility ?? 'always';
            if (v === 'hide')
                return false;
            if (v === 'hide_unless_active')
                return visitedIds.has(s.id) || s.id === currentStateId;
            return true;
        })
            .sort((a, b) => a.sort - b.sort);
    })();
    if (relevant.length < 2)
        return null;
    function edgeEntries(fromId, toId) {
        return [...history]
            .filter((h) => (h.from_state === fromId && h.to_state === toId) ||
            (h.from_state === toId && h.to_state === fromId))
            .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
    }
    function entryInitials(h) {
        return (((h.first_name?.[0] ?? '') + (h.last_name?.[0] ?? '')).toUpperCase() ||
            h.user_email?.[0]?.toUpperCase() ||
            '?');
    }
    function entryName(h) {
        return [h.first_name, h.last_name].filter(Boolean).join(' ') || h.user_email || 'System';
    }
    return (_jsx(TooltipProvider, { delayDuration: 200, children: _jsx("div", { className: 'flex w-full items-start', children: relevant.map((s, i) => {
                const isCurrent = s.id === currentStateId;
                const isVisited = visitedIds.has(s.id);
                const isDone = isVisited && !isCurrent;
                const nodeColor = s.color ?? '#94a3b8';
                const isLast = i === relevant.length - 1;
                const nextState = !isLast ? relevant[i + 1] : null;
                const edge = nextState ? edgeEntries(s.id, nextState.id) : [];
                return (_jsxs("div", { className: 'flex min-w-[48px] flex-1 items-start', children: [_jsxs("div", { className: 'flex min-w-0 flex-1 flex-col items-center gap-1.5 px-1', children: [_jsx("div", { className: 'flex h-7 w-7 shrink-0 items-center justify-center rounded-full', style: {
                                        backgroundColor: isCurrent || isDone ? nodeColor : '#f1f5f9',
                                        border: isCurrent || isDone ? 'none' : '1.5px solid #e2e8f0',
                                        boxShadow: isCurrent ? `0 0 0 3px white, 0 0 0 5px ${nodeColor}` : undefined
                                    }, children: isDone ? (_jsx(Check, { className: 'h-3.5 w-3.5 text-white', strokeWidth: 2.5 })) : isCurrent ? (_jsx("div", { className: 'h-2.5 w-2.5 rounded-full bg-white/80' })) : (_jsx("div", { className: 'h-2 w-2 rounded-full bg-slate-300' })) }), _jsx("span", { className: 'w-full break-words text-center leading-snug', style: {
                                        fontSize: '11px',
                                        color: isCurrent ? nodeColor : isDone ? '#475569' : '#94a3b8',
                                        fontWeight: isCurrent ? 600 : isDone ? 500 : 400,
                                        wordBreak: 'break-word'
                                    }, children: s.label })] }), !isLast && (_jsxs("div", { className: 'mt-[13px] flex w-10 shrink-0 flex-col items-center gap-1.5', children: [(() => {
                                    const lineColor = isDone ? `${nodeColor}55` : '#e8ecf0';
                                    return (_jsxs("div", { className: 'flex w-full shrink-0 items-center', children: [_jsx("div", { className: 'h-0.5 flex-1 rounded-l-sm', style: { backgroundColor: lineColor } }), _jsx("div", { style: {
                                                    width: 0,
                                                    height: 0,
                                                    borderTop: '3px solid transparent',
                                                    borderBottom: '3px solid transparent',
                                                    borderLeft: `5px solid ${lineColor}`
                                                } })] }));
                                })(), edge.map((h) => {
                                    const isSendback = h.from_state !== s.id;
                                    return (_jsxs(Tooltip, { children: [_jsx(TooltipTrigger, { asChild: true, children: _jsxs("div", { className: 'flex w-full cursor-default flex-col items-center gap-0.5', children: [_jsxs("span", { className: 'text-center font-mono text-[9px] font-semibold leading-none', style: { color: isSendback ? '#d97706' : '#475569' }, children: [isSendback && '↩ ', entryInitials(h)] }), _jsx("span", { className: 'text-[8.5px] leading-none text-slate-400', children: formatRelative(h.timestamp) })] }) }), _jsxs(TooltipContent, { side: 'top', className: 'space-y-0.5 text-[12px]', children: [_jsxs("p", { className: 'font-medium', children: [isSendback ? '↩ Sent back by' : 'Approved by', " ", entryName(h)] }), _jsx("p", { className: 'text-muted-foreground', children: new Date(h.timestamp).toLocaleString() })] })] }, h.id));
                                })] }))] }, s.id));
            }) }) }));
}
// ─── History timeline ─────────────────────────────────────────────────────────
function HistoryTimeline({ history }) {
    if (history.length === 0)
        return _jsx("p", { className: 'text-[12px] text-slate-400 italic', children: "No transitions yet." });
    return (_jsx("div", { className: 'space-y-3', children: history.map((h) => {
            const userName = h.first_name || h.last_name
                ? [h.first_name, h.last_name].filter(Boolean).join(' ')
                : (h.user_email ?? 'System');
            return (_jsxs("div", { className: 'flex items-start gap-2.5 text-[12px]', children: [_jsx("div", { className: 'mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-slate-200' }), _jsxs("div", { className: 'flex-1 min-w-0', children: [_jsxs("div", { className: 'flex items-center gap-1.5 flex-wrap', children: [h.from_state_label ? (_jsx(StateBadge, { label: h.from_state_label, color: h.from_state_color, small: true })) : (_jsx("span", { className: 'text-[11px] text-slate-400 italic', children: "started" })), _jsx(ArrowRight, { className: 'h-3 w-3 shrink-0 text-slate-300' }), _jsx(StateBadge, { label: h.to_state_label, color: h.to_state_color, small: true })] }), h.comment && _jsxs("p", { className: 'mt-1 text-slate-500 italic', children: ["\"", h.comment, "\""] }), _jsxs("p", { className: 'mt-0.5 text-slate-400', children: [userName, " \u00B7 ", formatRelative(h.timestamp)] })] })] }, h.id));
        }) }));
}
// ─── Async user picker ────────────────────────────────────────────────────────
function AsyncUserPicker({ value, onChange }) {
    const client = useNivaroClient();
    const [open, setOpen] = useState(false);
    const [query, setQuery] = useState('');
    const [debouncedQuery, setDebouncedQuery] = useState('');
    const inputRef = useRef(null);
    const debounceRef = useRef(null);
    useEffect(() => {
        if (open)
            setTimeout(() => inputRef.current?.focus(), 50);
        else
            setQuery('');
    }, [open]);
    useEffect(() => {
        if (debounceRef.current)
            clearTimeout(debounceRef.current);
        debounceRef.current = setTimeout(() => setDebouncedQuery(query), 250);
        return () => {
            if (debounceRef.current)
                clearTimeout(debounceRef.current);
        };
    }, [query]);
    const { data, isLoading } = useQuery({
        queryKey: ['users', 'async-search', debouncedQuery],
        queryFn: () => client
            .request(get('/users', {
            limit: 50,
            sort: 'first_name',
            ...(debouncedQuery ? { search: debouncedQuery } : {})
        }))
            .then((r) => r.data),
        enabled: open,
        staleTime: 30_000
    });
    const { data: selectedUser } = useQuery({
        queryKey: ['users', 'single', value],
        queryFn: () => client.request(get(`/users/${value}`)).then((r) => r.data),
        enabled: !!value,
        staleTime: 5 * 60_000
    });
    const selectedLabel = selectedUser
        ? [selectedUser.first_name, selectedUser.last_name].filter(Boolean).join(' ').trim() ||
            selectedUser.email
        : value || null;
    const users = data ?? [];
    const nameOf = (u) => [u.first_name, u.last_name].filter(Boolean).join(' ').trim();
    return (_jsxs(Popover, { open: open, onOpenChange: setOpen, children: [_jsxs("div", { className: 'relative flex h-8 w-full', children: [_jsx(PopoverTrigger, { asChild: true, children: _jsxs("button", { type: 'button', className: 'flex h-full w-full items-center justify-between gap-1.5 rounded-md border border-slate-200 bg-white px-2.5 text-left text-[13px] text-slate-700 hover:border-slate-300', children: [_jsx("span", { className: `flex-1 truncate ${selectedLabel ? '' : 'text-slate-400'}`, children: selectedLabel ?? 'Select a user…' }), _jsx(ChevronDown, { className: 'h-3.5 w-3.5 shrink-0 text-slate-400' })] }) }), value && (_jsx("button", { type: 'button', onClick: (e) => {
                            e.stopPropagation();
                            onChange('');
                        }, className: 'absolute right-6 top-1/2 -translate-y-1/2 flex h-5 w-5 items-center justify-center rounded text-slate-400 hover:bg-slate-100 hover:text-slate-600', children: _jsx(X, { className: 'h-3 w-3' }) }))] }), _jsxs(PopoverContent, { align: 'start', className: 'w-72 p-0', sideOffset: 4, children: [_jsx("div", { className: 'border-b border-slate-100 px-2 py-1.5', children: _jsxs("div", { className: 'relative', children: [_jsx(Search, { className: 'absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400' }), _jsx("input", { ref: inputRef, value: query, onChange: (e) => setQuery(e.target.value), placeholder: 'Search users\u2026', className: 'h-7 w-full rounded-md bg-slate-50 pl-7 pr-2 text-[12px] placeholder-slate-400 focus:outline-none focus:ring-1 focus:ring-nvr-cyan/40' })] }) }), _jsx("div", { className: 'max-h-56 overflow-y-auto py-1', children: isLoading ? (_jsxs("div", { className: 'flex items-center gap-2 px-3 py-2 text-[12px] text-slate-400', children: [_jsx(Loader2, { className: 'h-3.5 w-3.5 animate-spin' }), "Loading\u2026"] })) : users.length === 0 ? (_jsx("div", { className: 'px-3 py-2 text-[12px] text-slate-400', children: "No results" })) : (users.map((u) => {
                            const name = nameOf(u);
                            const label = name ? `${name} (${u.email})` : u.email;
                            const selected = u.id === value;
                            return (_jsxs("button", { type: 'button', onClick: () => {
                                    onChange(u.id);
                                    setOpen(false);
                                }, className: `flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] hover:bg-slate-50 ${selected ? 'font-medium text-slate-800' : 'text-slate-600'}`, children: [_jsx(Check, { className: `h-3.5 w-3.5 shrink-0 ${selected ? 'text-nvr-cyan' : 'opacity-0'}` }), label] }, u.id));
                        })) })] })] }));
}
// ─── Owners section ───────────────────────────────────────────────────────────
function OwnersSection({ collection, item, states }) {
    const client = useNivaroClient();
    const queryClient = useQueryClient();
    const [adding, setAdding] = useState(false);
    const [userId, setUserId] = useState('');
    const [stateScope, setStateScope] = useState('');
    const ownersKey = ['pipeline-instance-owners', collection, item];
    const { data: owners, isLoading: ownersLoading } = useQuery({
        queryKey: ownersKey,
        queryFn: () => client
            .request(get(`/pipelines/instance/${collection}/${item}/owners`))
            .then((r) => r.data)
    });
    const invalidate = () => {
        queryClient.invalidateQueries({ queryKey: ownersKey });
        queryClient.invalidateQueries({ queryKey: ['pipeline-instance', collection, item] });
    };
    const addOwner = useMutation({
        mutationFn: () => client.request(post(`/pipelines/instance/${collection}/${item}/owners`, {
            user: userId,
            state: stateScope || undefined
        })),
        onSuccess: () => {
            invalidate();
            setUserId('');
            setStateScope('');
            setAdding(false);
            toast.success('Owner added');
        },
        onError: () => toast.error('Failed to add owner')
    });
    const removeOwner = useMutation({
        mutationFn: (id) => client.request(del(`/pipelines/instance-owners/${id}`)),
        onSuccess: () => {
            invalidate();
            toast.success('Owner removed');
        },
        onError: () => toast.error('Failed to remove owner')
    });
    const ownerInitials = (o) => {
        const f = o.first_name?.[0] ?? '';
        const l = o.last_name?.[0] ?? '';
        return (`${f}${l}`.trim() || o.email[0] || '?').toUpperCase();
    };
    const stateLabelFor = (v) => {
        if (!v)
            return null;
        return states.find((s) => s.id === v || s.key === v)?.label ?? v;
    };
    return (_jsxs("div", { children: [_jsxs("div", { className: 'mb-3 flex items-center justify-between', children: [_jsxs("span", { className: 'flex items-center gap-1.5 text-[11px] font-medium text-slate-400', children: [_jsx(Users, { className: 'h-3.5 w-3.5' }), "Owners", ownersLoading ? (_jsx("span", { className: 'inline-block h-3 w-4 animate-pulse rounded bg-slate-200' })) : (_jsxs("span", { className: 'text-slate-300', children: ["(", owners?.length ?? 0, ")"] }))] }), !adding && (_jsxs("button", { type: 'button', onClick: () => setAdding(true), className: 'flex items-center gap-1 text-[11px] text-slate-400 transition-colors hover:text-nvr-cyan', children: [_jsx(UserPlus, { className: 'h-3 w-3' }), "Add"] }))] }), ownersLoading ? (_jsxs("div", { className: 'space-y-2', children: [_jsx(Skeleton, { className: 'h-8 w-full rounded-md' }), _jsx(Skeleton, { className: 'h-8 w-3/4 rounded-md' })] })) : !owners || owners.length === 0 ? (_jsx("p", { className: 'text-[12px] text-slate-400', children: "No owners assigned." })) : (_jsx("div", { className: 'space-y-px', children: owners.map((o) => (_jsxs("div", { className: 'group -mx-2 flex items-center gap-2.5 rounded-md px-2 py-1.5 transition-colors hover:bg-slate-50', children: [_jsx("span", { className: 'flex h-6 w-6 shrink-0 select-none items-center justify-center rounded-full bg-nvr-cyan/10 text-[10px] font-semibold text-nvr-navy/80', children: ownerInitials(o) }), _jsxs("div", { className: 'min-w-0 flex-1', children: [_jsx("span", { className: 'block truncate text-[12px] font-medium text-slate-700', children: [o.first_name, o.last_name].filter(Boolean).join(' ') || o.email }), _jsx("span", { className: 'block truncate text-[11px] text-slate-400', children: o.email })] }), _jsx("span", { className: 'shrink-0 rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-500', children: o.state ? stateLabelFor(o.state) : 'all states' }), _jsx("button", { type: 'button', onClick: () => removeOwner.mutate(o.id), className: 'shrink-0 rounded p-0.5 text-slate-300 opacity-0 transition-all hover:text-red-500 group-hover:opacity-100', children: _jsx(X, { className: 'h-3 w-3' }) })] }, o.id))) })), adding && (_jsxs("div", { className: 'mt-3 space-y-2 rounded-lg border border-slate-200 bg-slate-50 p-3', children: [_jsx("p", { className: 'text-[11px] font-semibold text-slate-500', children: "Add owner" }), _jsx(AsyncUserPicker, { value: userId, onChange: setUserId }), _jsxs("select", { value: stateScope, onChange: (e) => setStateScope(e.target.value), className: 'h-8 w-full rounded-md border border-slate-200 bg-white px-2.5 text-[13px] text-slate-700', children: [_jsx("option", { value: '', children: "All states" }), states.map((s) => (_jsx("option", { value: s.id, children: s.label }, s.id)))] }), _jsxs("div", { className: 'flex items-center justify-end gap-2 pt-0.5', children: [_jsx(Button, { type: 'button', size: 'sm', variant: 'ghost', className: 'h-7 text-[12px]', onClick: () => {
                                    setAdding(false);
                                    setUserId('');
                                    setStateScope('');
                                }, children: "Cancel" }), _jsx(Button, { type: 'button', size: 'sm', className: 'h-7 text-[12px]', disabled: !userId || addOwner.isPending, onClick: () => addOwner.mutate(), children: addOwner.isPending ? _jsx(Loader2, { className: 'h-3.5 w-3.5 animate-spin' }) : 'Add' })] })] }))] }));
}
// ─── Pipeline Panel ───────────────────────────────────────────────────────────
export function PipelinePanel({ collection, item, defaultExpanded, title, onBeforeTransition }) {
    if (item === 'new')
        return null;
    return (_jsx(PipelinePanelInner, { collection: collection, item: item, defaultExpanded: defaultExpanded, title: title, onBeforeTransition: onBeforeTransition }));
}
function PipelinePanelInner({ collection, item, defaultExpanded, title, onBeforeTransition }) {
    const client = useNivaroClient();
    const queryClient = useQueryClient();
    const [comment, setComment] = useState('');
    const [pendingTransition, setPendingTransition] = useState(null);
    const [showHistory, setShowHistory] = useState(false);
    const [expanded, setExpanded] = useState(false);
    const syncedFromProp = useRef(false);
    useEffect(() => {
        if (!syncedFromProp.current && defaultExpanded !== undefined) {
            syncedFromProp.current = true;
            setExpanded(defaultExpanded);
        }
    }, [defaultExpanded]);
    const trySetPending = (txId) => {
        if (pendingTransition === txId) {
            setPendingTransition(null);
            return;
        }
        if (onBeforeTransition && !onBeforeTransition())
            return;
        setPendingTransition(txId);
    };
    const queryKey = ['pipeline-instance', collection, item];
    const { data, isLoading } = useQuery({
        queryKey,
        queryFn: () => client
            .request(get(`/pipelines/instance/${collection}/${item}`))
            .then((r) => r.data ?? {
            instance: null,
            states: [],
            available_transitions: [],
            all_transitions: [],
            history: [],
            binding: null
        }),
        staleTime: 10_000
    });
    useEffect(() => queryClient.getQueryCache().subscribe((event) => {
        if (event.type !== 'updated' || event.action.type !== 'success')
            return;
        const k = event.query.queryKey;
        if (Array.isArray(k) && k[0] === 'item' && k[1] === collection && String(k[2]) === item)
            queryClient.invalidateQueries({ queryKey: ['pipeline-instance', collection, item] });
    }), [queryClient, collection, item]);
    const startPipeline = useMutation({
        mutationFn: () => client.request(post(`/pipelines/instance/${collection}/${item}/start`, {})),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey });
            toast.success('Pipeline started');
        },
        onError: () => toast.error('Failed to start pipeline')
    });
    const executeTransition = useMutation({
        mutationFn: ({ transition_id, comment }) => client.request(post(`/pipelines/instance/${collection}/${item}/transition`, { transition_id, comment })),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey });
            setComment('');
            setPendingTransition(null);
            toast.success('Transition executed');
        },
        onError: (err) => {
            const resp = err?.response;
            toast.error(resp?.data?.error ?? 'Failed to execute transition');
            if (resp?.status === 409) {
                queryClient.invalidateQueries({ queryKey });
                setPendingTransition(null);
            }
        }
    });
    if (isLoading)
        return null;
    if (!data?.binding)
        return null;
    const { instance, available_transitions: transitions, history, states } = data;
    const stateById = new Map((states ?? []).map((s) => [s.id, s]));
    const currentState = instance?.current_state_obj ?? null;
    const pendingTx = pendingTransition
        ? (transitions ?? []).find((t) => t.id === pendingTransition)
        : null;
    const pendingToState = pendingTx ? stateById.get(pendingTx.to_state) : null;
    const hasTransitions = !instance?.completed_at && transitions && transitions.length > 0;
    const renderTransitionButtons = (txList, small = false) => {
        const byLabel = new Map();
        for (const tx of txList) {
            const l = byLabel.get(tx.label) ?? [];
            l.push(tx);
            byLabel.set(tx.label, l);
        }
        return Array.from(byLabel.entries()).map(([label, txs]) => {
            const txColor = txs[0]?.color ?? null;
            const isActive = txs.some((t) => t.id === pendingTransition);
            const colorStyle = (active) => txColor
                ? active
                    ? { backgroundColor: txColor, borderColor: txColor }
                    : { borderColor: txColor, color: txColor }
                : undefined;
            if (txs.length === 1) {
                const tx = txs[0];
                return (_jsx(Button, { size: 'sm', variant: isActive ? 'default' : 'outline', className: `${small ? 'h-7 text-[11px]' : 'text-[12px]'} gap-1.5`, style: colorStyle(isActive), onClick: () => trySetPending(tx.id), children: label }, label));
            }
            return (_jsxs(DropdownMenu, { children: [_jsx(DropdownMenuTrigger, { asChild: true, children: _jsxs(Button, { size: 'sm', variant: isActive ? 'default' : 'outline', className: `${small ? 'h-7 text-[11px]' : 'text-[12px]'} gap-1.5`, style: colorStyle(isActive), children: [label, _jsx(ChevronDown, { className: 'h-3 w-3' })] }) }), _jsx(DropdownMenuContent, { align: 'start', children: [...txs]
                            .sort((a, b) => (stateById.get(a.to_state)?.sort ?? 999) -
                            (stateById.get(b.to_state)?.sort ?? 999))
                            .map((tx) => (_jsxs(DropdownMenuItem, { onSelect: () => trySetPending(tx.id), children: [tx.color && (_jsx("span", { className: 'mr-2 inline-block h-2 w-2 shrink-0 rounded-full', style: { backgroundColor: tx.color } })), stateById.get(tx.to_state)?.label ?? tx.to_state] }, tx.id))) })] }, label));
        });
    };
    const confirmForm = (_jsxs("div", { className: 'space-y-3 rounded-lg border border-slate-200 bg-slate-50 p-3.5', children: [_jsxs("div", { className: 'flex flex-wrap items-center gap-2', children: [_jsx("span", { className: 'text-[11px] font-semibold text-slate-400', children: "Confirming" }), pendingTx && (_jsx("span", { className: 'text-[12px] font-medium text-slate-700', children: pendingTx.label })), currentState && pendingToState && (_jsxs("div", { className: 'ml-auto flex items-center gap-1.5', children: [_jsx(StateBadge, { label: currentState.label, color: currentState.color, small: true }), _jsx(ArrowRight, { className: 'h-3 w-3 shrink-0 text-slate-300' }), _jsx(StateBadge, { label: pendingToState.label, color: pendingToState.color, small: true })] }))] }), _jsx("input", { type: 'text', value: comment, onChange: (e) => setComment(e.target.value), placeholder: 'Add a comment (optional)', className: 'w-full rounded-md border border-slate-200 bg-white px-3 py-1.5 text-[13px] placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-nvr-cyan/30' }), _jsxs("div", { className: 'flex items-center justify-end gap-2', children: [_jsx(Button, { type: 'button', size: 'sm', variant: 'ghost', className: 'h-7 text-[12px]', onClick: () => setPendingTransition(null), children: "Cancel" }), _jsx(Button, { type: 'button', size: 'sm', className: 'h-7 gap-1.5 text-[12px]', disabled: executeTransition.isPending, onClick: () => executeTransition.mutate({
                            transition_id: pendingTransition,
                            comment: comment.trim() || undefined
                        }), children: executeTransition.isPending ? (_jsx(Loader2, { className: 'h-3.5 w-3.5 animate-spin' })) : (_jsxs(_Fragment, { children: [_jsx("span", { children: "Confirm" }), _jsx(Check, { className: 'h-3 w-3' })] })) })] })] }));
    return (_jsxs("div", { className: 'overflow-hidden rounded-xl border border-slate-200 bg-white', children: [_jsxs("div", { className: 'flex items-center gap-3 px-4 py-2.5', children: [_jsx(GitBranch, { className: 'h-3.5 w-3.5 shrink-0 text-slate-400' }), _jsx("span", { className: 'text-[12px] font-semibold text-slate-500', children: title || 'Pipeline' }), _jsxs("div", { className: 'flex items-center gap-1.5', children: [instance?.completed_at && (_jsxs("span", { className: 'flex items-center gap-1 text-[11px] font-medium text-emerald-600', children: [_jsx(CheckCircle2, { className: 'h-3.5 w-3.5' }), "Completed"] })), currentState && _jsx(StateBadge, { label: currentState.label, color: currentState.color })] }), !expanded && hasTransitions && (_jsx("div", { className: 'flex flex-wrap items-center gap-1.5', children: renderTransitionButtons(transitions, true) })), !expanded && !instance && data?.binding && (_jsxs(Button, { size: 'sm', variant: 'outline', className: 'h-7 gap-1.5 text-[11px]', onClick: () => startPipeline.mutate(), disabled: startPipeline.isPending, children: [startPipeline.isPending ? (_jsx(Loader2, { className: 'h-3 w-3 animate-spin' })) : (_jsx(GitBranch, { className: 'h-3 w-3' })), "Start"] })), _jsx("button", { type: 'button', onClick: () => setExpanded((v) => !v), className: 'ml-auto rounded p-1 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-600', children: _jsx(ChevronDown, { className: cn('h-3.5 w-3.5 transition-transform duration-150', expanded && 'rotate-180') }) })] }), !expanded && pendingTransition && (_jsx("div", { className: 'border-t border-slate-100 px-4 py-3', children: confirmForm })), expanded && (_jsx("div", { className: 'border-t border-slate-100', children: !instance ? (_jsxs("div", { className: 'flex items-center justify-between gap-4 px-5 py-4', children: [_jsx("p", { className: 'text-[13px] text-slate-500', children: "Pipeline not started for this record." }), _jsxs(Button, { size: 'sm', variant: 'outline', className: 'shrink-0 gap-1.5 text-[12px]', onClick: () => startPipeline.mutate(), disabled: startPipeline.isPending, children: [startPipeline.isPending ? (_jsx(Loader2, { className: 'h-3.5 w-3.5 animate-spin' })) : (_jsx(GitBranch, { className: 'h-3.5 w-3.5' })), "Start Pipeline"] })] })) : (_jsxs("div", { className: 'divide-y divide-slate-100', children: [(states ?? []).length > 1 && (_jsx("div", { className: 'px-5 py-4', children: _jsx(StateTrack, { states: states, allTransitions: data?.all_transitions ?? [], availableTransitions: transitions ?? [], currentStateId: instance.current_state, history: history ?? [] }) })), _jsx("div", { className: 'px-5 py-4', children: _jsx(OwnersSection, { collection: collection, item: item, states: states ?? [] }) }), hasTransitions && (_jsxs("div", { className: 'space-y-3 px-5 py-4', children: [_jsx("div", { className: 'flex flex-wrap gap-2', children: renderTransitionButtons(transitions) }), pendingTransition && confirmForm] })), _jsxs("div", { className: 'px-5 py-3', children: [_jsxs("button", { type: 'button', className: 'flex items-center gap-1.5 text-[12px] text-slate-400 transition-colors hover:text-slate-600', onClick: () => setShowHistory((v) => !v), children: [showHistory ? (_jsx(ChevronDown, { className: 'h-3.5 w-3.5' })) : (_jsx(ChevronRight, { className: 'h-3.5 w-3.5' })), "Transition history ", _jsxs("span", { className: 'tabular-nums', children: ["(", history?.length ?? 0, ")"] })] }), showHistory && (_jsx("div", { className: 'mt-3', children: _jsx(HistoryTimeline, { history: history ?? [] }) }))] })] })) }))] }));
}
// ─── Transition buttons (for use next to Save button) ────────────────────────
export function PipelineTransitionButtons({ collection, item, onBeforeTransition }) {
    if (item === 'new')
        return null;
    return (_jsx(PipelineTransitionButtonsInner, { collection: collection, item: item, onBeforeTransition: onBeforeTransition }));
}
function PipelineTransitionButtonsInner({ collection, item, onBeforeTransition }) {
    const client = useNivaroClient();
    const queryClient = useQueryClient();
    const [comment, setComment] = useState('');
    const [pendingTransition, setPendingTransition] = useState(null);
    const trySetPending = (txId) => {
        if (pendingTransition === txId) {
            setPendingTransition(null);
            return;
        }
        if (onBeforeTransition && !onBeforeTransition())
            return;
        setPendingTransition(txId);
    };
    const queryKey = ['pipeline-instance', collection, item];
    const { data } = useQuery({
        queryKey,
        queryFn: () => client
            .request(get(`/pipelines/instance/${collection}/${item}`))
            .then((r) => r.data ?? {
            instance: null,
            states: [],
            available_transitions: [],
            all_transitions: [],
            history: [],
            binding: null
        }),
        staleTime: 10_000
    });
    const executeTransition = useMutation({
        mutationFn: ({ transition_id, comment }) => client.request(post(`/pipelines/instance/${collection}/${item}/transition`, { transition_id, comment })),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey });
            setComment('');
            setPendingTransition(null);
            toast.success('Transition executed');
        },
        onError: (err) => {
            const resp = err?.response;
            toast.error(resp?.data?.error ?? 'Failed to execute transition');
            if (resp?.status === 409) {
                queryClient.invalidateQueries({ queryKey });
                setPendingTransition(null);
            }
        }
    });
    if (!data?.binding || !data?.instance || data.instance.completed_at)
        return null;
    const transitions = data.available_transitions ?? [];
    if (transitions.length === 0)
        return null;
    const stateById = new Map((data.states ?? []).map((s) => [s.id, s]));
    const currentState = data.instance.current_state_obj ?? null;
    const pendingTx = pendingTransition ? transitions.find((t) => t.id === pendingTransition) : null;
    const pendingToState = pendingTx ? stateById.get(pendingTx.to_state) : null;
    const byLabel = new Map();
    for (const tx of transitions) {
        const l = byLabel.get(tx.label) ?? [];
        l.push(tx);
        byLabel.set(tx.label, l);
    }
    return (_jsxs("div", { className: 'space-y-2', children: [_jsx("div", { className: 'flex flex-wrap gap-2', children: Array.from(byLabel.entries()).map(([label, txs]) => {
                    const txColor = txs[0]?.color ?? null;
                    const isActive = txs.some((t) => t.id === pendingTransition);
                    const colorStyle = (active) => txColor
                        ? active
                            ? { backgroundColor: txColor, borderColor: txColor }
                            : { borderColor: txColor, color: txColor }
                        : undefined;
                    if (txs.length === 1) {
                        const tx = txs[0];
                        return (_jsx(Button, { size: 'sm', variant: isActive ? 'default' : 'outline', className: 'gap-1.5 text-[12px]', style: colorStyle(isActive), onClick: () => trySetPending(tx.id), children: label }, label));
                    }
                    return (_jsxs(DropdownMenu, { children: [_jsx(DropdownMenuTrigger, { asChild: true, children: _jsxs(Button, { size: 'sm', variant: isActive ? 'default' : 'outline', className: 'gap-1.5 text-[12px]', style: colorStyle(isActive), children: [label, _jsx(ChevronDown, { className: 'h-3 w-3' })] }) }), _jsx(DropdownMenuContent, { align: 'start', children: [...txs]
                                    .sort((a, b) => (stateById.get(a.to_state)?.sort ?? 999) -
                                    (stateById.get(b.to_state)?.sort ?? 999))
                                    .map((tx) => (_jsxs(DropdownMenuItem, { onSelect: () => trySetPending(tx.id), children: [tx.color && (_jsx("span", { className: 'mr-2 inline-block h-2 w-2 shrink-0 rounded-full', style: { backgroundColor: tx.color } })), stateById.get(tx.to_state)?.label ?? tx.to_state] }, tx.id))) })] }, label));
                }) }), pendingTransition && (_jsxs("div", { className: 'space-y-3 rounded-lg border border-slate-200 bg-slate-50 p-3.5', children: [_jsxs("div", { className: 'flex flex-wrap items-center gap-2', children: [_jsx("span", { className: 'text-[11px] font-semibold text-slate-400', children: "Confirming" }), pendingTx && (_jsx("span", { className: 'text-[12px] font-medium text-slate-700', children: pendingTx.label })), currentState && pendingToState && (_jsxs("div", { className: 'ml-auto flex items-center gap-1.5', children: [_jsx(StateBadge, { label: currentState.label, color: currentState.color, small: true }), _jsx(ArrowRight, { className: 'h-3 w-3 shrink-0 text-slate-300' }), _jsx(StateBadge, { label: pendingToState.label, color: pendingToState.color, small: true })] }))] }), _jsx("input", { type: 'text', value: comment, onChange: (e) => setComment(e.target.value), placeholder: 'Add a comment (optional)', className: 'w-full rounded-md border border-slate-200 bg-white px-3 py-1.5 text-[13px] placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-nvr-cyan/30' }), _jsxs("div", { className: 'flex items-center justify-end gap-2', children: [_jsx(Button, { type: 'button', size: 'sm', variant: 'ghost', className: 'h-7 text-[12px]', onClick: () => setPendingTransition(null), children: "Cancel" }), _jsx(Button, { type: 'button', size: 'sm', className: 'h-7 gap-1.5 text-[12px]', disabled: executeTransition.isPending, onClick: () => executeTransition.mutate({
                                    transition_id: pendingTransition,
                                    comment: comment.trim() || undefined
                                }), children: executeTransition.isPending ? (_jsx(Loader2, { className: 'h-3.5 w-3.5 animate-spin' })) : (_jsxs(_Fragment, { children: [_jsx("span", { children: "Confirm" }), _jsx(Check, { className: 'h-3 w-3' })] })) })] })] }))] }));
}
//# sourceMappingURL=PipelinePanel.js.map