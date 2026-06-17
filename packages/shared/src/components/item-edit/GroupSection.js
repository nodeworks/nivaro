import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { ChevronDown, ChevronRight } from 'lucide-react';
import { useState } from 'react';
import { FieldRow, getColSpanClass } from './FieldRow';
export function GroupSection({ group, fields, draft, onChange, relations, collection, itemId, errors, visibleFields, lockedFields, renderField }) {
    const [collapsed, setCollapsed] = useState(group.is_collapsed ?? false);
    const hasErrors = fields.some((f) => errors[f.field]);
    return (_jsxs("div", { className: 'overflow-hidden rounded-xl border border-slate-200 bg-white', children: [_jsxs("button", { type: 'button', onClick: () => setCollapsed((v) => !v), className: 'flex w-full items-center gap-2.5 px-5 py-3.5 text-left hover:bg-slate-50/50', children: [_jsx("span", { className: 'font-semibold text-sm text-slate-700 flex-1', children: group.label }), hasErrors && _jsx("span", { className: 'h-2 w-2 rounded-full bg-destructive shrink-0' }), collapsed ? (_jsx(ChevronRight, { className: 'h-4 w-4 text-slate-400' })) : (_jsx(ChevronDown, { className: 'h-4 w-4 text-slate-400' }))] }), !collapsed && (_jsx("div", { className: 'border-t border-slate-100 px-5 py-5', children: _jsx("div", { className: 'grid grid-cols-12 gap-4 items-start', children: fields
                        .filter((f) => !f.hidden)
                        .map((f) => (_jsx("div", { className: getColSpanClass(f.options), children: _jsx(FieldRow, { field: f, draft: draft, onChange: onChange, relations: relations, collection: collection, itemId: itemId, error: errors[f.field], visible: visibleFields.has(f.field) || !visibleFields.size, locked: lockedFields.has(f.field), renderField: renderField }) }, f.field))) }) }))] }));
}
//# sourceMappingURL=GroupSection.js.map