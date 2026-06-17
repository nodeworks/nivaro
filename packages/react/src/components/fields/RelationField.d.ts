import type { FieldComponentProps } from '../../types';
/**
 * Unstyled relation picker.
 *  - m2o: single <select> of related items
 *  - o2m / m2m: multi <select> of related item ids
 *
 * Options are fetched from the related collection via useRelationOptions and
 * labelled with the relation's display template.
 *
 * If no NivaroClient is available (neither via NivaroProvider nor passed
 * directly to the field consumer), a visible error is shown instead of a
 * silently-empty picker.
 */
export declare function RelationField({ field, value, onChange, error, disabled, readOnly, inputId, errorId }: FieldComponentProps): import("react").JSX.Element;
//# sourceMappingURL=RelationField.d.ts.map