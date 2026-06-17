import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useCallback, useEffect, useRef, useState } from 'react';
import { useOptionalNivaroClient } from '../../context';
import { del, get, patch, post } from '../../lib/commands';
function initials(u) {
    return ([u.first_name?.[0], u.last_name?.[0]].filter(Boolean).join('').toUpperCase() ||
        u.email?.[0]?.toUpperCase() ||
        '?');
}
function displayName(u) {
    return [u.first_name, u.last_name].filter(Boolean).join(' ') || u.email;
}
function relativeTime(iso) {
    const diff = Date.now() - new Date(iso).getTime();
    const m = Math.floor(diff / 60000);
    if (m < 1)
        return 'just now';
    if (m < 60)
        return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24)
        return `${h}h ago`;
    return `${Math.floor(h / 24)}d ago`;
}
export function CommentsSlot({ collection, itemId, labelOverride, defaultExpanded }) {
    const client = useOptionalNivaroClient();
    const [open, setOpen] = useState(false);
    const [comments, setComments] = useState([]);
    const [loading, setLoading] = useState(false);
    const [draft, setDraft] = useState('');
    const [posting, setPosting] = useState(false);
    const [editingId, setEditingId] = useState(null);
    const [editText, setEditText] = useState('');
    const mountedRef = useRef(true);
    const syncedRef = useRef(false);
    useEffect(() => {
        mountedRef.current = true;
        return () => {
            mountedRef.current = false;
        };
    }, []);
    useEffect(() => {
        if (!syncedRef.current && defaultExpanded !== undefined) {
            syncedRef.current = true;
            setOpen(defaultExpanded);
        }
    }, [defaultExpanded]);
    const fetchComments = useCallback(async () => {
        if (!client || !itemId)
            return;
        setLoading(true);
        try {
            const res = await client.request(get('/comments', { collection, item: String(itemId) }));
            if (mountedRef.current)
                setComments(res.data ?? []);
        }
        catch {
            if (mountedRef.current)
                setComments([]);
        }
        finally {
            if (mountedRef.current)
                setLoading(false);
        }
    }, [client, collection, itemId]);
    useEffect(() => {
        void fetchComments();
    }, [fetchComments]);
    async function postComment(e) {
        e.preventDefault();
        if (!client || !draft.trim() || posting)
            return;
        setPosting(true);
        try {
            await client.request(post('/comments', { collection, item: String(itemId), text: draft.trim() }));
            setDraft('');
            await fetchComments();
        }
        catch {
            /* no-op */
        }
        finally {
            if (mountedRef.current)
                setPosting(false);
        }
    }
    async function saveEdit(id) {
        if (!client || !editText.trim())
            return;
        try {
            await client.request(patch(`/comments/${id}`, { text: editText.trim() }));
            setEditingId(null);
            setEditText('');
            await fetchComments();
        }
        catch {
            /* no-op */
        }
    }
    async function deleteComment(id) {
        if (!client)
            return;
        try {
            await client.request(del(`/comments/${id}`));
            await fetchComments();
        }
        catch {
            /* no-op */
        }
    }
    return (_jsxs("div", { "data-nf-slot": '__comments__', "data-nf-slot-open": open ? 'true' : 'false', children: [_jsxs("button", { type: 'button', onClick: () => setOpen((v) => !v), "data-nf-slot-toggle": true, children: [_jsx("svg", { "data-nf-slot-icon": true, width: '14', height: '14', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: '2', strokeLinecap: 'round', strokeLinejoin: 'round', "aria-hidden": 'true', children: _jsx("path", { d: 'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z' }) }), _jsx("span", { "data-nf-slot-label": true, children: labelOverride ?? 'Comments' }), !open && comments.length > 0 && (_jsxs("span", { "data-nf-slot-count": true, children: [comments.length, " comment", comments.length !== 1 ? 's' : ''] })), _jsx("svg", { "data-nf-slot-chevron": true, width: '14', height: '14', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: '2', strokeLinecap: 'round', strokeLinejoin: 'round', style: { transform: open ? 'rotate(180deg)' : undefined }, "aria-hidden": 'true', children: _jsx("polyline", { points: '6 9 12 15 18 9' }) })] }), open && (_jsxs("div", { "data-nf-slot-content": true, children: [_jsxs("form", { onSubmit: (e) => void postComment(e), "data-nf-comment-form": true, children: [_jsx("textarea", { value: draft, onChange: (e) => setDraft(e.target.value), placeholder: 'Write a comment\u2026', rows: 3, "data-nf-comment-textarea": true }), _jsxs("div", { "data-nf-comment-form-footer": true, children: [_jsx("span", { "data-nf-comment-hint": true, children: "Use @ to mention a teammate." }), _jsx("button", { type: 'submit', "data-nf-btn-primary": true, disabled: !draft.trim() || posting, children: posting ? 'Posting…' : 'Comment' })] })] }), _jsx("div", { "data-nf-divider": true }), loading ? (_jsx("div", { "data-nf-comment-list": true, children: [0, 1].map((i) => (_jsxs("div", { "data-nf-comment-skeleton": true, children: [_jsx("div", { "data-nf-skeleton-avatar": true }), _jsxs("div", { "data-nf-skeleton-lines": true, children: [_jsx("div", { "data-nf-skeleton-line": true, style: { width: '30%' } }), _jsx("div", { "data-nf-skeleton-line": true, style: { width: '100%' } })] })] }, i))) })) : comments.length === 0 ? (_jsx("p", { "data-nf-empty": true, children: "No comments yet." })) : (_jsx("div", { "data-nf-comment-list": true, children: comments.map((c) => {
                            const isEditing = editingId === c.id;
                            const edited = c.updated_at && c.updated_at !== c.created_at;
                            return (_jsxs("div", { "data-nf-comment": true, children: [_jsx("div", { "data-nf-avatar": true, children: initials(c.user) }), _jsxs("div", { "data-nf-comment-body": true, children: [_jsxs("div", { "data-nf-comment-header": true, children: [_jsx("span", { "data-nf-comment-author": true, children: displayName(c.user) }), _jsx("span", { "data-nf-comment-time": true, children: relativeTime(c.created_at) }), edited && _jsx("span", { "data-nf-comment-edited": true, children: "(edited)" }), _jsx("div", { "data-nf-comment-actions": true, children: !isEditing && (_jsxs(_Fragment, { children: [_jsx("button", { type: 'button', "data-nf-icon-btn": true, title: 'Edit', onClick: () => {
                                                                        setEditingId(c.id);
                                                                        setEditText(c.text);
                                                                    }, children: _jsxs("svg", { width: '12', height: '12', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: '2', strokeLinecap: 'round', strokeLinejoin: 'round', "aria-hidden": 'true', children: [_jsx("path", { d: 'M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7' }), _jsx("path", { d: 'M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z' })] }) }), _jsx("button", { type: 'button', "data-nf-icon-btn": true, "data-nf-icon-btn-danger": true, title: 'Delete', onClick: () => void deleteComment(c.id), children: _jsxs("svg", { width: '12', height: '12', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: '2', strokeLinecap: 'round', strokeLinejoin: 'round', "aria-hidden": 'true', children: [_jsx("polyline", { points: '3 6 5 6 21 6' }), _jsx("path", { d: 'M19 6l-1 14H6L5 6' }), _jsx("path", { d: 'M10 11v6M14 11v6M9 6V4h6v2' })] }) })] })) })] }), isEditing ? (_jsxs("div", { "data-nf-comment-edit": true, children: [_jsx("textarea", { value: editText, onChange: (e) => setEditText(e.target.value), rows: 3, "data-nf-comment-textarea": true }), _jsxs("div", { "data-nf-confirm-actions": true, children: [_jsx("button", { type: 'button', "data-nf-btn-primary": true, disabled: !editText.trim(), onClick: () => void saveEdit(c.id), children: "\u2713 Save" }), _jsx("button", { type: 'button', "data-nf-btn-ghost": true, onClick: () => {
                                                                    setEditingId(null);
                                                                    setEditText('');
                                                                }, children: "\u2715 Cancel" })] })] })) : (_jsx("p", { "data-nf-comment-text": true, children: c.text }))] })] }, c.id));
                        }) }))] }))] }));
}
//# sourceMappingURL=CommentsSlot.js.map