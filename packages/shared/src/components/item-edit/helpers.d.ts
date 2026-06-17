export declare function applyDisplayTemplate(template: string | null | undefined, item: Record<string, unknown>): string;
export declare function parseJson<T>(v: unknown): T | null;
export type CascadeRule = {
    parent_field: string;
    filter_column: string;
    filter_is_m2m?: boolean;
    clear_on_parent_change?: boolean;
    clear_on_unavailable?: boolean;
    show_all_if_no_parent?: boolean;
};
export declare function getCascadeFilters(depConfig: Record<string, unknown> | string | null): CascadeRule[];
export declare function CascadeEffectController({ cascadeRules, cascadeFilter, currentValue, relatedCollection, onClear }: {
    cascadeRules: CascadeRule[];
    cascadeFilter?: Record<string, unknown>;
    currentValue?: unknown;
    relatedCollection?: string;
    onClear: () => void;
}): null;
export declare const COL_SPAN_CLASS: Record<number, string>;
export declare function getColSpanClass(options: Record<string, unknown> | string | null): string;
export declare function toLocalDatetime(value: unknown): string;
export declare const SYSTEM_FIELDS: Set<string>;
export declare const SENTINEL_FIELDS: Set<string>;
//# sourceMappingURL=helpers.d.ts.map