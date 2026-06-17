import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useCallback, useEffect, useRef, useState } from 'react';
import { useOptionalNivaroClient } from '../../context';
import { get, post } from '../../lib/commands';
import { HistoryTimeline } from './pipeline/HistoryTimeline';
import { OwnersSection } from './pipeline/OwnersSection';
import { StateBadge } from './pipeline/StateBadge';
import { StateTrack } from './pipeline/StateTrack';
export function PipelineSlot({ collection, itemId, labelOverride, defaultExpanded }) {
    const client = useOptionalNivaroClient();
    const [open, setOpen] = useState(false);
    const [data, setData] = useState(null);
    const [comment, setComment] = useState('');
    const [pendingId, setPendingId] = useState(null);
    const [acting, setActing] = useState(false);
    const [showHistory, setShowHistory] = useState(false);
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
    const fetchData = useCallback(async () => {
        if (!client || !itemId)
            return;
        try {
            const res = await client.request(get(`/pipelines/instance/${collection}/${itemId}`));
            if (mountedRef.current)
                setData(res.data ?? null);
        }
        catch {
            if (mountedRef.current)
                setData(null);
        }
    }, [client, collection, itemId]);
    useEffect(() => {
        void fetchData();
    }, [fetchData]);
    if (!data?.binding)
        return null;
    const instance = data.instance;
    const currentState = instance?.current_state_obj ?? null;
    const transitions = data.available_transitions ?? [];
    const stateById = new Map((data.states ?? []).map((s) => [s.id, s]));
    const hasTransitions = !instance?.completed_at && transitions.length > 0;
    const pendingTx = pendingId ? transitions.find((t) => t.id === pendingId) : null;
    const pendingToState = pendingTx ? stateById.get(pendingTx.to_state) : null;
    const byLabel = new Map();
    for (const tx of transitions) {
        const list = byLabel.get(tx.label) ?? [];
        list.push(tx);
        byLabel.set(tx.label, list);
    }
    async function startWorkflow() {
        if (!client || !itemId || acting)
            return;
        setActing(true);
        try {
            await client.request(post(`/pipelines/instance/${collection}/${itemId}/start`));
            await fetchData();
        }
        catch {
            /* no-op */
        }
        finally {
            if (mountedRef.current)
                setActing(false);
        }
    }
    async function doTransition(txId) {
        if (!client || !itemId || acting)
            return;
        setActing(true);
        try {
            await client.request(post(`/pipelines/instance/${collection}/${itemId}/transition`, {
                transition_id: txId,
                comment: comment.trim() || undefined
            }));
            setPendingId(null);
            setComment('');
            await fetchData();
        }
        catch {
            /* no-op */
        }
        finally {
            if (mountedRef.current)
                setActing(false);
        }
    }
    function trySetPending(txId) {
        setPendingId((prev) => (prev === txId ? null : txId));
    }
    return (_jsxs("div", { "data-nf-slot": '__pipeline__', "data-nf-slot-open": open ? 'true' : 'false', children: [_jsxs("button", { type: 'button', "data-nf-slot-toggle": true, onClick: () => setOpen((v) => !v), children: [_jsxs("svg", { "aria-hidden": 'true', "data-nf-slot-icon": true, width: '14', height: '14', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: '2', strokeLinecap: 'round', strokeLinejoin: 'round', children: [_jsx("line", { x1: '6', y1: '3', x2: '6', y2: '15' }), _jsx("circle", { cx: '18', cy: '6', r: '3' }), _jsx("circle", { cx: '6', cy: '18', r: '3' }), _jsx("path", { d: 'M18 9a9 9 0 0 1-9 9' })] }), _jsx("span", { "data-nf-slot-label": true, children: labelOverride ?? 'Progress' }), _jsxs("span", { "data-nf-slot-meta": true, children: [instance?.completed_at && _jsx("span", { "data-nf-slot-completed": true, children: "\u2713 Completed" }), currentState && _jsx(StateBadge, { label: currentState.label, color: currentState.color })] }), !open && hasTransitions && (_jsx("span", { "data-nf-slot-inline-actions": true, children: Array.from(byLabel.entries()).map(([label, txs]) => {
                            const txColor = txs[0]?.color ?? null;
                            const isActive = txs.some((t) => t.id === pendingId);
                            return (_jsx("button", { type: 'button', "data-nf-transition-btn": true, "data-active": isActive ? 'true' : 'false', style: txColor
                                    ? isActive
                                        ? { backgroundColor: txColor, borderColor: txColor, color: '#fff' }
                                        : { borderColor: txColor, color: txColor }
                                    : undefined, onClick: (e) => {
                                    e.stopPropagation();
                                    trySetPending(txs[0].id);
                                }, children: label }, label));
                        }) })), !open && !instance && data.binding && (_jsx("button", { type: 'button', "data-nf-start-btn": true, onClick: (e) => {
                            e.stopPropagation();
                            void startWorkflow();
                        }, disabled: acting, children: "Start" })), _jsx("svg", { "aria-hidden": 'true', "data-nf-slot-chevron": true, width: '14', height: '14', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: '2', strokeLinecap: 'round', strokeLinejoin: 'round', style: { transform: open ? 'rotate(180deg)' : undefined }, children: _jsx("polyline", { points: '6 9 12 15 18 9' }) })] }), !open && pendingId && (_jsxs("div", { "data-nf-slot-confirm": true, children: [_jsxs("div", { "data-nf-confirm-header": true, children: [_jsx("span", { "data-nf-confirm-label": true, children: "Confirming" }), pendingTx && _jsx("span", { "data-nf-confirm-name": true, children: pendingTx.label }), currentState && pendingToState && (_jsxs("span", { "data-nf-confirm-states": true, children: [_jsx(StateBadge, { label: currentState.label, color: currentState.color, small: true }), _jsx("svg", { "aria-hidden": 'true', width: '12', height: '12', viewBox: '0 0 12 12', fill: 'none', children: _jsx("path", { d: 'M2 6h8M7 3l3 3-3 3', stroke: '#cbd5e1', strokeWidth: '1.5', strokeLinecap: 'round', strokeLinejoin: 'round' }) }), _jsx(StateBadge, { label: pendingToState.label, color: pendingToState.color, small: true })] }))] }), _jsx("input", { type: 'text', value: comment, onChange: (e) => setComment(e.target.value), placeholder: 'Add a comment (optional)', "data-nf-confirm-input": true }), _jsxs("div", { "data-nf-confirm-actions": true, children: [_jsx("button", { type: 'button', "data-nf-btn-ghost": true, onClick: () => setPendingId(null), children: "Cancel" }), _jsx("button", { type: 'button', "data-nf-btn-primary": true, disabled: acting, onClick: () => void doTransition(pendingId), children: acting ? '…' : 'Confirm ✓' })] })] })), open && (_jsx("div", { "data-nf-slot-content": true, children: !instance ? (_jsxs("div", { "data-nf-pipeline-not-started": true, children: [_jsx("p", { children: "Pipeline not started for this record." }), _jsx("button", { type: 'button', "data-nf-btn-outline": true, disabled: acting, onClick: () => void startWorkflow(), children: acting ? '…' : 'Start Pipeline' })] })) : (_jsxs("div", { "data-nf-pipeline-body": true, children: [(data.states ?? []).length > 1 && (_jsx("div", { "data-nf-state-track-wrap": true, children: _jsx(StateTrack, { states: data.states, allTransitions: data.all_transitions ?? [], availableTransitions: transitions, currentStateId: instance.current_state, history: data.history ?? [] }) })), itemId && (_jsx("div", { "data-nf-pipeline-section": true, children: _jsx(OwnersSection, { collection: collection, itemId: itemId, states: data.states ?? [], client: client }) })), hasTransitions && (_jsxs("div", { "data-nf-transitions": true, "data-nf-pipeline-section": true, children: [_jsx("div", { "data-nf-transition-btns": true, children: Array.from(byLabel.entries()).map(([label, txs]) => {
                                        const txColor = txs[0]?.color ?? null;
                                        const isActive = txs.some((t) => t.id === pendingId);
                                        return (_jsx("button", { type: 'button', "data-nf-transition-btn": true, "data-active": isActive ? 'true' : 'false', style: txColor
                                                ? isActive
                                                    ? { backgroundColor: txColor, borderColor: txColor, color: '#fff' }
                                                    : { borderColor: txColor, color: txColor }
                                                : undefined, onClick: () => trySetPending(txs[0].id), children: label }, label));
                                    }) }), pendingId && pendingTx && (_jsxs("div", { "data-nf-confirm-box": true, children: [_jsxs("div", { "data-nf-confirm-header": true, children: [_jsx("span", { "data-nf-confirm-label": true, children: "Confirming" }), _jsx("span", { "data-nf-confirm-name": true, children: pendingTx.label }), currentState && pendingToState && (_jsxs("span", { "data-nf-confirm-states": true, children: [_jsx(StateBadge, { label: currentState.label, color: currentState.color, small: true }), _jsx("svg", { "aria-hidden": 'true', width: '12', height: '12', viewBox: '0 0 12 12', fill: 'none', children: _jsx("path", { d: 'M2 6h8M7 3l3 3-3 3', stroke: '#cbd5e1', strokeWidth: '1.5', strokeLinecap: 'round', strokeLinejoin: 'round' }) }), _jsx(StateBadge, { label: pendingToState.label, color: pendingToState.color, small: true })] }))] }), _jsx("input", { type: 'text', value: comment, onChange: (e) => setComment(e.target.value), placeholder: 'Add a comment (optional)', "data-nf-confirm-input": true }), _jsxs("div", { "data-nf-confirm-actions": true, children: [_jsx("button", { type: 'button', "data-nf-btn-ghost": true, onClick: () => setPendingId(null), children: "Cancel" }), _jsx("button", { type: 'button', "data-nf-btn-primary": true, disabled: acting, onClick: () => void doTransition(pendingId), children: acting ? '…' : 'Confirm ✓' })] })] }))] })), _jsxs("div", { "data-nf-pipeline-section": true, children: [_jsxs("button", { type: 'button', "data-nf-history-toggle": true, onClick: () => setShowHistory((v) => !v), children: [_jsx("svg", { "aria-hidden": 'true', width: '14', height: '14', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: '2', strokeLinecap: 'round', strokeLinejoin: 'round', style: { transform: showHistory ? 'rotate(90deg)' : undefined }, children: _jsx("polyline", { points: '9 18 15 12 9 6' }) }), "Transition history (", (data.history ?? []).length, ")"] }), showHistory && (_jsx("div", { "data-nf-history-body": true, children: _jsx(HistoryTimeline, { history: data.history ?? [] }) }))] })] })) }))] }));
}
//# sourceMappingURL=PipelineSlot.js.map