import { type ReactNode } from 'react';
export declare function editorJsToHtml(raw: string): string;
export declare function TiptapToolbarButton({ active, title, onClick, children }: {
    active?: boolean;
    title: string;
    onClick: () => void;
    children: ReactNode;
}): import("react").JSX.Element;
export declare function TiptapDivider(): import("react").JSX.Element;
export declare function RichTextEditor({ value, onChange, placeholder, disabled }: {
    value: string;
    onChange: (v: unknown) => void;
    placeholder?: string;
    disabled?: boolean;
}): import("react").JSX.Element | null;
//# sourceMappingURL=RichTextEditor.d.ts.map