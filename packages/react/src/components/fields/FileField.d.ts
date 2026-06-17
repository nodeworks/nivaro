import type { FieldComponentProps } from '../../types';
/**
 * Unstyled file input. On selection it uploads via client.upload() (POST /files)
 * and calls onChange with the returned file id. Renders the current id/url as text.
 *
 * On upload error the file input is reset via a key increment so the browser
 * doesn't show the failed filename as if the upload succeeded.
 */
export declare function FileField({ field, value, onChange, error, disabled, readOnly, inputId, errorId }: FieldComponentProps): import("react").JSX.Element;
//# sourceMappingURL=FileField.d.ts.map