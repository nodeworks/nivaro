import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { Badge } from '../ui/badge';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { Switch } from '../ui/switch';
import { Textarea } from '../ui/textarea';
import { parseJson, toLocalDatetime } from './helpers';
import { InlineGridField } from './InlineGridField';
import { M2MCombobox, M2MSingleSelectCombobox } from './M2MCombobox';
import { RelationCombobox } from './RelationCombobox';
import { RichTextEditor } from './RichTextEditor';
export function FieldRenderer({ field, value, onChange, relations, collection, itemId, cascadeFilter, requiredParentLabel }) {
    const iface = field.interface ?? '';
    const isRelIface = !iface ||
        iface.startsWith('relation-') ||
        iface === 'select-multiple-m2m' ||
        iface.endsWith('-m2o') ||
        iface.endsWith('-m2m');
    // M2O
    const m2oRel = isRelIface
        ? relations.find((r) => r.many_collection === collection && r.many_field === field.field && !r.junction_field)
        : null;
    if (m2oRel?.one_collection) {
        return (_jsx(RelationCombobox, { collection: m2oRel.one_collection, value: value, onChange: onChange, disabled: field.readonly, placeholder: field.placeholder ?? undefined, extraFilter: cascadeFilter, requiredParent: requiredParentLabel ?? undefined }));
    }
    // M2M
    const m2mRel = isRelIface && !m2oRel
        ? (() => {
            const r = relations.find((rel) => rel.one_collection === collection && rel.one_field === field.field);
            if (!r)
                return null;
            if (r.junction_field)
                return r;
            const companion = relations.find((c) => c.many_collection === r.many_collection && c.id !== r.id);
            return companion ? { ...r, junction_field: companion.many_field } : null;
        })()
        : null;
    if (m2mRel) {
        if (!itemId || itemId === 'new')
            return (_jsx("p", { className: 'text-[12px] text-slate-400 py-1', children: "Save the record first to manage related items" }));
        const fieldOpts = parseJson(field.options);
        if (fieldOpts?.max_values === 1) {
            return (_jsx(M2MSingleSelectCombobox, { relation: m2mRel, parentId: itemId, allRelations: relations, extraFilter: cascadeFilter, requiredParent: requiredParentLabel ?? undefined }));
        }
        return (_jsx(M2MCombobox, { relation: m2mRel, parentId: itemId, allRelations: relations, extraFilter: cascadeFilter, requiredParent: requiredParentLabel ?? undefined }));
    }
    // Read-only display
    if (field.readonly) {
        const display = value === null || value === undefined ? (_jsx("span", { className: 'text-muted-foreground italic text-sm', children: "\u2014" })) : typeof value === 'boolean' ? (_jsx(Badge, { variant: value ? 'default' : 'secondary', children: value ? 'Yes' : 'No' })) : (_jsx("span", { className: 'text-sm', children: String(value) }));
        return _jsx("div", { className: 'min-h-[36px] flex items-center', children: display });
    }
    const strVal = value === null || value === undefined ? '' : String(value);
    if (field.type === 'boolean') {
        return (_jsxs("div", { className: 'flex items-center gap-2', children: [_jsx(Switch, { checked: Boolean(value), onCheckedChange: onChange }), _jsx(Label, { className: 'font-normal text-sm', children: value ? 'Yes' : 'No' })] }));
    }
    if (field.type === 'datetime' || iface === 'datetime') {
        return (_jsx(Input, { type: 'datetime-local', value: toLocalDatetime(value), onChange: (e) => onChange(e.target.value ? new Date(e.target.value).toISOString() : null), placeholder: field.placeholder ?? undefined }));
    }
    if (field.type === 'date' || iface === 'date') {
        return (_jsx(Input, { type: 'date', value: strVal.slice(0, 10), onChange: (e) => onChange(e.target.value || null), placeholder: field.placeholder ?? undefined }));
    }
    const isNumeric = ['integer', 'bigInteger', 'float', 'decimal', 'numeric'].includes(field.type);
    if (isNumeric) {
        const isInt = field.type === 'integer' || field.type === 'bigInteger';
        return (_jsx(Input, { type: 'number', step: isInt ? '1' : 'any', value: strVal, onChange: (e) => onChange(e.target.value === '' ? null : Number(e.target.value)), placeholder: field.placeholder ?? undefined }));
    }
    if (field.type === 'json' || iface === 'code') {
        return (_jsx(Textarea, { className: 'font-mono text-xs', rows: 4, value: typeof value === 'object' ? JSON.stringify(value, null, 2) : strVal, onChange: (e) => {
                try {
                    onChange(JSON.parse(e.target.value));
                }
                catch {
                    onChange(e.target.value);
                }
            }, placeholder: field.placeholder ?? undefined }));
    }
    if (iface === 'textarea') {
        return (_jsx(Textarea, { rows: 4, value: strVal, onChange: (e) => onChange(e.target.value), placeholder: field.placeholder ?? undefined }));
    }
    if (iface === 'wysiwyg' || iface === 'markdown') {
        return (_jsx(Textarea, { rows: 6, value: strVal, onChange: (e) => onChange(e.target.value), placeholder: field.placeholder ?? undefined, className: 'font-mono text-sm' }));
    }
    if (iface === 'input-rich-text-html' ||
        iface === 'rich_text' ||
        field.type === 'rich_text' ||
        iface === 'extension-editorjs') {
        return (_jsx(RichTextEditor, { value: strVal, onChange: onChange, placeholder: field.placeholder ?? undefined, disabled: field.readonly }));
    }
    if (iface === 'inline-grid' || iface === 'relation-list' || iface === 'list-o2m') {
        const o2mRel = relations.find((r) => r.one_collection === collection &&
            !r.junction_field &&
            (r.one_field === field.field || r.many_collection === field.field));
        if (o2mRel) {
            const o2mCol = o2mRel.many_collection ?? null;
            const o2mManyField = o2mRel.many_field ?? null;
            if (o2mCol && o2mManyField && itemId && itemId !== 'new') {
                return (_jsx(InlineGridField, { relatedCollection: o2mCol, manyField: o2mManyField, parentId: itemId }));
            }
            return (_jsx("p", { className: 'text-[12px] text-slate-400 py-1', children: !itemId || itemId === 'new'
                    ? 'Save the record first to manage related rows'
                    : 'Inline grid editing not available in embedded form' }));
        }
    }
    // Select / dropdown
    if (iface === 'select-dropdown' || iface === 'radio-buttons') {
        const opts = (() => {
            const parsed = parseJson(field.options);
            return parsed?.choices ?? [];
        })();
        if (opts.length > 0) {
            return (_jsxs("select", { value: strVal, onChange: (e) => onChange(e.target.value || null), className: 'h-9 w-full rounded-md border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring', children: [_jsx("option", { value: '', children: "\u2014 Select \u2014" }), opts.map((o) => (_jsx("option", { value: o.value, children: o.text }, o.value)))] }));
        }
    }
    return (_jsx(Input, { value: strVal, onChange: (e) => onChange(e.target.value || null), placeholder: field.placeholder ?? undefined }));
}
//# sourceMappingURL=FieldRenderer.js.map