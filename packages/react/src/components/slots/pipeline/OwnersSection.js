import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useCallback, useEffect, useRef, useState } from 'react';
import { del, get, post } from '../../../lib/commands';
import { initials } from './HistoryTimeline';
export function OwnersSection({ collection, itemId, states, client }) {
    const [owners, setOwners] = useState([]);
    const [users, setUsers] = useState([]);
    const [loading, setLoading] = useState(true);
    const [adding, setAdding] = useState(false);
    const [userId, setUserId] = useState('');
    const [stateScope, setStateScope] = useState('');
    const [saving, setSaving] = useState(false);
    const mountedRef = useRef(true);
    useEffect(() => {
        mountedRef.current = true;
        return () => {
            mountedRef.current = false;
        };
    }, []);
    const fetchOwners = useCallback(async () => {
        if (!client)
            return;
        try {
            const res = await client.request(get(`/pipelines/instance/${collection}/${itemId}/owners`));
            if (mountedRef.current)
                setOwners(res.data ?? []);
        }
        catch {
            if (mountedRef.current)
                setOwners([]);
        }
        finally {
            if (mountedRef.current)
                setLoading(false);
        }
    }, [client, collection, itemId]);
    useEffect(() => {
        void fetchOwners();
    }, [fetchOwners]);
    useEffect(() => {
        if (!client)
            return;
        client
            .request(get('/users', { limit: 200, sort: 'first_name' }))
            .then((res) => {
            if (mountedRef.current)
                setUsers(res.data ?? []);
        })
            .catch(() => {
            /* no-op */
        });
    }, [client]);
    const stateLabelFor = (stateVal) => {
        if (!stateVal)
            return null;
        const s = states.find((s) => s.id === stateVal) ?? states.find((s) => s.key === stateVal);
        return s?.label ?? stateVal;
    };
    async function addOwner() {
        if (!client || !userId || saving)
            return;
        setSaving(true);
        try {
            await client.request(post(`/pipelines/instance/${collection}/${itemId}/owners`, {
                user: userId,
                state: stateScope || undefined
            }));
            setAdding(false);
            setUserId('');
            setStateScope('');
            await fetchOwners();
        }
        catch {
            /* no-op */
        }
        finally {
            if (mountedRef.current)
                setSaving(false);
        }
    }
    async function removeOwner(id) {
        if (!client)
            return;
        try {
            await client.request(del(`/pipelines/instance-owners/${id}`));
            await fetchOwners();
        }
        catch {
            /* no-op */
        }
    }
    return (_jsxs("div", { "data-nf-owners-section": true, children: [_jsxs("div", { "data-nf-owners-header": true, children: [_jsxs("span", { "data-nf-owners-title": true, children: [_jsxs("svg", { "aria-hidden": 'true', width: '13', height: '13', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: '2', strokeLinecap: 'round', strokeLinejoin: 'round', children: [_jsx("path", { d: 'M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2' }), _jsx("circle", { cx: '9', cy: '7', r: '4' }), _jsx("path", { d: 'M23 21v-2a4 4 0 0 0-3-3.87' }), _jsx("path", { d: 'M16 3.13a4 4 0 0 1 0 7.75' })] }), "Owners", loading ? (_jsx("span", { "data-nf-skeleton": true, style: { display: 'inline-block', width: 16, height: 10 } })) : (_jsxs("span", { "data-nf-owners-count": true, children: ["(", owners.length, ")"] }))] }), !adding && (_jsxs("button", { type: 'button', "data-nf-owners-add-btn": true, onClick: () => setAdding(true), children: [_jsxs("svg", { "aria-hidden": 'true', width: '12', height: '12', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: '2', strokeLinecap: 'round', strokeLinejoin: 'round', children: [_jsx("path", { d: 'M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2' }), _jsx("circle", { cx: '8.5', cy: '7', r: '4' }), _jsx("line", { x1: '20', y1: '8', x2: '20', y2: '14' }), _jsx("line", { x1: '23', y1: '11', x2: '17', y2: '11' })] }), "Add"] }))] }), loading ? (_jsxs("div", { "data-nf-owners-loading": true, children: [_jsx("span", { "data-nf-skeleton": true, style: { height: 28, display: 'block', borderRadius: 6, marginBottom: 6 } }), _jsx("span", { "data-nf-skeleton": true, style: { height: 28, width: '75%', display: 'block', borderRadius: 6 } })] })) : owners.length === 0 ? (_jsx("p", { "data-nf-empty": true, children: "No owners assigned." })) : (_jsx("div", { "data-nf-owner-list": true, children: owners.map((o) => (_jsxs("div", { "data-nf-owner-row": true, children: [_jsx("span", { "data-nf-owner-avatar": true, children: initials(o.first_name, o.last_name, o.email) }), _jsxs("div", { "data-nf-owner-info": true, children: [_jsx("span", { "data-nf-owner-name": true, children: [o.first_name, o.last_name].filter(Boolean).join(' ') || o.email }), _jsx("span", { "data-nf-owner-email": true, children: o.email })] }), _jsx("span", { "data-nf-owner-scope": true, children: o.state ? stateLabelFor(o.state) : 'all states' }), _jsx("button", { type: 'button', "data-nf-icon-btn": true, "data-nf-icon-btn-danger": true, title: 'Remove', onClick: () => void removeOwner(o.id), children: _jsxs("svg", { "aria-hidden": 'true', width: '12', height: '12', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: '2', strokeLinecap: 'round', strokeLinejoin: 'round', children: [_jsx("line", { x1: '18', y1: '6', x2: '6', y2: '18' }), _jsx("line", { x1: '6', y1: '6', x2: '18', y2: '18' })] }) })] }, o.id))) })), adding && (_jsxs("div", { "data-nf-owners-form": true, children: [_jsx("p", { "data-nf-owners-form-title": true, children: "Add owner" }), _jsxs("select", { value: userId, onChange: (e) => setUserId(e.target.value), "data-nf-task-input": true, children: [_jsx("option", { value: '', children: "Select a user\u2026" }), users.map((u) => {
                                const name = [u.first_name, u.last_name].filter(Boolean).join(' ') || u.email;
                                return (_jsx("option", { value: u.id, children: name }, u.id));
                            })] }), _jsxs("select", { value: stateScope, onChange: (e) => setStateScope(e.target.value), "data-nf-task-input": true, children: [_jsx("option", { value: '', children: "All states" }), states.map((s) => (_jsx("option", { value: s.id, children: s.label }, s.id)))] }), _jsxs("div", { "data-nf-confirm-actions": true, children: [_jsx("button", { type: 'button', "data-nf-btn-ghost": true, onClick: () => {
                                    setAdding(false);
                                    setUserId('');
                                    setStateScope('');
                                }, children: "Cancel" }), _jsx("button", { type: 'button', "data-nf-btn-primary": true, disabled: !userId || saving, onClick: () => void addOwner(), children: saving ? '…' : 'Add' })] })] }))] }));
}
//# sourceMappingURL=OwnersSection.js.map