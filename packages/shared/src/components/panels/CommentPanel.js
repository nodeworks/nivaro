import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, ChevronDown, MessageSquare, Pencil, Trash2, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { useItemEditAuth, useNivaroClient } from '../../context';
import { del, get, patch, post } from '../../lib/commands';
import { formatRelative } from '../../lib/utils';
import { Avatar, AvatarFallback } from '../ui/avatar';
import { Button } from '../ui/button';
import { Separator } from '../ui/separator';
import { Textarea } from '../ui/textarea';
function initials(u) {
    const i = [u.first_name?.[0], u.last_name?.[0]].filter(Boolean).join('').toUpperCase();
    return i || u.email?.[0]?.toUpperCase() || '?';
}
function displayName(u) {
    return [u.first_name, u.last_name].filter(Boolean).join(' ') || u.email;
}
export function CommentPanel({ collection, item, title, defaultExpanded }) {
    const client = useNivaroClient();
    const { userId } = useItemEditAuth();
    const queryClient = useQueryClient();
    const [expanded, setExpanded] = useState(false);
    const syncedFromProp = useRef(false);
    useEffect(() => {
        if (!syncedFromProp.current && defaultExpanded !== undefined) {
            syncedFromProp.current = true;
            setExpanded(defaultExpanded);
        }
    }, [defaultExpanded]);
    const [draft, setDraft] = useState('');
    const [editingId, setEditingId] = useState(null);
    const [editText, setEditText] = useState('');
    const queryKey = ['comments', collection, String(item)];
    const { data, isLoading, isError } = useQuery({
        queryKey,
        queryFn: () => client
            .request(get('/comments', { collection, item }))
            .then((r) => r.data)
    });
    const comments = data ?? [];
    const create = useMutation({
        mutationFn: (text) => client.request(post('/comments', { collection, item, text })),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey });
            setDraft('');
        },
        onError: () => toast.error('Failed to post comment')
    });
    const update = useMutation({
        mutationFn: ({ id, text }) => client.request(patch(`/comments/${id}`, { text })),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey });
            setEditingId(null);
            setEditText('');
        },
        onError: () => toast.error('Failed to update comment')
    });
    const remove = useMutation({
        mutationFn: (id) => client.request(del(`/comments/${id}`)),
        onSuccess: () => queryClient.invalidateQueries({ queryKey }),
        onError: () => toast.error('Failed to delete comment')
    });
    function handleSubmit(e) {
        e.preventDefault();
        if (!draft.trim())
            return;
        create.mutate(draft.trim());
    }
    return (_jsxs("div", { className: 'overflow-hidden rounded-xl border border-slate-200 bg-white', children: [_jsxs("button", { type: 'button', onClick: () => setExpanded((v) => !v), className: 'flex w-full items-center gap-2 px-4 py-2.5', children: [_jsx(MessageSquare, { className: 'h-3.5 w-3.5 shrink-0 text-slate-400' }), _jsx("span", { className: 'text-[12px] font-semibold text-slate-500', children: title || 'Comments' }), !expanded && comments.length > 0 && (_jsxs("span", { className: 'ml-1 text-[11px] text-slate-400', children: [comments.length, " comment", comments.length !== 1 ? 's' : ''] })), _jsx(ChevronDown, { className: `ml-auto h-3.5 w-3.5 shrink-0 text-slate-400 transition-transform duration-150${expanded ? ' rotate-180' : ''}` })] }), expanded && (_jsxs("div", { className: 'border-t border-slate-100 p-6', children: [_jsxs("form", { onSubmit: handleSubmit, className: 'space-y-2', children: [_jsx(Textarea, { value: draft, onChange: (e) => setDraft(e.target.value), placeholder: 'Write a comment\u2026', rows: 3, className: 'text-[13px]' }), _jsxs("div", { className: 'flex items-center justify-between', children: [_jsx("p", { className: 'text-[11px] text-slate-400', children: "Use @ to mention a teammate." }), _jsx(Button, { type: 'submit', size: 'sm', disabled: !draft.trim() || create.isPending, children: create.isPending ? 'Posting…' : 'Comment' })] })] }), _jsx(Separator, { className: 'my-4' }), isLoading ? (_jsx("div", { className: 'space-y-4', children: ['a', 'b'].map((k) => (_jsxs("div", { className: 'flex gap-3', children: [_jsx("div", { className: 'h-8 w-8 shrink-0 animate-pulse rounded-full bg-slate-100' }), _jsxs("div", { className: 'flex-1 space-y-1.5', children: [_jsx("div", { className: 'h-3 w-32 animate-pulse rounded bg-slate-100' }), _jsx("div", { className: 'h-3 w-full animate-pulse rounded bg-slate-100' })] })] }, k))) })) : isError ? (_jsx("p", { className: 'py-6 text-center text-[12px] text-red-500', children: "Failed to load comments." })) : comments.length === 0 ? (_jsx("p", { className: 'py-6 text-center text-[12px] text-slate-400', children: "No comments yet." })) : (_jsx("div", { className: 'space-y-4', children: comments.map((c) => {
                            const isOwn = userId === c.user.id;
                            const isEditing = editingId === c.id;
                            return (_jsxs("div", { className: 'group flex gap-3', children: [_jsx(Avatar, { className: 'h-8 w-8 shrink-0', children: _jsx(AvatarFallback, { className: 'bg-nvr-cyan/15 text-[11px] font-bold text-nvr-navy', children: initials(c.user) }) }), _jsxs("div", { className: 'min-w-0 flex-1', children: [_jsxs("div", { className: 'flex items-center gap-2', children: [_jsx("span", { className: 'text-[13px] font-medium text-slate-800', children: displayName(c.user) }), _jsx("span", { className: 'text-[11px] text-slate-400', children: formatRelative(c.created_at) }), c.updated_at && c.updated_at !== c.created_at && (_jsx("span", { className: 'text-[10px] text-slate-300', children: "(edited)" })), isOwn && !isEditing && (_jsxs("div", { className: 'ml-auto flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100', children: [_jsx("button", { type: 'button', className: 'rounded p-1 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700', onClick: () => {
                                                                    setEditingId(c.id);
                                                                    setEditText(c.text);
                                                                }, children: _jsx(Pencil, { className: 'h-3 w-3' }) }), _jsx("button", { type: 'button', className: 'rounded p-1 text-slate-400 transition-colors hover:bg-red-50 hover:text-red-500', onClick: () => remove.mutate(c.id), children: _jsx(Trash2, { className: 'h-3 w-3' }) })] }))] }), isEditing ? (_jsxs("div", { className: 'mt-1.5 space-y-2', children: [_jsx(Textarea, { value: editText, onChange: (e) => setEditText(e.target.value), rows: 3, className: 'text-[13px]' }), _jsxs("div", { className: 'flex items-center gap-1.5', children: [_jsxs(Button, { size: 'sm', className: 'h-7 gap-1.5', disabled: !editText.trim() || update.isPending, onClick: () => update.mutate({ id: c.id, text: editText.trim() }), children: [_jsx(Check, { className: 'h-3 w-3' }), " Save"] }), _jsxs(Button, { size: 'sm', variant: 'outline', className: 'h-7 gap-1.5', onClick: () => {
                                                                    setEditingId(null);
                                                                    setEditText('');
                                                                }, children: [_jsx(X, { className: 'h-3 w-3' }), " Cancel"] })] })] })) : (_jsx("p", { className: 'mt-0.5 whitespace-pre-wrap text-[13px] leading-relaxed text-slate-600', children: c.text }))] })] }, c.id));
                        }) }))] }))] }));
}
//# sourceMappingURL=CommentPanel.js.map