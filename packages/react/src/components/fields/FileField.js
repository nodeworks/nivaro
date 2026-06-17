import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useState } from 'react';
import { useOptionalNivaroClient } from '../../context';
/**
 * Unstyled file input. On selection it uploads via client.upload() (POST /files)
 * and calls onChange with the returned file id. Renders the current id/url as text.
 *
 * On upload error the file input is reset via a key increment so the browser
 * doesn't show the failed filename as if the upload succeeded.
 */
export function FileField({ field, value, onChange, error, disabled, readOnly, inputId, errorId }) {
    const client = useOptionalNivaroClient();
    const [uploading, setUploading] = useState(false);
    const [uploadError, setUploadError] = useState(null);
    // Incrementing this key forces the <input> to remount, clearing the
    // selected filename after a failed upload.
    const [inputKey, setInputKey] = useState(0);
    const id = inputId ?? field.field;
    const currentId = value != null && typeof value === 'object'
        ? String(value.id ?? '')
        : value == null
            ? ''
            : String(value);
    return (_jsxs("div", { children: [_jsx("input", { type: 'file', id: id, name: field.field, disabled: disabled || readOnly || uploading || !client, "aria-invalid": (error != null && error.length > 0) || uploadError != null, "aria-describedby": errorId, onChange: async (e) => {
                    const file = e.target.files?.[0];
                    if (!file || !client)
                        return;
                    setUploading(true);
                    setUploadError(null);
                    try {
                        const result = await client.upload(file, { title: file.name });
                        onChange(result.id);
                    }
                    catch (err) {
                        setUploadError(err instanceof Error ? err.message : 'Upload failed');
                        // Reset the file input so it doesn't show the failed filename.
                        setInputKey((k) => k + 1);
                    }
                    finally {
                        setUploading(false);
                    }
                } }, inputKey), uploading ? _jsx("span", { "aria-live": 'polite', children: "Uploading\u2026" }) : null, currentId && client ? (_jsx("a", { href: client.fileUrl(currentId), target: '_blank', rel: 'noreferrer', children: currentId })) : currentId ? (_jsx("span", { children: currentId })) : null, uploadError ? _jsx("span", { role: 'alert', children: uploadError }) : null] }));
}
//# sourceMappingURL=FileField.js.map