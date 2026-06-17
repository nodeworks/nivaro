import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useState } from 'react';
import { createPortal } from 'react-dom';
import { initials, relFmt } from './HistoryTimeline';
export function StateTrack({ states, allTransitions, availableTransitions, currentStateId, history }) {
    const [tooltip, setTooltip] = useState(null);
    const visitedIds = new Set(history.map((h) => h.to_state));
    const relevant = (() => {
        if (allTransitions.length === 0) {
            const show = new Set([...visitedIds]);
            if (currentStateId)
                show.add(currentStateId);
            return states.filter((s) => show.has(s.id)).sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0));
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
        if (currentStateId) {
            fwd.set(currentStateId, availableTransitions.map((t) => t.to_state));
        }
        const pathIds = new Set();
        const queue = states.filter((s) => s.is_initial).map((s) => s.id);
        while (queue.length) {
            const id = queue.shift();
            if (pathIds.has(id))
                continue;
            pathIds.add(id);
            for (const next of fwd.get(id) ?? []) {
                if (!pathIds.has(next))
                    queue.push(next);
            }
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
            .sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0));
    })();
    if (relevant.length < 2)
        return null;
    function edgeEntries(fromId, toId) {
        return [...history]
            .filter((h) => (h.from_state === fromId && h.to_state === toId) ||
            (h.from_state === toId && h.to_state === fromId))
            .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
    }
    return (_jsxs(_Fragment, { children: [tooltip &&
                createPortal(_jsxs("div", { style: {
                        position: 'fixed',
                        top: tooltip.top,
                        left: tooltip.left,
                        transform: 'translateX(-50%) translateY(calc(-100% - 8px))',
                        zIndex: 99999,
                        background: 'white',
                        borderRadius: 6,
                        padding: '6px 10px',
                        pointerEvents: 'none',
                        boxShadow: '0 4px 16px rgba(0,0,0,0.12), 0 0 0 1px rgba(0,0,0,0.08)',
                        whiteSpace: 'nowrap'
                    }, children: [_jsx("div", { style: { fontSize: 12, fontWeight: 500, color: '#1e293b', lineHeight: 1.4 }, children: tooltip.line1 }), _jsx("div", { style: { fontSize: 11, color: '#64748b', lineHeight: 1.4, marginTop: 1 }, children: tooltip.line2 })] }), document.body), _jsx("div", { style: { overflowX: 'auto', paddingTop: 6, paddingBottom: 4 }, children: _jsx("div", { style: { display: 'flex', width: '100%', alignItems: 'flex-start' }, children: relevant.map((s, i) => {
                        const isCurrent = s.id === currentStateId;
                        const isVisited = visitedIds.has(s.id);
                        const isDone = isVisited && !isCurrent;
                        const nodeColor = s.color ?? '#94a3b8';
                        const isLast = i === relevant.length - 1;
                        const nextState = !isLast ? relevant[i + 1] : null;
                        const edge = nextState ? edgeEntries(s.id, nextState.id) : [];
                        return (_jsxs("div", { style: { display: 'flex', minWidth: 48, flex: 1, alignItems: 'flex-start' }, children: [_jsxs("div", { style: {
                                        display: 'flex',
                                        flex: 1,
                                        minWidth: 0,
                                        flexDirection: 'column',
                                        alignItems: 'center',
                                        gap: 6,
                                        padding: '0 4px'
                                    }, children: [_jsx("div", { style: {
                                                display: 'flex',
                                                alignItems: 'center',
                                                justifyContent: 'center',
                                                width: 28,
                                                height: 28,
                                                borderRadius: '50%',
                                                flexShrink: 0,
                                                backgroundColor: isCurrent || isDone ? nodeColor : '#f1f5f9',
                                                border: isCurrent || isDone ? 'none' : '1.5px solid #e2e8f0',
                                                boxShadow: isCurrent ? `0 0 0 3px white, 0 0 0 5px ${nodeColor}` : undefined
                                            }, children: isDone ? (_jsx("svg", { "aria-hidden": 'true', width: '12', height: '12', viewBox: '0 0 24 24', fill: 'none', stroke: 'white', strokeWidth: '3', strokeLinecap: 'round', strokeLinejoin: 'round', children: _jsx("polyline", { points: '20 6 9 17 4 12' }) })) : isCurrent ? (_jsx("div", { style: {
                                                    width: 10,
                                                    height: 10,
                                                    borderRadius: '50%',
                                                    backgroundColor: 'rgba(255,255,255,0.8)'
                                                } })) : (_jsx("div", { style: {
                                                    width: 8,
                                                    height: 8,
                                                    borderRadius: '50%',
                                                    backgroundColor: '#cbd5e1'
                                                } })) }), _jsx("span", { style: {
                                                fontSize: 11,
                                                color: isCurrent ? nodeColor : isDone ? '#475569' : '#94a3b8',
                                                fontWeight: isCurrent ? 600 : isDone ? 500 : 400,
                                                textAlign: 'center',
                                                wordBreak: 'break-word',
                                                lineHeight: 1.3,
                                                width: '100%'
                                            }, children: s.label })] }), !isLast && (_jsxs("div", { style: {
                                        marginTop: 13,
                                        width: 40,
                                        flexShrink: 0,
                                        display: 'flex',
                                        flexDirection: 'column',
                                        alignItems: 'center',
                                        gap: 4
                                    }, children: [_jsxs("div", { style: {
                                                display: 'flex',
                                                width: '100%',
                                                flexShrink: 0,
                                                alignItems: 'center'
                                            }, children: [_jsx("div", { style: {
                                                        height: 2,
                                                        flex: 1,
                                                        backgroundColor: isDone ? `${nodeColor}55` : '#e8ecf0',
                                                        borderRadius: 2
                                                    } }), _jsx("div", { style: {
                                                        width: 0,
                                                        height: 0,
                                                        borderTop: '3px solid transparent',
                                                        borderBottom: '3px solid transparent',
                                                        borderLeft: `5px solid ${isDone ? `${nodeColor}55` : '#e8ecf0'}`
                                                    } })] }), edge.map((h) => {
                                            const isSendback = h.from_state !== s.id;
                                            const ini = initials(h.first_name, h.last_name, h.user_email);
                                            const rel = relFmt(h.timestamp);
                                            const name = [h.first_name, h.last_name].filter(Boolean).join(' ') ||
                                                h.user_email ||
                                                'System';
                                            const fullTs = new Date(h.timestamp).toLocaleString();
                                            return (_jsxs("div", { role: 'img', "aria-label": `${isSendback ? 'Sent back by' : 'Approved by'} ${name} at ${fullTs}`, style: {
                                                    display: 'flex',
                                                    flexDirection: 'column',
                                                    alignItems: 'center',
                                                    gap: 1,
                                                    cursor: 'default'
                                                }, onMouseEnter: (e) => {
                                                    const rect = e.currentTarget.getBoundingClientRect();
                                                    setTooltip({
                                                        top: rect.top,
                                                        left: rect.left + rect.width / 2,
                                                        line1: `${isSendback ? '↩ Sent back by' : 'Approved by'} ${name}`,
                                                        line2: fullTs
                                                    });
                                                }, onMouseLeave: () => setTooltip(null), children: [_jsxs("span", { style: {
                                                            fontSize: 9,
                                                            fontFamily: 'monospace',
                                                            fontWeight: 600,
                                                            lineHeight: 1,
                                                            color: isSendback ? '#d97706' : '#475569'
                                                        }, children: [isSendback ? '↩ ' : '', ini] }), _jsx("span", { style: { fontSize: 8.5, lineHeight: 1, color: '#94a3b8' }, children: rel })] }, h.id));
                                        })] }))] }, s.id));
                    }) }) })] }));
}
//# sourceMappingURL=StateTrack.js.map