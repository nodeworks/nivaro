import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useCallback, useEffect, useRef, useState } from 'react';
import { useOptionalNivaroClient } from '../../context';
import { del, get, post } from '../../lib/commands';
function userName(u) {
    if (!u)
        return 'Unknown';
    return [u.first_name, u.last_name].filter(Boolean).join(' ') || u.email;
}
function fmtDate(iso) {
    return new Date(iso).toLocaleDateString(undefined, {
        month: 'short',
        day: 'numeric',
        year: 'numeric'
    });
}
function relativeTime(iso) {
    const diff = Date.now() - new Date(iso).getTime();
    const m = Math.floor(diff / 60000);
    if (m < 60)
        return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24)
        return `${h}h ago`;
    return `${Math.floor(h / 24)}d ago`;
}
export function TasksSlot({ collection, itemId, labelOverride, defaultExpanded }) {
    const client = useOptionalNivaroClient();
    const [open, setOpen] = useState(false);
    const [tasks, setTasks] = useState([]);
    const [users, setUsers] = useState([]);
    const [adding, setAdding] = useState(false);
    const [showCompleted, setShowCompleted] = useState(false);
    const [newTitle, setNewTitle] = useState('');
    const [newAssignee, setNewAssignee] = useState('');
    const [newDueDate, setNewDueDate] = useState('');
    const [creating, setCreating] = useState(false);
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
    const fetchTasks = useCallback(async () => {
        if (!client || !itemId)
            return;
        try {
            const res = await client.request(get('/tasks', { collection, item: String(itemId) }));
            if (mountedRef.current)
                setTasks(res.data ?? []);
        }
        catch {
            if (mountedRef.current)
                setTasks([]);
        }
    }, [client, collection, itemId]);
    useEffect(() => {
        void fetchTasks();
    }, [fetchTasks]);
    useEffect(() => {
        if (!client)
            return;
        client
            .request(get('/users', { limit: 200 }))
            .then((res) => {
            if (mountedRef.current)
                setUsers(res.data ?? []);
        })
            .catch(() => {
            /* no-op */
        });
    }, [client]);
    async function createTask() {
        if (!client || !newTitle.trim() || !newAssignee || creating)
            return;
        setCreating(true);
        try {
            await client.request(post('/tasks', {
                collection,
                item: String(itemId),
                title: newTitle.trim(),
                assignee: newAssignee,
                due_date: newDueDate || undefined
            }));
            setAdding(false);
            setNewTitle('');
            setNewAssignee('');
            setNewDueDate('');
            await fetchTasks();
        }
        catch {
            /* no-op */
        }
        finally {
            if (mountedRef.current)
                setCreating(false);
        }
    }
    async function completeTask(id) {
        if (!client)
            return;
        try {
            await client.request(post(`/tasks/${id}/complete`));
            await fetchTasks();
        }
        catch {
            /* no-op */
        }
    }
    async function deleteTask(id) {
        if (!client)
            return;
        try {
            await client.request(del(`/tasks/${id}`));
            await fetchTasks();
        }
        catch {
            /* no-op */
        }
    }
    const openTasks = tasks.filter((t) => t.status !== 'completed');
    const completedTasks = tasks.filter((t) => t.status === 'completed');
    const usersById = new Map(users.map((u) => [u.id, u]));
    const now = Date.now();
    return (_jsxs("div", { "data-nf-slot": '__tasks__', "data-nf-slot-open": open ? 'true' : 'false', children: [_jsxs("button", { type: 'button', onClick: () => setOpen((v) => !v), "data-nf-slot-toggle": true, children: [_jsxs("svg", { "data-nf-slot-icon": true, width: '14', height: '14', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: '2', strokeLinecap: 'round', strokeLinejoin: 'round', "aria-hidden": 'true', children: [_jsx("rect", { x: '9', y: '3', width: '13', height: '13', rx: '2' }), _jsx("path", { d: 'M5 7H4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-1' }), _jsx("polyline", { points: '16 3 12 7 10 5' })] }), _jsx("span", { "data-nf-slot-label": true, children: labelOverride ?? 'Tasks' }), !open && openTasks.length > 0 && _jsxs("span", { "data-nf-slot-count": true, children: [openTasks.length, " open"] }), _jsx("svg", { "data-nf-slot-chevron": true, width: '14', height: '14', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: '2', strokeLinecap: 'round', strokeLinejoin: 'round', style: { transform: open ? 'rotate(180deg)' : undefined }, "aria-hidden": 'true', children: _jsx("polyline", { points: '6 9 12 15 18 9' }) })] }), open && (_jsxs("div", { "data-nf-slot-content": true, children: [_jsx("div", { "data-nf-tasks-toolbar": true, children: !adding && (_jsx("button", { type: 'button', "data-nf-btn-outline": true, onClick: () => setAdding(true), children: "+ Add task" })) }), adding && (_jsxs("div", { "data-nf-task-form": true, children: [_jsxs("div", { "data-nf-task-form-row": true, children: [_jsx("label", { htmlFor: 'task-title-input', "data-nf-task-label": true, children: "Title" }), _jsx("input", { id: 'task-title-input', type: 'text', value: newTitle, onChange: (e) => setNewTitle(e.target.value), placeholder: 'What needs to be done?', "data-nf-task-input": true })] }), _jsxs("div", { "data-nf-task-form-grid": true, children: [_jsxs("div", { "data-nf-task-form-row": true, children: [_jsx("label", { htmlFor: 'task-assignee-input', "data-nf-task-label": true, children: "Assignee" }), _jsxs("select", { id: 'task-assignee-input', value: newAssignee, onChange: (e) => setNewAssignee(e.target.value), "data-nf-task-input": true, children: [_jsx("option", { value: '', children: "Select assignee\u2026" }), users.map((u) => (_jsx("option", { value: u.id, children: userName(u) }, u.id)))] })] }), _jsxs("div", { "data-nf-task-form-row": true, children: [_jsx("label", { htmlFor: 'task-due-input', "data-nf-task-label": true, children: "Due date" }), _jsx("input", { id: 'task-due-input', type: 'date', value: newDueDate, onChange: (e) => setNewDueDate(e.target.value), "data-nf-task-input": true })] })] }), _jsxs("div", { "data-nf-confirm-actions": true, children: [_jsx("button", { type: 'button', "data-nf-btn-ghost": true, onClick: () => setAdding(false), children: "Cancel" }), _jsx("button", { type: 'button', "data-nf-btn-primary": true, disabled: !newTitle.trim() || !newAssignee || creating, onClick: () => void createTask(), children: creating ? 'Creating…' : 'Create Task' })] })] })), openTasks.length === 0 && !adding && _jsx("p", { "data-nf-empty": true, children: "No open tasks" }), openTasks.length > 0 && (_jsx("div", { "data-nf-task-list": true, children: openTasks.map((t) => {
                            const overdue = t.due_date ? new Date(t.due_date).getTime() < now : false;
                            return (_jsxs("div", { "data-nf-task-row": true, children: [_jsx("input", { type: 'checkbox', checked: false, onChange: () => void completeTask(t.id), "data-nf-task-checkbox": true, "aria-label": `Complete: ${t.title}` }), _jsxs("div", { "data-nf-task-info": true, children: [_jsx("p", { "data-nf-task-title": true, children: t.title }), t.description && _jsx("p", { "data-nf-task-desc": true, children: t.description }), _jsxs("div", { "data-nf-task-meta": true, children: [t.assignee && _jsx("span", { children: userName(usersById.get(t.assignee)) }), t.due_date && (_jsxs("span", { "data-overdue": overdue ? 'true' : 'false', children: ["Due ", fmtDate(t.due_date), overdue ? ' (overdue)' : ''] }))] })] }), _jsx("button", { type: 'button', "data-nf-icon-btn": true, "data-nf-icon-btn-danger": true, title: 'Delete task', onClick: () => void deleteTask(t.id), children: _jsxs("svg", { width: '14', height: '14', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: '2', strokeLinecap: 'round', strokeLinejoin: 'round', "aria-hidden": 'true', children: [_jsx("line", { x1: '18', y1: '6', x2: '6', y2: '18' }), _jsx("line", { x1: '6', y1: '6', x2: '18', y2: '18' })] }) })] }, t.id));
                        }) })), completedTasks.length > 0 && (_jsxs("div", { "data-nf-completed-section": true, children: [_jsxs("button", { type: 'button', "data-nf-history-toggle": true, onClick: () => setShowCompleted((v) => !v), children: [_jsx("svg", { width: '14', height: '14', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: '2', strokeLinecap: 'round', strokeLinejoin: 'round', style: { transform: showCompleted ? 'rotate(90deg)' : undefined }, "aria-hidden": 'true', children: _jsx("polyline", { points: '9 18 15 12 9 6' }) }), "Completed (", completedTasks.length, ")"] }), showCompleted && (_jsx("div", { "data-nf-task-list": true, "data-nf-completed": true, children: completedTasks.map((t) => (_jsxs("div", { "data-nf-task-row": true, "data-nf-task-done": true, children: [_jsx("input", { type: 'checkbox', checked: true, disabled: true, "data-nf-task-checkbox": true, "aria-label": 'Completed' }), _jsxs("div", { "data-nf-task-info": true, children: [_jsx("p", { "data-nf-task-title": true, children: t.title }), _jsxs("div", { "data-nf-task-meta": true, children: [t.assignee && _jsx("span", { children: userName(usersById.get(t.assignee)) }), t.completed_at && _jsxs("span", { children: ["Done ", relativeTime(t.completed_at)] })] })] })] }, t.id))) }))] }))] }))] }));
}
//# sourceMappingURL=TasksSlot.js.map