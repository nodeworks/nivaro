import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import Link from '@tiptap/extension-link';
import Placeholder from '@tiptap/extension-placeholder';
import Underline from '@tiptap/extension-underline';
import { EditorContent, useEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { Bold, Check, Code, Heading1, Heading2, Heading3, Italic, Link2Off, Link as LinkIcon, List, ListOrdered, Minus, Quote, Strikethrough, UnderlineIcon, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { cn } from '../../lib/utils';
function esc(s) {
    return s
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}
export function editorJsToHtml(raw) {
    try {
        const doc = JSON.parse(raw || '{}');
        return (doc.blocks ?? [])
            .map((b) => {
            const text = esc(String(b.data.text ?? ''));
            const level = Math.max(1, Math.min(6, Number(b.data.level ?? 2)));
            switch (b.type) {
                case 'paragraph':
                    return `<p>${text}</p>`;
                case 'header':
                    return `<h${level}>${text}</h${level}>`;
                case 'list': {
                    const items = (b.data.items ?? [])
                        .map((i) => `<li>${esc(i)}</li>`)
                        .join('');
                    return b.data.style === 'ordered' ? `<ol>${items}</ol>` : `<ul>${items}</ul>`;
                }
                case 'quote':
                    return `<blockquote><p>${text}</p></blockquote>`;
                default:
                    return text ? `<p>${text}</p>` : '';
            }
        })
            .join('');
    }
    catch {
        return `<p>${esc(raw)}</p>`;
    }
}
// ─── Tiptap toolbar primitives ─────────────────────────────────────────────────
export function TiptapToolbarButton({ active, title, onClick, children }) {
    return (_jsx("button", { type: 'button', title: title, onMouseDown: (e) => {
            e.preventDefault();
            onClick();
        }, className: cn('flex h-6 w-6 items-center justify-center rounded text-slate-500 transition-colors hover:bg-slate-200 hover:text-slate-700', active && 'bg-slate-200 text-slate-900'), children: children }));
}
export function TiptapDivider() {
    return _jsx("div", { className: 'mx-0.5 h-4 w-px bg-slate-200' });
}
// ─── RichTextEditor ────────────────────────────────────────────────────────────
export function RichTextEditor({ value, onChange, placeholder, disabled }) {
    const [linkInputOpen, setLinkInputOpen] = useState(false);
    const [linkUrl, setLinkUrl] = useState('');
    const linkInputRef = useRef(null);
    const initialHtml = useMemo(() => {
        if (!value)
            return '';
        const isEditorJs = value.trimStart().startsWith('{"time":') && value.includes('"blocks":');
        return isEditorJs ? editorJsToHtml(value) : value;
    }, [value]); // eslint-disable-line react-hooks/exhaustive-deps — initialHtml is init-only
    const editor = useEditor({
        immediatelyRender: false,
        extensions: [
            StarterKit.configure({ bulletList: { keepMarks: true }, orderedList: { keepMarks: true } }),
            Underline,
            Placeholder.configure({ placeholder: placeholder ?? 'Start writing…' }),
            Link.configure({ openOnClick: false, autolink: true })
        ],
        content: initialHtml,
        editable: !disabled,
        onUpdate({ editor }) {
            onChange(editor.getHTML());
        }
    });
    const prevValue = useRef(value);
    useEffect(() => {
        if (!editor || prevValue.current === value)
            return;
        prevValue.current = value;
        const isEditorJs = value.trimStart().startsWith('{"time":') && value.includes('"blocks":');
        const html = isEditorJs ? editorJsToHtml(value) : value || '';
        if (editor.getHTML() !== html) {
            editor.commands.setContent(html, { emitUpdate: false });
        }
    }, [editor, value]);
    if (!editor)
        return null;
    const openLinkInput = () => {
        const prev = editor.getAttributes('link').href;
        setLinkUrl(prev ?? 'https://');
        setLinkInputOpen(true);
        setTimeout(() => linkInputRef.current?.select(), 0);
    };
    const commitLink = () => {
        if (linkUrl === '')
            editor.chain().focus().extendMarkRange('link').unsetLink().run();
        else
            editor.chain().focus().extendMarkRange('link').setLink({ href: linkUrl }).run();
        setLinkInputOpen(false);
        setLinkUrl('');
    };
    const cancelLink = () => {
        setLinkInputOpen(false);
        setLinkUrl('');
    };
    return (_jsxs("div", { className: cn('overflow-hidden rounded-md border border-slate-200 bg-background focus-within:ring-1 focus-within:ring-[#00ceff] focus-within:border-[#00ceff]', disabled && 'opacity-60'), children: [!disabled && (_jsxs(_Fragment, { children: [_jsxs("div", { className: 'flex flex-wrap items-center gap-0.5 border-b border-slate-200 bg-slate-50 px-2 py-1.5', children: [_jsx(TiptapToolbarButton, { title: 'Bold', active: editor.isActive('bold'), onClick: () => editor.chain().focus().toggleBold().run(), children: _jsx(Bold, { className: 'h-3.5 w-3.5' }) }), _jsx(TiptapToolbarButton, { title: 'Italic', active: editor.isActive('italic'), onClick: () => editor.chain().focus().toggleItalic().run(), children: _jsx(Italic, { className: 'h-3.5 w-3.5' }) }), _jsx(TiptapToolbarButton, { title: 'Underline', active: editor.isActive('underline'), onClick: () => editor.chain().focus().toggleUnderline().run(), children: _jsx(UnderlineIcon, { className: 'h-3.5 w-3.5' }) }), _jsx(TiptapToolbarButton, { title: 'Strikethrough', active: editor.isActive('strike'), onClick: () => editor.chain().focus().toggleStrike().run(), children: _jsx(Strikethrough, { className: 'h-3.5 w-3.5' }) }), _jsx(TiptapDivider, {}), _jsx(TiptapToolbarButton, { title: 'Heading 1', active: editor.isActive('heading', { level: 1 }), onClick: () => editor.chain().focus().toggleHeading({ level: 1 }).run(), children: _jsx(Heading1, { className: 'h-3.5 w-3.5' }) }), _jsx(TiptapToolbarButton, { title: 'Heading 2', active: editor.isActive('heading', { level: 2 }), onClick: () => editor.chain().focus().toggleHeading({ level: 2 }).run(), children: _jsx(Heading2, { className: 'h-3.5 w-3.5' }) }), _jsx(TiptapToolbarButton, { title: 'Heading 3', active: editor.isActive('heading', { level: 3 }), onClick: () => editor.chain().focus().toggleHeading({ level: 3 }).run(), children: _jsx(Heading3, { className: 'h-3.5 w-3.5' }) }), _jsx(TiptapDivider, {}), _jsx(TiptapToolbarButton, { title: 'Bullet list', active: editor.isActive('bulletList'), onClick: () => editor.chain().focus().toggleBulletList().run(), children: _jsx(List, { className: 'h-3.5 w-3.5' }) }), _jsx(TiptapToolbarButton, { title: 'Ordered list', active: editor.isActive('orderedList'), onClick: () => editor.chain().focus().toggleOrderedList().run(), children: _jsx(ListOrdered, { className: 'h-3.5 w-3.5' }) }), _jsx(TiptapDivider, {}), _jsx(TiptapToolbarButton, { title: 'Blockquote', active: editor.isActive('blockquote'), onClick: () => editor.chain().focus().toggleBlockquote().run(), children: _jsx(Quote, { className: 'h-3.5 w-3.5' }) }), _jsx(TiptapToolbarButton, { title: 'Code block', active: editor.isActive('codeBlock'), onClick: () => editor.chain().focus().toggleCodeBlock().run(), children: _jsx(Code, { className: 'h-3.5 w-3.5' }) }), _jsx(TiptapToolbarButton, { title: 'Horizontal rule', onClick: () => editor.chain().focus().setHorizontalRule().run(), children: _jsx(Minus, { className: 'h-3.5 w-3.5' }) }), _jsx(TiptapDivider, {}), _jsx(TiptapToolbarButton, { title: 'Link', active: editor.isActive('link'), onClick: openLinkInput, children: _jsx(LinkIcon, { className: 'h-3.5 w-3.5' }) }), editor.isActive('link') && (_jsx(TiptapToolbarButton, { title: 'Remove link', onClick: () => editor.chain().focus().unsetLink().run(), children: _jsx(Link2Off, { className: 'h-3.5 w-3.5' }) }))] }), linkInputOpen && (_jsxs("div", { className: 'flex items-center gap-1.5 border-b border-slate-200 bg-slate-50 px-2 py-1.5', children: [_jsx("input", { ref: linkInputRef, type: 'url', value: linkUrl, onChange: (e) => setLinkUrl(e.target.value), onKeyDown: (e) => {
                                    if (e.key === 'Enter') {
                                        e.preventDefault();
                                        commitLink();
                                    }
                                    if (e.key === 'Escape') {
                                        e.preventDefault();
                                        cancelLink();
                                    }
                                }, placeholder: 'https://example.com', "aria-label": 'Link URL', className: 'flex-1 rounded border border-slate-200 bg-white px-2 py-0.5 text-[12px] text-slate-700 outline-none focus:border-[#00ceff]' }), _jsx("button", { type: 'button', title: 'Apply link', onMouseDown: (e) => {
                                    e.preventDefault();
                                    commitLink();
                                }, className: 'flex h-5 w-5 items-center justify-center rounded text-emerald-600 hover:bg-emerald-50', children: _jsx(Check, { className: 'h-3.5 w-3.5' }) }), _jsx("button", { type: 'button', title: 'Cancel', onMouseDown: (e) => {
                                    e.preventDefault();
                                    cancelLink();
                                }, className: 'flex h-5 w-5 items-center justify-center rounded text-slate-400 hover:bg-slate-100', children: _jsx(X, { className: 'h-3.5 w-3.5' }) })] }))] })), _jsx(EditorContent, { editor: editor, className: 'nivaro-rich-text min-h-[120px] px-3 py-2 text-[13px] [&_.tiptap]:outline-none [&_.tiptap]:min-h-[100px] [&_.tiptap_p]:my-1 [&_.tiptap_h1]:text-xl [&_.tiptap_h2]:text-lg [&_.tiptap_h3]:text-base [&_.tiptap_h1,&_.tiptap_h2,&_.tiptap_h3]:font-semibold [&_.tiptap_ul]:list-disc [&_.tiptap_ol]:list-decimal [&_.tiptap_ul,&_.tiptap_ol]:pl-5 [&_.tiptap_blockquote]:border-l-2 [&_.tiptap_blockquote]:border-slate-300 [&_.tiptap_blockquote]:pl-3 [&_.tiptap_blockquote]:text-slate-500 [&_.tiptap_code]:bg-slate-100 [&_.tiptap_code]:rounded [&_.tiptap_code]:px-1 [&_.tiptap_pre]:bg-slate-100 [&_.tiptap_pre]:rounded [&_.tiptap_pre]:p-2 [&_.tiptap_pre]:font-mono [&_.tiptap_p.is-editor-empty:first-child::before]:content-[attr(data-placeholder)] [&_.tiptap_p.is-editor-empty:first-child::before]:text-slate-400 [&_.tiptap_p.is-editor-empty:first-child::before]:pointer-events-none [&_.tiptap_p.is-editor-empty:first-child::before]:float-left [&_.tiptap_p.is-editor-empty:first-child::before]:h-0' })] }));
}
//# sourceMappingURL=RichTextEditor.js.map