import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { StateBadge } from './StateBadge';
export function relFmt(iso) {
    const diff = Date.now() - new Date(iso).getTime();
    const m = Math.floor(diff / 60000);
    if (m < 60)
        return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24)
        return `${h}h ago`;
    return `${Math.floor(h / 24)}d ago`;
}
export function initials(first, last, email) {
    const f = first?.[0] ?? '';
    const l = last?.[0] ?? '';
    return (f + l).toUpperCase() || email?.[0]?.toUpperCase() || '?';
}
export function HistoryTimeline({ history }) {
    if (history.length === 0) {
        return (_jsx("p", { style: { fontSize: 12, color: '#94a3b8', fontStyle: 'italic' }, children: "No transitions yet." }));
    }
    return (_jsx("div", { style: { display: 'flex', flexDirection: 'column', gap: 12 }, children: history.map((h) => {
            const name = [h.first_name, h.last_name].filter(Boolean).join(' ') || h.user_email || 'System';
            const ts = relFmt(h.timestamp);
            return (_jsxs("div", { style: { display: 'flex', alignItems: 'flex-start', gap: 10, fontSize: 12 }, children: [_jsx("div", { style: {
                            marginTop: 6,
                            width: 6,
                            height: 6,
                            borderRadius: '50%',
                            backgroundColor: '#e2e8f0',
                            flexShrink: 0
                        } }), _jsxs("div", { style: { flex: 1, minWidth: 0 }, children: [_jsxs("div", { style: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }, children: [h.from_state_label ? (_jsx(StateBadge, { label: h.from_state_label, color: h.from_state_color ?? null, small: true })) : (_jsx("span", { style: { fontSize: 11, color: '#94a3b8', fontStyle: 'italic' }, children: "started" })), _jsx("svg", { "aria-hidden": 'true', width: '12', height: '12', viewBox: '0 0 12 12', fill: 'none', children: _jsx("path", { d: 'M2 6h8M7 3l3 3-3 3', stroke: '#cbd5e1', strokeWidth: '1.5', strokeLinecap: 'round', strokeLinejoin: 'round' }) }), _jsx(StateBadge, { label: h.to_state_label, color: h.to_state_color ?? null, small: true })] }), h.comment && (_jsxs("p", { style: { marginTop: 2, color: '#64748b', fontStyle: 'italic' }, children: ["\"", h.comment, "\""] })), _jsxs("p", { style: { marginTop: 2, color: '#94a3b8' }, children: [name, " \u00B7 ", ts] })] })] }, h.id));
        }) }));
}
//# sourceMappingURL=HistoryTimeline.js.map