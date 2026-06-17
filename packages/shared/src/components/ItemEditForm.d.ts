import { type ReactNode } from 'react';
import { type M2MStagingCtx } from './item-edit/M2MStagingContext';
import type { RenderFieldProps } from './item-edit/types';
export { M2MStagingContext, useM2MStaging } from './item-edit/M2MStagingContext';
export type { M2MStagingCtx, RenderFieldProps };
export interface ItemEditFormProps {
    collection: string;
    itemId?: string;
    layoutSlug?: string;
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
export declare function ItemEditForm({ collection, itemId: itemIdProp, layoutSlug, onBack, onSaved, onDeleted, showHeader, showRevisions, showPipeline, showWorkflow, showComments, showTasks, showLockBanner, className, headerClassName, renderField }: ItemEditFormProps): import("react").JSX.Element;
//# sourceMappingURL=ItemEditForm.d.ts.map