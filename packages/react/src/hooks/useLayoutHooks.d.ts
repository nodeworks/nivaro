import type { FormFieldDescriptor, FormGroupDescriptor, UseNivaroFormReturn } from '../types';
export type FieldState = {
    value: unknown;
    error: string[] | undefined;
    visible: boolean;
    locked: boolean;
    required: boolean;
    colSpan: number;
    descriptor: FormFieldDescriptor | null;
    onChange: (v: unknown) => void;
};
export declare function useFieldState(form: UseNivaroFormReturn, field: string): FieldState;
export declare function useWatchFields(form: UseNivaroFormReturn, fields: string[]): Record<string, unknown>;
export type FormDirtyState = {
    isDirty: boolean;
    dirtyFields: string[];
    isFieldDirty: (field: string) => boolean;
};
export declare function useFormDirty(form: UseNivaroFormReturn, initialValuesOverride?: Record<string, unknown>): FormDirtyState;
export type TabState = {
    activeTab: string | null;
    setActiveTab: (key: string) => void;
    tabs: FormGroupDescriptor[];
    hasTabs: boolean;
};
export declare function useTabState(form: UseNivaroFormReturn): TabState;
export type SectionState = {
    isCollapsed: (key: string) => boolean;
    toggle: (key: string) => void;
    collapseAll: () => void;
    expandAll: () => void;
};
export declare function useSectionState(form: UseNivaroFormReturn, defaultCollapsed?: string[]): SectionState;
export type LayoutItem = FormGroupDescriptor | '__ungrouped__';
export declare function useOrderedLayout(form: UseNivaroFormReturn): {
    items: LayoutItem[];
    hasTabs: boolean;
    tabGroups: FormGroupDescriptor[];
    sectionGroups: FormGroupDescriptor[];
    ungroupedFields: FormFieldDescriptor[];
};
export type FormStatus = {
    isDirty: boolean;
    isValid: boolean;
    isSubmitting: boolean;
    isLoading: boolean;
    canSubmit: boolean;
};
export declare function useFormStatus(form: UseNivaroFormReturn): FormStatus;
export type FieldArrayReturn = {
    items: unknown[];
    append: (item?: unknown) => void;
    remove: (index: number) => void;
    move: (from: number, to: number) => void;
    update: (index: number, value: unknown) => void;
    replace: (items: unknown[]) => void;
};
export declare function useFieldArray(form: UseNivaroFormReturn, field: string): FieldArrayReturn;
//# sourceMappingURL=useLayoutHooks.d.ts.map