import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { Check } from 'lucide-react';
import { cn } from '../../lib/utils';
export function StepsBar({ steps, active, completed, onStepClick }) {
    return (_jsx("div", { className: 'w-full grid', style: { gridTemplateColumns: `repeat(${steps.length}, 1fr)` }, children: steps.map((s, i) => {
            const isActive = s.key === active;
            const isDone = completed.has(s.key) && !isActive;
            return (_jsxs("div", { className: 'relative flex flex-col items-center gap-1.5 px-1', children: [i < steps.length - 1 && (_jsx("div", { className: 'absolute top-3.5 left-1/2 w-full -translate-y-1/2', style: { right: 0 }, children: _jsx("div", { className: cn('h-px w-full transition-colors duration-300', isDone ? 'bg-emerald-400' : 'bg-slate-200') }) })), _jsx("button", { type: 'button', onClick: () => onStepClick(s.key), className: cn('relative z-10 flex h-7 w-7 shrink-0 items-center justify-center rounded-full border-2 text-[11px] font-semibold transition-all duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00ceff] focus-visible:ring-offset-2', isActive
                            ? 'border-[#00ceff] bg-[#00ceff] text-[#172940]'
                            : isDone
                                ? 'border-emerald-500 bg-emerald-500 text-white'
                                : 'border-slate-200 bg-white text-slate-400 hover:border-slate-300'), children: isDone ? _jsx(Check, { className: 'h-3.5 w-3.5', strokeWidth: 2.5 }) : _jsx("span", { children: i + 1 }) }), _jsx("span", { className: cn('text-center text-[11px] font-medium leading-tight', isActive ? 'text-slate-900' : isDone ? 'text-slate-600' : 'text-slate-400'), children: s.label })] }, s.key));
        }) }));
}
//# sourceMappingURL=StepsBar.js.map