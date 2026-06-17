import type { FormFieldDescriptor, FormFieldType, FormSchema } from '../types';
export interface CMSFieldRow {
    field: string;
    type?: string | null;
    interface?: string | null;
    label?: string | null;
    note?: string | null;
    required?: boolean | number | null;
    readonly?: boolean | number | null;
    hidden?: boolean | number | null;
    sort?: number | null;
    group_key?: string | null;
    options?: unknown;
    validation_rules?: unknown;
    visibility_rules?: unknown;
    lock_condition?: unknown;
    default_value?: unknown;
    [key: string]: unknown;
}
export interface CMSRelationRow {
    type?: string | null;
    many_collection?: string | null;
    many_field?: string | null;
    one_collection?: string | null;
    one_field?: string | null;
    junction_collection?: string | null;
    junction_field?: string | null;
    display_template?: string | null;
    related_display_template?: string | null;
    [key: string]: unknown;
}
export interface CMSCollectionResponse {
    collection: string;
    display_name?: string | null;
    singleton?: boolean | number | null;
    draft_publish_enabled?: boolean | number | null;
    fields?: CMSFieldRow[];
    relations?: CMSRelationRow[];
}
export interface CMSGroupRow {
    key: string;
    label: string;
    type?: 'section' | 'tab' | null;
    icon?: string | null;
    sort?: number | null;
    is_collapsed?: boolean | number | null;
}
export declare const UNGROUPED_POS_SENTINEL = "__ungrouped_pos__";
export declare function toBool(v: unknown): boolean;
export declare function parseJsonColumn<T>(input: unknown): T | null;
/**
 * Map a raw DB type + CMS interface string to the normalized FormFieldType
 * the renderer uses to choose a component.
 */
export declare function normalizeFieldType(rawType: string, iface: string | null, relation: FormFieldDescriptor['relation']): FormFieldType;
export declare function buildSchema(collection: string, meta: CMSCollectionResponse, groupRows: CMSGroupRow[], includeHidden: boolean, assignmentMap?: Map<string, {
    group_key: string | null;
    sort: number;
    is_visible?: boolean;
}>): FormSchema;
//# sourceMappingURL=schemaBuilder.d.ts.map