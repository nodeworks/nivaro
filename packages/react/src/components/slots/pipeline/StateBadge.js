import { jsx as _jsx } from "react/jsx-runtime";
export function StateBadge({ label, color, small }) {
    return (_jsx("span", { "data-nf-state-badge": true, style: {
            display: 'inline-flex',
            alignItems: 'center',
            borderRadius: '9999px',
            fontWeight: 500,
            fontSize: small ? '11px' : '12px',
            padding: small ? '2px 8px' : '4px 10px',
            backgroundColor: color ? `${color}22` : '#f1f5f9',
            color: color ?? '#475569',
            border: `1px solid ${color ? `${color}44` : '#e2e8f0'}`,
            whiteSpace: 'nowrap'
        }, children: label }));
}
//# sourceMappingURL=StateBadge.js.map