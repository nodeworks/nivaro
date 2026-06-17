import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRight, Check, GitFork, Loader2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { useNivaroClient } from '../../context';
import { get, post } from '../../lib/commands';
import { Button } from '../ui/button';
import { Skeleton } from '../ui/skeleton';
function StateBadge({ label, color, small }) {
    const size = small ? 'px-2 py-0.5 text-[11px]' : 'px-2.5 py-1 text-[13px]';
    return (_jsx("span", { className: `inline-flex items-center gap-1.5 rounded-full font-medium ${size}`, style: {
            backgroundColor: color ? `${color}22` : '#f1f5f9',
            color: color ?? '#475569',
            border: `1px solid ${color ? `${color}44` : '#e2e8f0'}`
        }, children: label }));
}
function BranchRow({ branch, index, onTransition, transitioning }) {
    const [pending, setPending] = useState(null);
    const [comment, setComment] = useState('');
    return (_jsxs("div", { className: 'rounded-lg border border-slate-200 bg-slate-50/60 p-3 space-y-2', children: [_jsxs("div", { className: 'flex items-center gap-2.5 flex-wrap', children: [_jsxs("span", { className: 'text-[11px] font-medium text-slate-400 w-14 shrink-0', children: ["Branch ", index + 1] }), branch.state ? (_jsx(StateBadge, { label: branch.state.label, color: branch.state.color, small: true })) : (_jsx("span", { className: 'text-[12px] text-slate-400 italic', children: "Unknown state" })), branch.terminal && (_jsxs("span", { className: 'flex items-center gap-1 text-[11px] text-emerald-600', children: [_jsx(Check, { className: 'h-3 w-3' }), "Done"] })), !branch.terminal && branch.available_transitions.length > 0 && (_jsx("div", { className: 'flex flex-wrap gap-1.5 ml-auto', children: branch.available_transitions.map((tx) => (_jsx(Button, { size: 'sm', variant: pending === tx.id ? 'default' : 'outline', className: 'h-6 gap-1 px-2 text-[11px]', style: tx.color && pending !== tx.id
                                ? { borderColor: tx.color, color: tx.color }
                                : tx.color && pending === tx.id
                                    ? { backgroundColor: tx.color, borderColor: tx.color }
                                    : undefined, onClick: () => setPending(pending === tx.id ? null : tx.id), children: tx.label }, tx.id))) }))] }), pending && (_jsxs("div", { className: 'rounded-md border border-slate-200 bg-white p-2 space-y-2', children: [_jsx("input", { type: 'text', value: comment, onChange: (e) => setComment(e.target.value), placeholder: 'Add a comment (optional)', className: 'w-full rounded-md border border-slate-200 bg-white px-2.5 py-1 text-[12px] placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-nvr-cyan/30' }), _jsxs("div", { className: 'flex items-center justify-end gap-2', children: [_jsx(Button, { type: 'button', size: 'sm', variant: 'ghost', className: 'h-6 text-[11px]', onClick: () => setPending(null), children: "Cancel" }), _jsx(Button, { type: 'button', size: 'sm', className: 'h-6 text-[11px]', disabled: transitioning, onClick: () => {
                                    onTransition(branch.instance_id, pending, comment.trim() || undefined);
                                    setPending(null);
                                    setComment('');
                                }, children: transitioning ? _jsx(Loader2, { className: 'h-3 w-3 animate-spin' }) : 'Confirm' })] })] }))] }));
}
export function WorkflowPanel({ collection, item }) {
    if (item === 'new')
        return null;
    return _jsx(WorkflowPanelInner, { collection: collection, item: item });
}
function WorkflowPanelInner({ collection, item }) {
    const client = useNivaroClient();
    const queryClient = useQueryClient();
    const { data: pipelineData } = useQuery({
        queryKey: ['pipeline-instance', collection, item],
        queryFn: () => client
            .request(get(`/pipelines/instance/${collection}/${item}`))
            .then((r) => r.data),
        staleTime: 10_000
    });
    const instanceId = pipelineData?.instance?.id ?? null;
    const branchesKey = ['workflow-branches', instanceId];
    const { data, isLoading } = useQuery({
        queryKey: branchesKey,
        queryFn: () => client
            .request(get(`/workflows/instance/${instanceId}/branches`))
            .then((r) => r.data),
        enabled: !!instanceId,
        refetchInterval: (q) => (q.state.data?.active ? 15_000 : false)
    });
    const invalidate = () => {
        queryClient.invalidateQueries({ queryKey: branchesKey });
        queryClient.invalidateQueries({ queryKey: ['pipeline-instance', collection, item] });
    };
    const split = useMutation({
        mutationFn: (config) => client.request(post(`/workflows/instance/${instanceId}/split`, {
            branch_states: config.branch_states.map((s) => s.key),
            join_state: config.join_state?.key
        })),
        onSuccess: () => {
            invalidate();
            toast.success('Workflow split into parallel branches');
        },
        onError: (err) => {
            toast.error(err?.response?.data?.error ??
                'Failed to split workflow');
        }
    });
    const transition = useMutation({
        mutationFn: ({ branchInstanceId, transitionId, comment }) => client
            .request(post(`/workflows/instance/${branchInstanceId}/transition`, {
            transition_id: transitionId,
            comment
        }))
            .then((r) => r.data),
        onSuccess: (result) => {
            invalidate();
            toast.success(result?.joined ? 'All branches complete — workflow joined' : 'Branch transitioned');
        },
        onError: (err) => {
            toast.error(err?.response?.data?.error ??
                'Failed to execute transition');
        }
    });
    if (!instanceId)
        return null;
    if (isLoading)
        return (_jsxs("div", { className: 'rounded-xl border border-slate-200 bg-white p-5 space-y-3', children: [_jsx(Skeleton, { className: 'h-4 w-36' }), _jsx(Skeleton, { className: 'h-8 w-full' })] }));
    if (!data)
        return null;
    const canSplit = !data.active && !data.parent?.completed_at && (data.split_configs?.length ?? 0) > 0;
    if (!data.active && !canSplit)
        return null;
    return (_jsxs("div", { className: 'rounded-xl border border-slate-200 bg-white p-5 space-y-4', children: [_jsxs("div", { className: 'flex items-center gap-2', children: [_jsx(GitFork, { className: 'h-4 w-4 text-slate-400' }), _jsx("span", { className: 'text-[11px] font-medium text-slate-500', children: "Parallel Branches" }), data.active && (_jsxs("span", { className: 'ml-auto text-[11px] text-slate-500', children: ["Waiting on ", data.waiting_on, " of ", data.total, " branches"] }))] }), data.active ? (_jsxs(_Fragment, { children: [_jsx("div", { className: 'space-y-2', children: data.branches.map((b, i) => (_jsx(BranchRow, { branch: b, index: i, transitioning: transition.isPending, onTransition: (branchInstanceId, transitionId, comment) => transition.mutate({ branchInstanceId, transitionId, comment }) }, b.instance_id))) }), data.join_state && (_jsxs("div", { className: 'flex items-center gap-2 text-[12px] text-slate-500', children: [_jsx("span", { children: "When all branches complete" }), _jsx(ArrowRight, { className: 'h-3 w-3 text-slate-300' }), _jsx(StateBadge, { label: data.join_state.label, color: data.join_state.color, small: true })] }))] })) : (_jsx("div", { className: 'space-y-2', children: data.split_configs.map((cfg) => (_jsxs("div", { className: 'flex items-center gap-2.5 rounded-lg border border-slate-200 bg-slate-50/60 p-3 flex-wrap', children: [_jsxs("div", { className: 'flex items-center gap-1.5 flex-wrap min-w-0 flex-1', children: [cfg.branch_states.map((s) => (_jsx(StateBadge, { label: s.label, color: s.color, small: true }, s.id))), _jsx(ArrowRight, { className: 'h-3 w-3 text-slate-300 shrink-0' }), cfg.join_state && (_jsx(StateBadge, { label: cfg.join_state.label, color: cfg.join_state.color, small: true }))] }), _jsxs(Button, { size: 'sm', variant: 'outline', className: 'h-7 gap-1.5 text-[12px] shrink-0', disabled: split.isPending, onClick: () => split.mutate(cfg), children: [split.isPending ? (_jsx(Loader2, { className: 'h-3 w-3 animate-spin' })) : (_jsx(GitFork, { className: 'h-3 w-3' })), cfg.label || 'Split'] })] }, cfg.id))) }))] }));
}
//# sourceMappingURL=WorkflowPanel.js.map