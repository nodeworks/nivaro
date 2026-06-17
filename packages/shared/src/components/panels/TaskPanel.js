import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, ChevronDown, ChevronsUpDown, ClipboardList, Plus, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { useNivaroClient } from '../../context';
import { del, get, post } from '../../lib/commands';
import { cn, formatDate, formatRelative } from '../../lib/utils';
import { Button } from '../ui/button';
import { Checkbox } from '../ui/checkbox';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '../ui/command';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover';
function userName(u) {
    if (!u)
        return 'Unknown';
    return [u.first_name, u.last_name].filter(Boolean).join(' ') || u.email;
}
function AssigneeCombobox({ users, value, onChange }) {
    const [open, setOpen] = useState(false);
    const selected = users.find((u) => u.id === value);
    return (_jsxs(Popover, { open: open, onOpenChange: setOpen, children: [_jsx(PopoverTrigger, { asChild: true, children: _jsxs(Button, { variant: 'outline', role: 'combobox', "aria-expanded": open, className: 'h-8 w-full justify-between px-2.5 text-[12px] font-normal', children: [_jsx("span", { className: cn('truncate', !selected && 'text-muted-foreground'), children: selected ? userName(selected) : 'Assign to…' }), _jsx(ChevronsUpDown, { className: 'ml-1 h-3.5 w-3.5 shrink-0 opacity-50' })] }) }), _jsx(PopoverContent, { className: 'w-[280px] p-0', align: 'start', children: _jsxs(Command, { children: [_jsx(CommandInput, { placeholder: 'Search users\u2026', className: 'h-8 text-[12px]' }), _jsxs(CommandList, { children: [_jsx(CommandEmpty, { className: 'py-3 text-center text-[12px] text-muted-foreground', children: "No users found" }), _jsx(CommandGroup, { children: users.map((u) => (_jsxs(CommandItem, { value: `${u.first_name ?? ''} ${u.last_name ?? ''} ${u.email}`, onSelect: () => {
                                            onChange(u.id === value ? null : u.id);
                                            setOpen(false);
                                        }, className: 'text-[12px]', children: [_jsx(Check, { className: cn('mr-2 h-3.5 w-3.5', value === u.id ? 'opacity-100' : 'opacity-0') }), userName(u)] }, u.id))) })] })] }) })] }));
}
export function TaskPanel({ collection, item, title, defaultExpanded }) {
    const client = useNivaroClient();
    const qc = useQueryClient();
    const [expanded, setExpanded] = useState(false);
    const syncedFromProp = useRef(false);
    useEffect(() => {
        if (!syncedFromProp.current && defaultExpanded !== undefined) {
            syncedFromProp.current = true;
            setExpanded(defaultExpanded);
        }
    }, [defaultExpanded]);
    const [adding, setAdding] = useState(false);
    const [showCompleted, setShowCompleted] = useState(false);
    const [newTitle, setNewTitle] = useState('');
    const [newAssignee, setNewAssignee] = useState(null);
    const [newDueDate, setNewDueDate] = useState('');
    const { data: tasks = [] } = useQuery({
        queryKey: ['tasks', collection, item],
        queryFn: () => client.request(get('/tasks', { collection, item })).then((r) => r.data),
        enabled: !!collection && !!item && item !== 'new'
    });
    const { data: users = [] } = useQuery({
        queryKey: ['users', 'combobox'],
        queryFn: () => client.request(get('/users', { limit: 200 })).then((r) => r.data)
    });
    const invalidate = () => qc.invalidateQueries({ queryKey: ['tasks', collection, item] });
    const createMut = useMutation({
        mutationFn: () => client.request(post('/tasks', {
            collection,
            item,
            title: newTitle.trim(),
            assignee: newAssignee,
            due_date: newDueDate || undefined
        })),
        onSuccess: () => {
            invalidate();
            setAdding(false);
            setNewTitle('');
            setNewAssignee(null);
            setNewDueDate('');
            toast.success('Task created');
        },
        onError: () => toast.error('Failed to create task')
    });
    const completeMut = useMutation({
        mutationFn: (taskId) => client.request(post(`/tasks/${taskId}/complete`, {})),
        onSuccess: () => {
            invalidate();
            toast.success('Task completed');
        },
        onError: () => toast.error('Failed to complete task')
    });
    const deleteMut = useMutation({
        mutationFn: (taskId) => client.request(del(`/tasks/${taskId}`)),
        onSuccess: () => {
            invalidate();
            toast.success('Task deleted');
        },
        onError: () => toast.error('Failed to delete task')
    });
    if (!item || item === 'new')
        return null;
    const openTasks = tasks.filter((t) => t.status !== 'completed');
    const completedTasks = tasks.filter((t) => t.status === 'completed');
    const usersById = new Map(users.map((u) => [u.id, u]));
    const now = Date.now();
    return (_jsxs("div", { className: 'overflow-hidden rounded-xl border border-slate-200 bg-white', children: [_jsxs("button", { type: 'button', onClick: () => setExpanded((v) => !v), className: 'flex w-full items-center gap-2 px-4 py-2.5', children: [_jsx(ClipboardList, { className: 'h-3.5 w-3.5 shrink-0 text-slate-400' }), _jsx("span", { className: 'text-[12px] font-semibold text-slate-500', children: title || 'Tasks' }), !expanded && openTasks.length > 0 && (_jsxs("span", { className: 'ml-1 text-[11px] text-slate-400', children: [openTasks.length, " open"] })), _jsx(ChevronDown, { className: `ml-auto h-3.5 w-3.5 shrink-0 text-slate-400 transition-transform duration-150${expanded ? ' rotate-180' : ''}` })] }), expanded && (_jsxs("div", { className: 'border-t border-slate-100', children: [_jsx("div", { className: 'flex items-center justify-between px-4 py-2', children: !adding && (_jsxs(Button, { size: 'sm', variant: 'outline', className: 'h-7 text-[12px]', onClick: () => setAdding(true), children: [_jsx(Plus, { className: 'mr-1 h-3.5 w-3.5' }), "Add task"] })) }), _jsxs("div", { className: 'space-y-3 px-4 pb-4', children: [openTasks.length === 0 && !adding && (_jsx("p", { className: 'py-1 text-[13px] text-slate-400', children: "No open tasks" })), openTasks.length > 0 && (_jsx("div", { className: 'divide-y divide-slate-100', children: openTasks.map((t) => {
                                    const overdue = t.due_date ? new Date(t.due_date).getTime() < now : false;
                                    return (_jsxs("div", { className: 'flex items-start gap-2.5 py-2', children: [_jsx(Checkbox, { className: 'mt-0.5', checked: false, onCheckedChange: () => completeMut.mutate(t.id), disabled: completeMut.isPending, "aria-label": `Complete task: ${t.title}` }), _jsxs("div", { className: 'min-w-0 flex-1', children: [_jsx("p", { className: 'text-[13px] font-medium text-slate-800', children: t.title }), t.description && (_jsx("p", { className: 'mt-0.5 text-[12px] text-slate-500 line-clamp-2', children: t.description })), _jsxs("div", { className: 'mt-0.5 flex items-center gap-3 text-[11px] text-slate-400', children: [t.assignee && _jsx("span", { children: userName(usersById.get(t.assignee)) }), t.due_date && (_jsxs("span", { className: cn(overdue && 'font-medium text-red-500'), children: ["Due ", formatDate(t.due_date), overdue && ' (overdue)'] }))] })] }), _jsx("button", { type: 'button', onClick: () => deleteMut.mutate(t.id), disabled: deleteMut.isPending, className: 'shrink-0 rounded p-1 text-slate-300 transition-colors hover:bg-red-50 hover:text-red-400 disabled:opacity-40', children: _jsx(X, { className: 'h-3.5 w-3.5' }) })] }, t.id));
                                }) })), adding && (_jsxs("div", { className: 'space-y-3 rounded-lg border border-slate-200 bg-slate-50 p-3', children: [_jsxs("div", { children: [_jsx(Label, { className: 'mb-1 block text-[11px]', children: "Title" }), _jsx(Input, { value: newTitle, onChange: (e) => setNewTitle(e.target.value), className: 'h-8 bg-white text-[12px]', placeholder: 'What needs to be done?', autoFocus: true })] }), _jsxs("div", { className: 'grid grid-cols-2 gap-3', children: [_jsxs("div", { children: [_jsx(Label, { className: 'mb-1 block text-[11px]', children: "Assignee" }), _jsx(AssigneeCombobox, { users: users, value: newAssignee, onChange: setNewAssignee })] }), _jsxs("div", { children: [_jsx(Label, { className: 'mb-1 block text-[11px]', children: "Due date" }), _jsx(Input, { type: 'date', value: newDueDate, onChange: (e) => setNewDueDate(e.target.value), className: 'h-8 bg-white text-[12px]' })] })] }), _jsxs("div", { className: 'flex justify-end gap-2', children: [_jsx(Button, { type: 'button', variant: 'outline', size: 'sm', className: 'h-7 text-[12px]', onClick: () => setAdding(false), children: "Cancel" }), _jsx(Button, { type: 'button', size: 'sm', className: 'h-7 text-[12px]', disabled: !newTitle.trim() || !newAssignee || createMut.isPending, onClick: () => createMut.mutate(), children: createMut.isPending ? 'Creating…' : 'Create Task' })] })] })), completedTasks.length > 0 && (_jsxs("div", { children: [_jsxs("button", { type: 'button', onClick: () => setShowCompleted((v) => !v), className: 'flex items-center gap-1 text-[12px] text-slate-400 transition-colors hover:text-slate-600', children: [_jsx(ChevronDown, { className: cn('h-3.5 w-3.5 transition-transform', showCompleted && 'rotate-180') }), "Completed (", completedTasks.length, ")"] }), showCompleted && (_jsx("div", { className: 'mt-1 divide-y divide-slate-100', children: completedTasks.map((t) => (_jsxs("div", { className: 'flex items-start gap-2.5 py-2 opacity-60', children: [_jsx(Checkbox, { className: 'mt-0.5', checked: true, disabled: true, "aria-label": 'Completed' }), _jsxs("div", { className: 'min-w-0 flex-1', children: [_jsx("p", { className: 'text-[13px] text-slate-600 line-through', children: t.title }), _jsxs("div", { className: 'mt-0.5 flex items-center gap-3 text-[11px] text-slate-400', children: [t.assignee && _jsx("span", { children: userName(usersById.get(t.assignee)) }), t.completed_at && _jsxs("span", { children: ["Done ", formatRelative(t.completed_at)] })] })] })] }, t.id))) }))] }))] })] }))] }));
}
//# sourceMappingURL=TaskPanel.js.map