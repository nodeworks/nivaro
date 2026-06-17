import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, ChevronDown, Loader2, Save, Trash2 } from 'lucide-react';
import { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { ItemEditAuthContext, useNivaroClient } from '../context';
import { del, get, patch, post } from '../lib/commands';
import { cn, formatRelative, titleCase } from '../lib/utils';
import { FieldRow, getColSpanClass } from './item-edit/FieldRow';
import { GroupSection } from './item-edit/GroupSection';
import { SENTINEL_FIELDS, SYSTEM_FIELDS } from './item-edit/helpers';
import { M2MStagingContext } from './item-edit/M2MStagingContext';
import { StepsBar } from './item-edit/StepsBar';
import { SummaryPanel } from './item-edit/SummaryPanel';
import { CommentPanel, ItemLockBanner, PipelinePanel, PipelineTransitionButtons, RevisionsPanel, TaskPanel, useItemLock, WorkflowPanel } from './panels';
import { Button } from './ui/button';
import { Skeleton } from './ui/skeleton';
// ─── Public types ──────────────────────────────────────────────────────────────
export { M2MStagingContext, useM2MStaging } from './item-edit/M2MStagingContext';
// ─── ItemEditForm ──────────────────────────────────────────────────────────────
export function ItemEditForm({ collection, itemId: itemIdProp, layoutSlug, onBack, onSaved, onDeleted, showHeader = true, showRevisions = true, showPipeline = true, showWorkflow = true, showComments = true, showTasks = true, showLockBanner = true, className, headerClassName, renderField }) {
    const client = useNivaroClient();
    const { isAdmin } = useContext(ItemEditAuthContext);
    const qc = useQueryClient();
    const itemId = itemIdProp ?? 'new';
    const isNew = !itemIdProp || itemIdProp === 'new';
    // ── Data fetching ──────────────────────────────────────────────────────────
    const { data: fieldConfig, isLoading: fieldsLoading } = useQuery({
        queryKey: ['field-config', collection],
        queryFn: () => client
            .request(get(`/field-config/${collection}`))
            .then((r) => r.data ?? []),
        staleTime: 60_000
    });
    const { data: relations = [] } = useQuery({
        queryKey: ['relations', collection],
        queryFn: () => client
            .request(get(`/data-model/relations/for/${collection}`))
            .then((r) => r.data ?? []),
        staleTime: 60_000
    });
    const { data: activeLayoutData } = useQuery({
        queryKey: ['active-layout', collection, layoutSlug ?? null],
        queryFn: () => client
            .request(get('/collection-layouts/active', { collection, ...(layoutSlug ? { slug: layoutSlug } : {}) }))
            .then((r) => r.data)
            .catch(() => null),
        staleTime: 60_000
    });
    const { data: colMeta } = useQuery({
        queryKey: ['col-meta', collection],
        queryFn: () => client
            .request(get(`/collections/${collection}`))
            .then((r) => r.data),
        staleTime: 60_000
    });
    const { data: itemData, isLoading: itemLoading } = useQuery({
        queryKey: ['item', collection, itemId],
        queryFn: () => client
            .request(get(`/items/${collection}/${itemId}`))
            .then((r) => r.data),
        enabled: !isNew,
        staleTime: 30_000
    });
    // ── Draft state ────────────────────────────────────────────────────────────
    const [draft, setDraft] = useState({});
    const [validationErrors, setValidationErrors] = useState({});
    const [isDirty, setIsDirty] = useState(false);
    const initialDataRef = useRef({});
    // ── M2M staging ────────────────────────────────────────────────────────────
    const [m2mLinks, setM2mLinks] = useState(new Map());
    const [m2mUnlinks, setM2mUnlinks] = useState(new Map());
    const m2mStagingCtx = useMemo(() => ({
        getStagedLinks: (k) => m2mLinks.get(k) ?? [],
        getStagedUnlinks: (k) => m2mUnlinks.get(k) ?? new Set(),
        stageLink: (k, id) => setM2mLinks((prev) => {
            const next = new Map(prev);
            const arr = [...(next.get(k) ?? [])];
            if (!arr.map(String).includes(String(id)))
                arr.push(id);
            next.set(k, arr);
            return next;
        }),
        stageUnlink: (k, jId) => setM2mUnlinks((prev) => {
            const next = new Map(prev);
            const s = new Set(next.get(k));
            s.add(jId);
            next.set(k, s);
            return next;
        }),
        unstageLink: (k, id) => setM2mLinks((prev) => {
            const next = new Map(prev);
            next.set(k, (next.get(k) ?? []).filter((x) => String(x) !== String(id)));
            return next;
        }),
        unstageUnlink: (k, jId) => setM2mUnlinks((prev) => {
            const next = new Map(prev);
            const s = new Set(next.get(k));
            s.delete(jId);
            next.set(k, s);
            return next;
        })
    }), [m2mLinks, m2mUnlinks]);
    useEffect(() => {
        if (itemData) {
            initialDataRef.current = itemData;
            setDraft(itemData);
            setIsDirty(false);
        }
    }, [itemData]);
    const handleFieldChange = useCallback((field, value) => {
        setDraft((prev) => {
            const next = { ...prev, [field]: value };
            for (const fc of fieldConfig ?? []) {
                if (!fc.dependency_config)
                    continue;
                try {
                    const cfg = (typeof fc.dependency_config === 'string'
                        ? JSON.parse(fc.dependency_config)
                        : fc.dependency_config);
                    for (const rule of cfg.cascade_filters ?? []) {
                        if (rule.parent_field === field && rule.clear_on_parent_change) {
                            next[fc.field] = null;
                        }
                    }
                }
                catch {
                    /* ignore malformed config */
                }
            }
            return next;
        });
        setIsDirty(true);
        setValidationErrors((prev) => {
            const next = { ...prev };
            delete next[field];
            return next;
        });
    }, [fieldConfig]);
    // ── Item lock ──────────────────────────────────────────────────────────────
    const lockEnabled = showLockBanner && !isNew && !!colMeta?.item_locking_enabled;
    const { lockHolder, acquired: _acquired, isReadOnly, takeOver, takingOver } = useItemLock(collection, !isNew ? itemId : undefined, lockEnabled);
    // ── Layout / groups ────────────────────────────────────────────────────────
    const allFields = useMemo(() => {
        if (!fieldConfig)
            return [];
        return [...fieldConfig].sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0));
    }, [fieldConfig]);
    const groups = useMemo(() => {
        return (activeLayoutData?.groups ?? []).sort((a, b) => a.sort - b.sort);
    }, [activeLayoutData]);
    const assignments = activeLayoutData?.assignments ?? [];
    const groupedMap = useMemo(() => {
        const map = {};
        for (const f of allFields) {
            if (!f.group_key || SENTINEL_FIELDS.has(f.field))
                continue;
            if (!map[f.group_key])
                map[f.group_key] = [];
            map[f.group_key].push(f);
        }
        return map;
    }, [allFields]);
    const ungroupedFields = useMemo(() => allFields.filter((f) => !f.group_key && !f.hidden && !SYSTEM_FIELDS.has(f.field) && !SENTINEL_FIELDS.has(f.field)), [allFields]);
    const systemFields = useMemo(() => allFields.filter((f) => SYSTEM_FIELDS.has(f.field) || f.readonly), [allFields]);
    const tabGroups = useMemo(() => groups.filter((g) => g.type === 'tab'), [groups]);
    const sectionGroups = useMemo(() => groups.filter((g) => g.type === 'section'), [groups]);
    const hasTabs = tabGroups.length > 0;
    const layoutMeta = activeLayoutData?.layout;
    const isStepsMode = hasTabs && layoutMeta?.tab_mode === 'steps';
    const validateBeforeNext = !!layoutMeta?.validate_before_next;
    const summaryEnabled = !!layoutMeta?.summary_enabled;
    const bodyRef = useRef(null);
    const [activeTab, setActiveTabRaw] = useState(() => {
        try {
            return localStorage.getItem(`nvr_tab_${collection}`) ?? tabGroups[0]?.key ?? '__general__';
        }
        catch {
            return '__general__';
        }
    });
    const setActiveTab = (k) => {
        setActiveTabRaw(k);
        try {
            localStorage.setItem(`nvr_tab_${collection}`, k);
        }
        catch {
            /* noop */
        }
        bodyRef.current?.scrollTo({ top: 0 });
    };
    const allSteps = useMemo(() => {
        if (!hasTabs)
            return [];
        const steps = [];
        if (sectionGroups.length > 0)
            steps.push({ key: '__general__', label: 'General' });
        for (const g of tabGroups)
            steps.push({ key: g.key, label: g.label });
        return steps;
    }, [hasTabs, sectionGroups, tabGroups]);
    const completedSteps = useMemo(() => {
        const out = new Set();
        for (const s of allSteps) {
            const stepFields = s.key === '__general__'
                ? [...ungroupedFields, ...sectionGroups.flatMap((g) => groupedMap[g.key] ?? [])]
                : (groupedMap[s.key] ?? []);
            const allFilled = stepFields
                .filter((f) => f.required && !f.hidden)
                .every((f) => {
                const v = draft[f.field];
                return v !== null && v !== undefined && v !== '';
            });
            if (allFilled)
                out.add(s.key);
        }
        return out;
    }, [allSteps, ungroupedFields, sectionGroups, groupedMap, draft]);
    function handleNext() {
        if (validateBeforeNext) {
            const stepFields = activeTab === '__general__'
                ? [...ungroupedFields, ...sectionGroups.flatMap((g) => groupedMap[g.key] ?? [])]
                : (groupedMap[activeTab] ?? []);
            const errs = {};
            for (const f of stepFields) {
                if (f.required && !f.hidden) {
                    const v = draft[f.field];
                    if (v === null || v === undefined || v === '')
                        errs[f.field] = 'This field is required';
                }
            }
            if (Object.keys(errs).length > 0) {
                setValidationErrors(errs);
                return;
            }
        }
        const idx = allSteps.findIndex((s) => s.key === activeTab);
        if (idx < allSteps.length - 1)
            setActiveTab(allSteps[idx + 1].key);
    }
    // ── Sentinel slot positioning ──────────────────────────────────────────────
    const pipelineSlot = assignments.find((a) => a.field === '__pipeline__');
    const commentsSlot = assignments.find((a) => a.field === '__comments__');
    const tasksSlot = assignments.find((a) => a.field === '__tasks__');
    const sectionOrder = useMemo(() => {
        const isVisible = (a) => !(a && (a.is_visible === 0 || a.is_visible === false));
        const entries = [
            ...sectionGroups.map((g) => ({ item: g, sort: g.sort, tie: 0 })),
            {
                item: '__ungrouped__',
                sort: activeLayoutData?.ungrouped_sort ?? sectionGroups.length,
                tie: 1
            }
        ];
        if (showPipeline && pipelineSlot && isVisible(pipelineSlot))
            entries.push({ item: '__pipeline__', sort: pipelineSlot.sort, tie: 2 });
        if (showTasks && tasksSlot && isVisible(tasksSlot))
            entries.push({ item: '__tasks__', sort: tasksSlot.sort, tie: 3 });
        if (showComments && commentsSlot && isVisible(commentsSlot))
            entries.push({ item: '__comments__', sort: commentsSlot.sort, tie: 4 });
        return entries.sort((a, b) => a.sort - b.sort || a.tie - b.tie).map((e) => e.item);
    }, [
        sectionGroups,
        activeLayoutData,
        pipelineSlot,
        commentsSlot,
        tasksSlot,
        showPipeline,
        showComments,
        showTasks
    ]);
    // ── Save / delete ──────────────────────────────────────────────────────────
    const saveMut = useMutation({
        mutationFn: async () => {
            const payload = {};
            for (const f of allFields) {
                if (SYSTEM_FIELDS.has(f.field) || f.readonly)
                    continue;
                if (f.field in draft)
                    payload[f.field] = draft[f.field];
            }
            let savedId;
            if (isNew) {
                const r = await client.request(post(`/items/${collection}`, payload));
                savedId = String(r.data.id);
            }
            else {
                await client.request(patch(`/items/${collection}/${itemId}`, payload));
                savedId = itemId;
            }
            const findM2MRel = (stagingKey) => {
                const byField = relations.find((r) => r.one_field === stagingKey && r.one_collection === collection);
                if (byField) {
                    const jf = byField.junction_field ??
                        relations.find((c) => c.many_collection === byField.many_collection && c.id !== byField.id)?.many_field ??
                        null;
                    return jf ? { ...byField, junction_field: jf } : null;
                }
                const parts = stagingKey.split('.');
                if (parts.length === 2) {
                    const [mc, jf] = parts;
                    const r = relations.find((rel) => rel.many_collection === mc);
                    return r ? { ...r, junction_field: jf } : null;
                }
                return null;
            };
            for (const [key, ids] of m2mUnlinks.entries()) {
                if (!ids.size)
                    continue;
                const rel = findM2MRel(key);
                if (!rel)
                    continue;
                await Promise.all([...ids].map((jId) => client.request(del(`/items/${rel.many_collection}/${jId}`)).catch(() => { })));
            }
            for (const [key, ids] of m2mLinks.entries()) {
                if (!ids.length)
                    continue;
                const rel = findM2MRel(key);
                if (!rel)
                    continue;
                await Promise.all(ids.map((relId) => client
                    .request(post(`/items/${rel.many_collection}`, {
                    [rel.many_field]: savedId,
                    [rel.junction_field]: relId
                }))
                    .catch(() => { })));
            }
            return savedId;
        },
        onSuccess: (id) => {
            setIsDirty(false);
            setM2mLinks(new Map());
            setM2mUnlinks(new Map());
            toast.success(isNew ? 'Record created' : 'Changes saved');
            qc.invalidateQueries({ queryKey: ['item', collection] });
            qc.invalidateQueries({ queryKey: ['m2m-items'] });
            onSaved?.(id);
        },
        onError: (err) => {
            const resp = err?.response;
            if (resp?.data?.field)
                setValidationErrors({ [resp.data.field]: resp.data.error ?? 'Invalid' });
            toast.error(resp?.data?.error ?? 'Failed to save');
        }
    });
    const deleteMut = useMutation({
        mutationFn: () => client.request(del(`/items/${collection}/${itemId}`)),
        onSuccess: () => {
            toast.success('Record deleted');
            qc.invalidateQueries({ queryKey: ['item', collection] });
            onDeleted?.();
        },
        onError: () => toast.error('Failed to delete')
    });
    const [confirmDelete, setConfirmDelete] = useState(false);
    // ── Render helpers ─────────────────────────────────────────────────────────
    const visibleFields = new Set();
    const lockedFields = new Set();
    function renderSentinel(key) {
        if (isNew)
            return null;
        if (key === '__pipeline__' && showPipeline) {
            return (_jsx(PipelinePanel, { collection: collection, item: itemId, title: pipelineSlot?.label_override ?? undefined, defaultExpanded: pipelineSlot?.default_expanded ?? false }, '__pipeline__'));
        }
        if (key === '__comments__' && showComments) {
            return (_jsx(CommentPanel, { collection: collection, item: itemId, title: commentsSlot?.label_override ?? undefined, defaultExpanded: commentsSlot?.default_expanded ?? false }, '__comments__'));
        }
        if (key === '__tasks__' && showTasks) {
            return (_jsx(TaskPanel, { collection: collection, item: itemId, title: tasksSlot?.label_override ?? undefined, defaultExpanded: tasksSlot?.default_expanded ?? false }, '__tasks__'));
        }
        return null;
    }
    function renderUngrouped() {
        const visible = ungroupedFields.filter((f) => !f.hidden);
        if (visible.length === 0)
            return null;
        return (_jsx("div", { className: 'rounded-xl border border-slate-200 bg-white px-5 py-5', children: _jsx("div", { className: 'grid grid-cols-12 gap-4 items-start', children: visible.map((f) => (_jsx("div", { className: getColSpanClass(f.options), children: _jsx(FieldRow, { field: f, draft: draft, onChange: handleFieldChange, relations: relations, collection: collection, itemId: itemId, error: validationErrors[f.field], visible: true, locked: isReadOnly, renderField: renderField }) }, f.field))) }) }, '__ungrouped__'));
    }
    function renderSectionItem(item) {
        if (item === '__ungrouped__')
            return renderUngrouped();
        if (item === '__pipeline__' || item === '__comments__' || item === '__tasks__')
            return renderSentinel(item);
        const g = item;
        const groupFields = groupedMap[g.key] ?? [];
        if (groupFields.length === 0)
            return null;
        return (_jsx(GroupSection, { group: g, fields: groupFields, draft: draft, onChange: handleFieldChange, relations: relations, collection: collection, itemId: itemId, errors: validationErrors, visibleFields: visibleFields, lockedFields: lockedFields, renderField: renderField }, g.key));
    }
    // ── Section mode ───────────────────────────────────────────────────────────
    function renderSectionMode() {
        return (_jsxs("div", { className: 'space-y-4', children: [sectionOrder.map((item, i) => {
                    const key = typeof item === 'string' ? item : item.key;
                    return _jsx("div", { children: renderSectionItem(item) }, key ?? i);
                }), !pipelineSlot && showPipeline && !isNew && (_jsx(PipelinePanel, { collection: collection, item: itemId })), !tasksSlot && showTasks && !isNew && _jsx(TaskPanel, { collection: collection, item: itemId }), !commentsSlot && showComments && !isNew && (_jsx(CommentPanel, { collection: collection, item: itemId })), showWorkflow && !isNew && _jsx(WorkflowPanel, { collection: collection, item: itemId })] }));
    }
    // ── Tab mode ───────────────────────────────────────────────────────────────
    function renderTabContent(tabKey) {
        const fields = (tabKey === '__general__'
            ? [...ungroupedFields, ...sectionGroups.flatMap((g) => groupedMap[g.key] ?? [])]
            : (groupedMap[tabKey] ?? [])).filter((f) => !f.hidden);
        return (_jsx("div", { className: 'rounded-xl border border-slate-200 bg-white px-5 py-5', children: _jsx("div", { className: 'grid grid-cols-12 gap-4 items-start', children: fields.map((f) => (_jsx("div", { className: getColSpanClass(f.options), children: _jsx(FieldRow, { field: f, draft: draft, onChange: handleFieldChange, relations: relations, collection: collection, itemId: itemId, error: validationErrors[f.field], visible: true, locked: isReadOnly, renderField: renderField }) }, f.field))) }) }));
    }
    function renderTabMode() {
        const tabStripItems = [
            ...(sectionGroups.length > 0 ? [{ key: '__general__', label: 'General' }] : []),
            ...tabGroups.map((g) => ({ key: g.key, label: g.label }))
        ];
        return (_jsxs("div", { className: 'space-y-4', children: [ungroupedFields.length > 0 && renderUngrouped(), _jsx("div", { className: 'flex border-b border-slate-200 overflow-x-auto gap-1 px-1', children: tabStripItems.map((t) => {
                        const hasErr = Object.keys(validationErrors).some((f) => {
                            const fc = allFields.find((field) => field.field === f);
                            return fc?.group_key === t.key || (!fc?.group_key && t.key === '__general__');
                        });
                        return (_jsxs("button", { type: 'button', onClick: () => setActiveTab(t.key), className: cn('whitespace-nowrap px-4 py-2.5 text-sm font-medium border-b-2 transition-colors flex items-center gap-1.5', activeTab === t.key
                                ? 'border-primary text-primary'
                                : 'border-transparent text-muted-foreground hover:text-foreground'), children: [t.label, hasErr && _jsx("span", { className: 'h-1.5 w-1.5 rounded-full bg-destructive' })] }, t.key));
                    }) }), renderTabContent(activeTab), !isNew &&
                    sectionOrder
                        .filter((item) => typeof item === 'string' && item !== '__ungrouped__')
                        .map((item) => renderSentinel(item)), !isNew && !pipelineSlot && showPipeline && (_jsx(PipelinePanel, { collection: collection, item: itemId })), !isNew && !tasksSlot && showTasks && _jsx(TaskPanel, { collection: collection, item: itemId }), !isNew && !commentsSlot && showComments && (_jsx(CommentPanel, { collection: collection, item: itemId })), showWorkflow && !isNew && _jsx(WorkflowPanel, { collection: collection, item: itemId })] }));
    }
    // ── Steps mode ─────────────────────────────────────────────────────────────
    function renderStepsMode() {
        const activeIdx = allSteps.findIndex((s) => s.key === activeTab);
        const isLast = activeIdx === allSteps.length - 1;
        const isFirst = activeIdx === 0;
        const stepNav = (_jsx("div", { className: 'mt-6 border-t border-slate-200 pt-4', children: _jsxs("div", { className: 'flex items-center justify-between gap-2', children: [_jsxs("button", { type: 'button', onClick: () => {
                            const idx = allSteps.findIndex((s) => s.key === activeTab);
                            if (idx > 0)
                                setActiveTab(allSteps[idx - 1].key);
                        }, disabled: isFirst, className: 'inline-flex items-center gap-1.5 rounded-md border border-slate-200 bg-white px-3 py-1.5 text-[12px] font-medium text-slate-600 transition-colors hover:bg-slate-50 disabled:pointer-events-none disabled:opacity-40', children: [_jsx(ChevronDown, { className: 'h-3.5 w-3.5 rotate-90' }), "Previous"] }), _jsxs("span", { className: 'text-[11px] text-slate-400', children: ["Step ", activeIdx + 1, " of ", allSteps.length] }), _jsxs("div", { className: 'flex items-center gap-2', children: [isLast && !isNew && showPipeline && (_jsx(PipelineTransitionButtons, { collection: collection, item: itemId, onBeforeTransition: () => {
                                    if (isDirty) {
                                        toast.error('Save changes before transitioning');
                                        return false;
                                    }
                                    return true;
                                } })), isLast ? (_jsxs("button", { type: 'button', onClick: () => saveMut.mutate(), disabled: saveMut.isPending || isReadOnly, className: 'inline-flex h-9 items-center gap-1.5 rounded-md bg-[#00ceff] px-3 text-[12px] font-medium text-white transition-colors hover:bg-[#00b8e0] disabled:opacity-50', children: [_jsx(Save, { className: 'h-3.5 w-3.5' }), saveMut.isPending ? 'Saving…' : 'Save'] })) : (_jsxs("button", { type: 'button', onClick: handleNext, className: 'inline-flex items-center gap-1.5 rounded-md bg-[#00ceff] px-3 py-1.5 text-[12px] font-medium text-white transition-colors hover:bg-[#00b8e0]', children: ["Next", _jsx(ChevronDown, { className: 'h-3.5 w-3.5 -rotate-90' })] }))] })] }) }));
        const allGroupSorts = [...tabGroups, ...sectionGroups].map((g) => g.sort);
        const minGroupSort = allGroupSorts.length > 0 ? Math.min(...allGroupSorts) : Infinity;
        const preTabSentinels = sectionOrder.filter((item) => {
            if (item === '__pipeline__')
                return !!(pipelineSlot && pipelineSlot.sort < minGroupSort);
            if (item === '__comments__')
                return !!(commentsSlot && commentsSlot.sort < minGroupSort);
            if (item === '__tasks__')
                return !!(tasksSlot && tasksSlot.sort < minGroupSort);
            return false;
        });
        const postTabItems = sectionOrder.filter((item) => {
            if (typeof item !== 'string')
                return false;
            if (item === '__ungrouped__')
                return false;
            if (item === '__pipeline__')
                return !(pipelineSlot && pipelineSlot.sort < minGroupSort);
            return !(item === '__comments__'
                ? commentsSlot && commentsSlot.sort < minGroupSort
                : item === '__tasks__'
                    ? tasksSlot && tasksSlot.sort < minGroupSort
                    : false);
        });
        return (_jsxs("div", { className: 'space-y-4 min-w-0 flex-1', children: [!isNew && preTabSentinels.map((key) => renderSentinel(key)), _jsx("div", { className: 'rounded-xl border border-slate-200 bg-white px-5 py-3', children: _jsx(StepsBar, { steps: allSteps, active: activeTab, completed: completedSteps, onStepClick: setActiveTab }) }), renderTabContent(activeTab), !isNew &&
                    postTabItems.map((item) => renderSectionItem(item)), !isNew && !pipelineSlot && showPipeline && (_jsx(PipelinePanel, { collection: collection, item: itemId, defaultExpanded: false })), !isNew && !tasksSlot && showTasks && (_jsx(TaskPanel, { collection: collection, item: itemId, defaultExpanded: false })), !isNew && !commentsSlot && showComments && (_jsx(CommentPanel, { collection: collection, item: itemId, defaultExpanded: false })), showWorkflow && _jsx(WorkflowPanel, { collection: collection, item: itemId }), stepNav] }));
    }
    // ── System fields ──────────────────────────────────────────────────────────
    function _renderSystemFields() {
        const sysToShow = systemFields.filter((f) => !f.hidden &&
            SYSTEM_FIELDS.has(f.field) &&
            draft[f.field] !== undefined &&
            draft[f.field] !== null);
        if (sysToShow.length === 0)
            return null;
        return (_jsxs("div", { className: 'rounded-xl border border-slate-200 bg-white px-5 py-4 space-y-3', children: [_jsx("p", { className: 'text-[11px] font-semibold uppercase tracking-wide text-muted-foreground', children: "System" }), _jsx("div", { className: 'grid grid-cols-2 gap-x-6 gap-y-2', children: sysToShow.map((f) => (_jsxs("div", { className: 'text-sm', children: [_jsxs("span", { className: 'text-muted-foreground', children: [f.label ?? titleCase(f.field), ": "] }), _jsx("span", { className: 'text-foreground', children: ['date_created', 'date_updated'].includes(f.field)
                                    ? formatRelative(String(draft[f.field]))
                                    : String(draft[f.field]) })] }, f.field))) })] }));
    }
    // ── Loading state ──────────────────────────────────────────────────────────
    const isLoading = fieldsLoading || (!isNew && itemLoading);
    if (isLoading) {
        return (_jsxs("div", { className: cn('flex flex-1 min-h-0 flex-col', className), children: [showHeader && (_jsx("div", { className: 'shrink-0 border-b px-6 py-4 flex items-center gap-3', children: _jsx(Skeleton, { className: 'h-6 w-40' }) })), _jsxs("div", { className: 'flex-1 overflow-y-auto p-6 space-y-4', children: [_jsx(Skeleton, { className: 'h-40 rounded-xl' }), _jsx(Skeleton, { className: 'h-32 rounded-xl' })] })] }));
    }
    const title = colMeta?.display_name ?? titleCase(collection ?? '');
    const canDelete = !isNew && isAdmin;
    return (_jsx(M2MStagingContext.Provider, { value: m2mStagingCtx, children: _jsxs("div", { className: cn('flex flex-1 min-h-0 flex-col', className), children: [showHeader && (_jsxs("header", { className: cn('shrink-0 border-b border-slate-200 bg-white px-6 py-3 flex items-center gap-3', headerClassName), children: [onBack && (_jsx("button", { type: 'button', onClick: onBack, className: 'text-muted-foreground hover:text-foreground transition-colors', children: _jsx(ArrowLeft, { className: 'h-4 w-4' }) })), _jsx("h1", { className: 'text-base font-semibold text-slate-800', children: isNew ? `New ${title}` : title }), _jsxs("div", { className: 'ml-auto flex items-center gap-2', children: [!isNew && showPipeline && !isStepsMode && (_jsx(PipelineTransitionButtons, { collection: collection, item: itemId, onBeforeTransition: () => {
                                        if (isDirty) {
                                            toast.error('Save changes before transitioning');
                                            return false;
                                        }
                                        return true;
                                    } })), showRevisions && !isNew && (_jsx(RevisionsPanel, { collection: collection, item: itemId, onRollback: () => qc.invalidateQueries({ queryKey: ['item', collection, itemId] }) })), canDelete &&
                                    (confirmDelete ? (_jsxs(_Fragment, { children: [_jsx("span", { className: 'text-sm text-muted-foreground', children: "Delete?" }), _jsx(Button, { type: 'button', size: 'sm', variant: 'destructive', className: 'gap-1.5', onClick: () => deleteMut.mutate(), disabled: deleteMut.isPending, children: deleteMut.isPending ? (_jsx(Loader2, { className: 'h-3.5 w-3.5 animate-spin' })) : ('Yes, delete') }), _jsx(Button, { type: 'button', size: 'sm', variant: 'outline', onClick: () => setConfirmDelete(false), children: "Cancel" })] })) : (_jsx(Button, { type: 'button', size: 'sm', variant: 'outline', className: 'gap-1.5 text-destructive hover:text-destructive', onClick: () => setConfirmDelete(true), children: _jsx(Trash2, { className: 'h-3.5 w-3.5' }) }))), !isStepsMode && (_jsxs(Button, { type: 'button', onClick: () => saveMut.mutate(), disabled: saveMut.isPending || isReadOnly, className: 'gap-1.5', children: [saveMut.isPending ? (_jsx(Loader2, { className: 'h-4 w-4 animate-spin' })) : (_jsx(Save, { className: 'h-4 w-4' })), isNew ? 'Create' : 'Save'] }))] })] })), _jsxs("div", { className: cn('flex-1 min-h-0', summaryEnabled && !isNew ? 'flex overflow-hidden' : 'overflow-y-auto'), children: [_jsxs("div", { ref: bodyRef, className: cn('p-6 space-y-4', summaryEnabled && !isNew ? 'flex-1 overflow-y-auto' : ''), children: [showLockBanner && (_jsx(ItemLockBanner, { lockHolder: lockHolder, onTakeOver: takeOver, takingOver: takingOver, isAdmin: isAdmin })), hasTabs ? (isStepsMode ? renderStepsMode() : renderTabMode()) : renderSectionMode()] }), summaryEnabled && !isNew && (_jsx("div", { className: 'w-64 shrink-0 overflow-y-auto border-l border-slate-200', children: _jsx(SummaryPanel, { allSteps: allSteps, groupedMap: groupedMap, ungroupedFields: ungroupedFields, sectionGroups: sectionGroups, draft: draft, relations: relations, collection: collection, itemId: itemId, staging: m2mStagingCtx, onFieldClick: (stepKey, fieldKey) => {
                                    setActiveTab(stepKey);
                                    setTimeout(() => {
                                        const el = document.querySelector(`[data-field="${fieldKey}"]`);
                                        if (el) {
                                            el.scrollIntoView({ behavior: 'smooth', block: 'center' });
                                            el.classList.add('ring-2', 'ring-nvr-cyan', 'ring-offset-2', 'rounded-md');
                                            setTimeout(() => el.classList.remove('ring-2', 'ring-nvr-cyan', 'ring-offset-2', 'rounded-md'), 1500);
                                            el.querySelector('input,textarea,select,button')?.focus();
                                        }
                                    }, 80);
                                } }) }))] })] }) }));
}
//# sourceMappingURL=ItemEditForm.js.map