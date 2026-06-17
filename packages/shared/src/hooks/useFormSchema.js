import { useEffect, useRef, useState } from 'react';
import { get } from '../lib/commands';
const UNGROUPED_POS_SENTINEL = '__ungrouped_pos__';
const SLOT_KEYS = new Set(['__pipeline__', '__comments__', '__tasks__']);
function toBool(v) {
    return v === true || v === 1 || v === '1' || v === 'true';
}
function titleCaseField(key) {
    return key
        .replace(/[_-]+/g, ' ')
        .replace(/([a-z])([A-Z])/g, '$1 $2')
        .trim()
        .split(/\s+/)
        .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
        .join(' ');
}
function parseJsonColumn(input) {
    if (input == null)
        return null;
    if (typeof input !== 'string')
        return input;
    try {
        return JSON.parse(input);
    }
    catch {
        return null;
    }
}
export function normalizeFieldType(rawType, iface, relation) {
    const type = (rawType ?? '').toLowerCase();
    const i = (iface ?? '').toLowerCase();
    if (relation) {
        if (relation.type === 'm2o')
            return 'relation-m2o';
        if (relation.type === 'o2m')
            return 'relation-o2m';
        if (relation.type === 'm2m')
            return 'relation-m2m';
        if (relation.type === 'm2a')
            return 'relation-m2o';
    }
    switch (i) {
        case 'input':
        case 'input-autocomplete':
            return 'text';
        case 'textarea':
        case 'input-multiline':
            return 'textarea';
        case 'input-integer':
        case 'slider':
            return 'integer';
        case 'input-float':
            return 'float';
        case 'toggle':
        case 'boolean':
            return 'boolean';
        case 'datetime':
            return type === 'date' ? 'date' : 'datetime';
        case 'select-dropdown':
        case 'select-radio':
            return 'select';
        case 'select-multiple-dropdown':
            return 'checkbox-group';
        case 'radio-buttons':
            return 'radio';
        case 'file':
            return 'file';
        case 'many-to-one':
            return 'relation-m2o';
        case 'one-to-many':
            return 'relation-o2m';
        case 'many-to-many':
            return 'relation-m2m';
        case 'code':
        case 'input-code':
            return 'json';
        case 'input-wysiwyg':
        case 'wysiwyg':
        case 'input-rich-text-html':
        case 'input-rich-text-md':
        case 'markdown':
        case 'rich-text':
            return 'wysiwyg';
    }
    switch (type) {
        case 'string':
        case 'text':
        case 'char':
        case 'varchar':
            return 'text';
        case 'integer':
        case 'biginteger':
        case 'int':
        case 'bigint':
            return 'integer';
        case 'float':
        case 'double':
        case 'real':
            return 'float';
        case 'decimal':
        case 'numeric':
            return 'decimal';
        case 'boolean':
        case 'bit':
            return 'boolean';
        case 'date':
            return 'date';
        case 'datetime':
        case 'timestamp':
            return 'datetime';
        case 'json':
            return 'json';
        case 'uuid':
            return iface === 'file' ? 'file' : 'uuid';
    }
    return 'unknown';
}
function buildFieldRelation(collection, field, relations) {
    for (const rel of relations) {
        const type = (rel.type ?? '').toLowerCase();
        const displayTemplate = rel.related_display_template ?? rel.display_template ?? null;
        if (rel.many_collection === collection && rel.many_field === field) {
            return {
                type: type === 'm2a' ? 'm2a' : 'm2o',
                relatedCollection: rel.one_collection ?? '',
                displayTemplate,
                manyField: rel.many_field ?? null,
                junctionField: rel.junction_field ?? null
            };
        }
        if (rel.one_collection === collection && rel.one_field === field) {
            const isM2M = type === 'm2m' || !!rel.junction_field;
            if (isM2M) {
                const junctionCollection = rel.many_collection ?? '';
                const junctionField = rel.junction_field ?? '';
                const farEndRel = relations.find((r) => r.many_collection === junctionCollection && r.many_field === junctionField);
                const farEndCollection = farEndRel?.one_collection ?? junctionCollection;
                return {
                    type: 'm2m',
                    relatedCollection: farEndCollection,
                    junctionCollection,
                    displayTemplate,
                    manyField: rel.many_field ?? null,
                    junctionField: rel.junction_field ?? null
                };
            }
            return {
                type: 'o2m',
                relatedCollection: rel.many_collection ?? '',
                displayTemplate,
                manyField: rel.many_field ?? null,
                junctionField: rel.junction_field ?? null
            };
        }
    }
    return null;
}
function buildSchema(collection, meta, groupRows, includeHidden, assignmentMap) {
    const rawFields = meta.fields ?? [];
    const relations = meta.relations ?? [];
    const fields = rawFields
        .filter((f) => {
        if (!includeHidden && toBool(f.hidden))
            return false;
        if (assignmentMap != null) {
            const a = assignmentMap.get(f.field);
            if (!a)
                return false;
            if (a.is_visible === false)
                return false;
        }
        return true;
    })
        .map((f) => {
        const baseRelation = buildFieldRelation(collection, f.field, relations);
        const optionsTemplate = parseJsonColumn(f.options)?.template ?? null;
        const relation = baseRelation && !baseRelation.displayTemplate && optionsTemplate
            ? { ...baseRelation, displayTemplate: optionsTemplate }
            : baseRelation;
        const type = f.type ?? 'string';
        const iface = f.interface ?? null;
        const entry = assignmentMap?.get(f.field);
        return {
            field: f.field,
            type,
            fieldType: normalizeFieldType(type, iface, relation),
            interface: iface,
            label: (entry?.label_override ?? f.label ?? titleCaseField(f.field)),
            note: f.note ?? null,
            required: toBool(f.required),
            readonly: toBool(f.readonly),
            hidden: toBool(f.hidden),
            sort: entry?.sort ?? f.sort ?? null,
            group: assignmentMap != null ? (entry?.group_key ?? null) : (f.group_key ?? null),
            options: parseJsonColumn(f.options) ??
                parseJsonColumn(f.remote_options_config),
            validationRules: parseJsonColumn(f.validation_rules),
            visibilityRules: parseJsonColumn(f.visibility_rules),
            lockCondition: parseJsonColumn(f.lock_condition),
            relation,
            defaultValue: f.default_value,
            cascadeFilters: parseJsonColumn(f.dependency_config)?.cascade_filters ?? null
        };
    })
        .sort((a, b) => {
        if (a.sort == null && b.sort == null)
            return 0;
        if (a.sort == null)
            return 1;
        if (b.sort == null)
            return -1;
        return a.sort - b.sort;
    });
    const groups = (groupRows ?? [])
        .map((g) => ({
        key: g.key,
        label: g.label,
        type: (g.type ?? 'section'),
        icon: g.icon ?? null,
        sort: g.sort ?? 0,
        isCollapsed: toBool(g.is_collapsed)
    }))
        .sort((a, b) => a.sort - b.sort);
    return {
        collection: meta.collection,
        displayName: meta.display_name ?? null,
        singleton: toBool(meta.singleton),
        draftPublishEnabled: toBool(meta.draft_publish_enabled),
        fields,
        groups,
        ungroupedSort: null,
        tabMode: null,
        aiEnabled: false,
        summaryEnabled: false,
        validateBeforeNext: false,
        slotAssignments: []
    };
}
function extractSlots(assignments) {
    return assignments
        .filter((a) => SLOT_KEYS.has(a.field))
        .map((a) => ({
        slot: a.field,
        groupKey: a.group_key ?? null,
        sort: a.sort,
        labelOverride: a.label_override ?? null,
        isVisible: a.is_visible == null ? true : toBool(a.is_visible),
        defaultExpanded: toBool(a.default_expanded)
    }));
}
export async function fetchSchema(client, collection, includeHidden, layoutId) {
    if (layoutId != null) {
        const [collectionRes, layoutRes, groupsRes, assignmentsRes] = await Promise.all([
            client.request(get(`/collections/${collection}`)),
            client
                .request(get(`/collection-layouts/${layoutId}`))
                .catch(() => ({ data: undefined })),
            client.request(get(`/field-groups/${collection}`, { layout_id: layoutId })),
            client.request(get(`/collection-layouts/${layoutId}/assignments`))
        ]);
        const assignmentMap = new Map();
        let ungroupedSort = null;
        const allAssignments = assignmentsRes.data ?? [];
        for (const a of allAssignments) {
            if (a.field === UNGROUPED_POS_SENTINEL) {
                ungroupedSort = a.sort;
                continue;
            }
            if (SLOT_KEYS.has(a.field))
                continue;
            assignmentMap.set(a.field, {
                group_key: a.group_key,
                sort: a.sort,
                is_visible: a.is_visible == null ? true : toBool(a.is_visible),
                label_override: a.label_override ?? null,
                default_expanded: a.default_expanded
            });
        }
        const schema = buildSchema(collection, collectionRes.data, groupsRes.data ?? [], includeHidden, assignmentMap);
        schema.ungroupedSort = ungroupedSort;
        const lm = layoutRes.data;
        schema.tabMode = lm?.tab_mode === 'steps' ? 'steps' : lm?.tab_mode === 'tabs' ? 'tabs' : null;
        schema.aiEnabled = toBool(lm?.ai_enabled);
        schema.summaryEnabled = toBool(lm?.summary_enabled);
        schema.validateBeforeNext = toBool(lm?.validate_before_next);
        schema.slotAssignments = extractSlots(allAssignments);
        return schema;
    }
    const [collectionRes, activeRes] = await Promise.all([
        client.request(get(`/collections/${collection}`)),
        client
            .request(get('/collection-layouts/active', { collection }))
            .catch(() => ({
            data: {
                groups: [],
                assignments: [],
                ungrouped_sort: null
            }
        }))
    ]);
    const assignmentMap = new Map();
    let ungroupedSort = activeRes.data.ungrouped_sort ?? null;
    for (const a of activeRes.data.assignments ?? []) {
        if (a.field === UNGROUPED_POS_SENTINEL) {
            ungroupedSort = a.sort;
            continue;
        }
        if (SLOT_KEYS.has(a.field))
            continue;
        assignmentMap.set(a.field, { group_key: a.group_key, sort: a.sort });
    }
    const schema = buildSchema(collection, collectionRes.data, activeRes.data.groups ?? [], includeHidden, assignmentMap.size > 0 ? assignmentMap : undefined);
    schema.ungroupedSort = ungroupedSort;
    const layoutMeta = activeRes.data.layout;
    schema.tabMode =
        layoutMeta?.tab_mode === 'steps' ? 'steps' : layoutMeta?.tab_mode === 'tabs' ? 'tabs' : null;
    schema.aiEnabled = toBool(layoutMeta?.ai_enabled);
    schema.summaryEnabled = toBool(layoutMeta?.summary_enabled);
    schema.validateBeforeNext = toBool(layoutMeta?.validate_before_next);
    schema.slotAssignments = extractSlots(activeRes.data.assignments ?? []);
    return schema;
}
const schemaCache = new Map();
function cacheKey(clientUrl, collection, includeHidden, layoutId) {
    return `${clientUrl}::${collection}::${includeHidden ? 'h' : ''}::${layoutId ?? 'active'}`;
}
export function useFormSchema(client, collection, includeHidden = false, layoutId) {
    const key = client ? cacheKey(client.url, collection, includeHidden, layoutId) : null;
    const [schema, setSchema] = useState(() => key ? (schemaCache.get(key) ?? null) : null);
    const [loading, setLoading] = useState(() => !(key && schemaCache.has(key)));
    const [error, setError] = useState(null);
    const reqIdRef = useRef(0);
    useEffect(() => {
        if (!client || !collection) {
            setLoading(false);
            return;
        }
        const cached = schemaCache.get(key);
        if (cached) {
            setError(null);
            setSchema(cached);
            setLoading(false);
            return;
        }
        const reqId = ++reqIdRef.current;
        let active = true;
        setError(null);
        setSchema(null);
        setLoading(true);
        fetchSchema(client, collection, includeHidden, layoutId)
            .then((s) => {
            if (!active || reqId !== reqIdRef.current)
                return;
            schemaCache.set(key, s);
            setSchema(s);
            setLoading(false);
        })
            .catch((err) => {
            if (!active || reqId !== reqIdRef.current)
                return;
            setError(err instanceof Error ? err : new Error(String(err)));
            setLoading(false);
        });
        return () => {
            active = false;
        };
    }, [client, collection, includeHidden, key, layoutId]);
    return { schema, loading, error };
}
export function clearFormSchemaCache(collection) {
    if (!collection) {
        schemaCache.clear();
        return;
    }
    for (const k of Array.from(schemaCache.keys())) {
        if (k.includes(`::${collection}::`))
            schemaCache.delete(k);
    }
}
//# sourceMappingURL=useFormSchema.js.map