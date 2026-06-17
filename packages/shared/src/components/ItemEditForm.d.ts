import { type ReactNode } from 'react';
export type RenderFieldProps = {
    field: any;
    value: unknown;
    onChange: (v: unknown) => void;
    disabled: boolean;
    collection: string;
    itemId: string;
    relations: any[];
    cascadeFilter?: Record<string, unknown>;
    unsatisfiedParentLabel?: string | null;
};
export interface M2MStagingCtx {
    getStagedLinks: (key: string) => unknown[];
    getStagedUnlinks: (key: string) => Set<unknown>;
    stageLink: (key: string, relatedId: unknown) => void;
    stageUnlink: (key: string, junctionId: unknown) => void;
    unstageLink: (key: string, relatedId: unknown) => void;
    unstageUnlink: (key: string, junctionId: unknown) => void;
}
export declare const M2MStagingContext: import("react").Context<M2MStagingCtx | null>;
export declare function useM2MStaging(): M2MStagingCtx | null;
export interface ItemEditFormProps {
    collection: string;
    itemId?: string;
    onBack?: () => void;
    onSaved?: (id: string) => void;
    onDeleted?: () => void;
    showHeader?: boolean;
    showRevisions?: boolean;
    showPipeline?: boolean;
    showWorkflow?: boolean;
    showComments?: boolean;
    showTasks?: boolean;
    showLockBanner?: boolean;
    className?: string;
    headerClassName?: string;
    renderField?: (props: RenderFieldProps) => ReactNode;
}
export declare function ItemEditForm({ collection, itemId: itemIdProp, onBack, onSaved, onDeleted, showHeader, showRevisions, showPipeline, showWorkflow, showComments, showTasks, showLockBanner, className, headerClassName, renderField }: ItemEditFormProps): import("react").JSX.Element;
//# sourceMappingURL=ItemEditForm.d.ts.map