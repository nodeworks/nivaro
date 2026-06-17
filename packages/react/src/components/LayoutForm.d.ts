import React from 'react';
import type { ComponentOverrides, UseNivaroFormReturn } from '../types';
export type SlotRendererProps = {
    slot: string;
    collection: string;
    itemId: string | number | null | undefined;
    labelOverride: string | null;
    defaultExpanded: boolean;
};
type LayoutFormProps = {
    form: UseNivaroFormReturn;
    components?: ComponentOverrides;
    /** CSS class applied to the <form> element */
    className?: string;
    style?: React.CSSProperties;
    /** CSS class for a section group wrapper */
    sectionClassName?: string;
    /** CSS class for a tab strip wrapper */
    tabStripClassName?: string;
    /** CSS class for the active tab button */
    activeTabClassName?: string;
    /** CSS class for inactive tab buttons */
    inactiveTabClassName?: string;
    /** CSS class for the 12-col grid row (col_span chips snap to this) */
    gridClassName?: string;
    /**
     * Slot renderers — keyed by slot name (__pipeline__, __comments__, __tasks__).
     * Called with { slot, collection, itemId, labelOverride, defaultExpanded }.
     * If omitted, slots are silently skipped.
     */
    slotRenderers?: Record<string, (props: SlotRendererProps) => React.ReactNode>;
    /**
     * itemId of the currently-loaded item — needed for slot renderers.
     * For edit mode: pass the item id. For create mode: leave undefined.
     */
    itemId?: string | number | null;
    /** CSS class for the stepper strip wrapper (steps mode) */
    stepperClassName?: string;
    /** CSS class for the prev/next button bar (steps mode) */
    stepNavClassName?: string;
    /** CSS class for the Prev button */
    prevButtonClassName?: string;
    /** CSS class for the Next/Save button */
    nextButtonClassName?: string;
    /** Extra content rendered before the Save button on the last step (steps mode only) */
    lastStepActions?: React.ReactNode;
    /**
     * Layout slug that was used to load this form's schema.
     * Informational only — schema resolution happens in useNivaroForm.
     */
    layoutSlug?: string;
};
/**
 * Full layout-aware form renderer.
 *
 * Renders the form exactly as configured in the Layout tab:
 * - Tab-type groups become clickable tabs (or step wizards when tabMode='steps')
 * - Section-type groups become collapsible sections
 * - Ungrouped fields appear at the position set in the Layout tab
 * - Fields honour their col_span width inside a 12-column grid
 * - Page slots (__pipeline__, __comments__, __tasks__) rendered via slotRenderers
 *
 * Zero CSS shipped — style via className props or data-* attributes.
 */
export declare function LayoutForm({ form, components, className, style, sectionClassName, tabStripClassName, activeTabClassName, inactiveTabClassName, gridClassName, slotRenderers, itemId, stepperClassName, stepNavClassName, prevButtonClassName, nextButtonClassName, lastStepActions, layoutSlug: _layoutSlug }: LayoutFormProps): React.JSX.Element | null;
export {};
//# sourceMappingURL=LayoutForm.d.ts.map