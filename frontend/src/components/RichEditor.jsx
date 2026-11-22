import { useEffect, useRef, useState } from 'react';
import { EditorContent, useEditor, useEditorState } from '@tiptap/react';
import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import StarterKit from '@tiptap/starter-kit';
import { TextStyle, Color, BackgroundColor, FontSize } from '@tiptap/extension-text-style';
import TextAlign from '@tiptap/extension-text-align';
import { Placeholder } from '@tiptap/extensions';
import {
  AlignCenter, AlignLeft, AlignRight, Baseline, Bold, Braces, ChevronDown, Code2, Eraser, Highlighter, Italic,
  Link2, List, ListOrdered, Redo2, Strikethrough, Underline as UnderlineIcon, Undo2, Wand2,
} from 'lucide-react';
import { cx } from './ui.jsx';
import { formatPitch, needsCodeMode, plainTextToHtml, toEmailHtml, wordCount } from '../lib/pitchFormat.js';

export const VARIABLES = [
  ['firstName|there', 'First name, or “there” if unknown'], ['firstName', 'First name'], ['lastName', 'Last name'], ['companyName', 'Company'], ['email', 'Recipient email'],
  ['fullName', 'Full name'], ['senderName', 'Sender name (from the sending account)'], ['senderEmail', 'Sender email'], ['employeeName', 'Your profile name'],
];
const TEXT_COLORS = [['Default', null], ['Black', '#111827'], ['Gray', '#6b7280'], ['Red', '#dc2626'], ['Orange', '#ea580c'], ['Green', '#16a34a'], ['Blue', '#2563eb'], ['Purple', '#7c3aed']];
const HIGHLIGHTS = [['None', null], ['Yellow', '#fef08a'], ['Green', '#bbf7d0'], ['Blue', '#bfdbfe'], ['Pink', '#fbcfe8'], ['Orange', '#fed7aa'], ['Purple', '#e9d5ff']];
const SIZES = [['Small', '13px'], ['Normal', null], ['Large', '18px'], ['Heading', '22px']];

/** Shows {{variables}} as chips while editing (display only; the saved HTML is unchanged). */
const VariableChips = Extension.create({
  name: 'variableChips',
  addProseMirrorPlugins() {
    return [new Plugin({
      key: new PluginKey('variableChips'),
      props: {
        decorations(state) {
          const decos = [];
          state.doc.descendants((node, pos) => {
            if (!node.isText) return;
            for (const m of node.text.matchAll(/\{\{\s*[\w.]+\s*(?:\|[^{}]*)?\}\}/g)) decos.push(Decoration.inline(pos + m.index, pos + m.index + m[0].length, { class: 'ep-var' }));
          });
          return DecorationSet.create(state.doc, decos);
        },
      },
    })];
  },
});

function Popover({ button, children, align = 'left', width = 'w-56' }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const close = (e) => { if (!ref.current?.contains(e.target)) setOpen(false); };
    const esc = (e) => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); } }; // don't also close the surrounding modal
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', esc); };
  }, [open]);
  return (
    <div ref={ref} className="relative">
      {button({ open, toggle: () => setOpen((o) => !o) })}
      {open && (
        <div className={cx('absolute top-full z-30 mt-1.5 animate-pop rounded-2xl border border-line bg-card p-2 shadow-xl', width, align === 'right' ? 'right-0' : 'left-0')}>
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

function Tool({ icon: Icon, label, active, onClick, disabled, children, className }) {
  return (
    <button type="button" title={label} aria-label={label} aria-pressed={active ?? undefined} disabled={disabled}
      onMouseDown={(e) => e.preventDefault()} onClick={onClick}
      className={cx('inline-flex h-8 min-w-8 items-center justify-center gap-1 rounded-lg px-1.5 text-fg2 transition hover:bg-subtle hover:text-fg disabled:opacity-40',
        active && 'bg-brand-500/15 text-brand-700 dark:text-brand-300', className)}>
      {Icon && <Icon className="h-4 w-4" strokeWidth={2} />}
      {children}
    </button>
  );
}
const Sep = () => <span className="mx-0.5 h-5 w-px bg-line" aria-hidden />;

function Swatches({ items, current, onPick, kind }) {
  return (
    <div className="grid grid-cols-4 gap-1.5">
      {items.map(([name, value]) => (
        <button key={name} type="button" title={name} onMouseDown={(e) => e.preventDefault()} onClick={() => onPick(value)}
          className={cx('flex h-9 items-center justify-center rounded-lg border text-[11px] font-semibold transition hover:scale-105',
            (current || null) === value ? 'border-brand-500 ring-2 ring-brand-500/30' : 'border-line')}
          style={kind === 'bg' ? { background: value || '#fff', color: '#111827' } : { background: '#fff', color: value || '#1f2937' }}>
          {value ? 'Aa' : <span className="text-slate-400">∅</span>}
        </button>
      ))}
    </div>
  );
}

function LinkForm({ editor, close }) {
  const existing = editor.getAttributes('link').href || '';
  const [url, setUrl] = useState(existing);
  const apply = () => {
    let href = url.trim();
    if (!href) { editor.chain().focus().extendMarkRange('link').unsetLink().run(); close(); return; }
    if (!/^(https?:|mailto:|tel:)/i.test(href)) href = href.includes('@') && !href.includes('/') ? `mailto:${href}` : `https://${href}`;
    const { empty } = editor.state.selection;
    if (empty && !editor.isActive('link')) editor.chain().focus().insertContent({ type: 'text', text: url.trim(), marks: [{ type: 'link', attrs: { href } }] }).run();
    else editor.chain().focus().extendMarkRange('link').setLink({ href }).run();
    close();
  };
  return (
    <form onSubmit={(e) => { e.preventDefault(); apply(); }} className="space-y-2">
      <span className="label">Link address</span>
      <input autoFocus className="input" placeholder="https://yourwebsite.com" value={url} onChange={(e) => setUrl(e.target.value)} />
      <div className="flex justify-end gap-1.5">
        {existing && <button type="button" className="rounded-full px-3 py-1.5 text-xs text-red-600 hover:bg-red-500/10" onClick={() => { editor.chain().focus().extendMarkRange('link').unsetLink().run(); close(); }}>Remove</button>}
        <button type="submit" className="rounded-full bg-inv px-3 py-1.5 text-xs font-medium text-inv-fg">Apply</button>
      </div>
    </form>
  );
}

export function VariableMenu({ onInsert, align = 'left', compact }) {
  return (
    <Popover align={align} width="w-80" button={({ open, toggle }) => (
      compact
        ? <Tool icon={Braces} label="Insert variable" active={open} onClick={toggle} />
        : <Tool icon={Braces} label="Insert variable" active={open} onClick={toggle} className="px-2.5"><span className="hidden text-xs font-medium sm:inline">Variables</span><ChevronDown className="h-3 w-3" /></Tool>
    )}>
      {(close) => (
        <div>
          <div className="px-2 pt-1 pb-2 text-xs text-muted">Filled in for each recipient</div>
          {VARIABLES.map(([key, label]) => (
            <button key={key} type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => { onInsert(`{{${key}}}`); close(); }}
              className="flex w-full items-center justify-between rounded-lg px-2 py-1.5 text-left text-sm text-fg hover:bg-subtle">
              {label}<code className="ep-var text-[11px]">{`{{${key}}}`}</code>
            </button>
          ))}
          <div className="mt-1 space-y-1 border-t border-line px-2 pt-2 text-[11px] text-muted">
            <div>Missing names are filled from the email address (ravi.kumar@… → Ravi).</div>
            <div>Add a fallback after <code>|</code>: <code>{'{{firstName|there}}'}</code> → “Hi there,” when no name is known.</div>
            <div>Any column from your Excel / CSV also works, e.g. <code>{'{{city}}'}</code>.</div>
          </div>
        </div>
      )}
    </Popover>
  );
}

/**
 * Visual email editor. `initialHtml` is read when `resetKey` changes; `onChange` receives email-ready HTML.
 */
export default function RichEditor({ initialHtml = '', resetKey, onChange, placeholder = 'Write your email…', minHeight = 280 }) {
  const [mode, setMode] = useState(() => (needsCodeMode(initialHtml) ? 'code' : 'visual'));
  const [code, setCode] = useState(initialHtml);
  const [flash, setFlash] = useState(false);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: false, code: false, codeBlock: false, blockquote: false, horizontalRule: false,
        link: { openOnClick: false, autolink: true, defaultProtocol: 'https', HTMLAttributes: { target: null, rel: null, class: null } },
      }),
      TextStyle, Color, BackgroundColor, FontSize,
      TextAlign.configure({ types: ['paragraph'] }),
      Placeholder.configure({ placeholder }),
      VariableChips,
    ],
    content: needsCodeMode(initialHtml) ? '' : initialHtml,
    editorProps: {
      attributes: { class: 'ep-doc focus:outline-none', spellcheck: 'true' },
      handlePaste(view, event) {
        const cd = event.clipboardData;
        if (!cd || cd.getData('text/html') || cd.files?.length) return false;
        const text = cd.getData('text/plain');
        if (!text || !/\n/.test(text)) return false;
        view.pasteHTML(plainTextToHtml(text)); // no event → this handler is not re-entered
        return true;
      },
    },
    onUpdate: ({ editor: ed }) => onChangeRef.current?.(toEmailHtml(ed.getHTML())),
  });

  // Reset when a different pitch is opened.
  useEffect(() => {
    if (!editor) return;
    const codeMode = needsCodeMode(initialHtml);
    setMode(codeMode ? 'code' : 'visual');
    setCode(initialHtml);
    if (!codeMode) editor.commands.setContent(initialHtml || '', { emitUpdate: false });
    onChangeRef.current?.(codeMode ? initialHtml : toEmailHtml(editor.getHTML()));
  }, [editor, resetKey]);

  const st = useEditorState({
    editor,
    selector: ({ editor: e }) => e && ({
      bold: e.isActive('bold'), italic: e.isActive('italic'), underline: e.isActive('underline'), strike: e.isActive('strike'),
      bullet: e.isActive('bulletList'), ordered: e.isActive('orderedList'), link: e.isActive('link'),
      color: e.getAttributes('textStyle').color || null, bg: e.getAttributes('textStyle').backgroundColor || null,
      size: e.getAttributes('textStyle').fontSize || null,
      align: ['center', 'right'].find((a) => e.isActive({ textAlign: a })) || 'left',
      canUndo: e.can().undo(), canRedo: e.can().redo(), words: wordCount(e.getHTML()),
    }),
  }) || {};

  if (!editor) return null;
  const chain = () => editor.chain().focus();

  const format = () => {
    const html = mode === 'code' ? code : editor.getHTML();
    const tidy = formatPitch(html);
    if (mode === 'code') setMode('visual');
    editor.commands.setContent(tidy || '<p></p>', { emitUpdate: true });
    onChangeRef.current?.(toEmailHtml(editor.getHTML()));
    setFlash(true);
    setTimeout(() => setFlash(false), 900);
  };
  const toCode = () => { const html = toEmailHtml(editor.getHTML()); setCode(html); setMode('code'); onChangeRef.current?.(html); };
  const toVisual = () => {
    if (needsCodeMode(code) && !window.confirm('This HTML has layout (tables, images or headings) the visual editor can’t keep. Switch anyway?')) return;
    editor.commands.setContent(code || '', { emitUpdate: false });
    setMode('visual');
    onChangeRef.current?.(toEmailHtml(editor.getHTML()));
  };
  const insertVar = (v) => {
    if (mode === 'code') { const n = code + v; setCode(n); onChangeRef.current?.(n); return; }
    chain().insertContent(v).run();
  };

  const sizeLabel = SIZES.find(([, v]) => v === st.size)?.[0] || 'Normal';
  return (
    <div className={cx('overflow-hidden rounded-2xl border border-line bg-card transition focus-within:border-brand-400 focus-within:ring-4 focus-within:ring-brand-500/10', flash && 'ring-4 ring-brand-500/25')}>
      <div className="flex flex-wrap items-center gap-0.5 border-b border-line bg-subtle/60 px-2 py-1.5">
        {mode === 'visual' ? (
          <>
            <Tool icon={Undo2} label="Undo" disabled={!st.canUndo} onClick={() => chain().undo().run()} />
            <Tool icon={Redo2} label="Redo" disabled={!st.canRedo} onClick={() => chain().redo().run()} />
            <Sep />
            <Popover width="w-36" button={({ open, toggle }) => <Tool label="Text size" active={open} onClick={toggle} className="px-2 text-xs font-medium">{sizeLabel}<ChevronDown className="h-3 w-3" /></Tool>}>
              {(close) => SIZES.map(([name, v]) => (
                <button key={name} type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => { (v ? chain().setFontSize(v) : chain().unsetFontSize()).run(); close(); }}
                  className={cx('block w-full rounded-lg px-2 py-1.5 text-left text-fg hover:bg-subtle', st.size === v && 'bg-subtle')} style={{ fontSize: v || '15px' }}>{name}</button>
              ))}
            </Popover>
            <Sep />
            <Tool icon={Bold} label="Bold (Ctrl+B)" active={st.bold} onClick={() => chain().toggleBold().run()} />
            <Tool icon={Italic} label="Italic (Ctrl+I)" active={st.italic} onClick={() => chain().toggleItalic().run()} />
            <Tool icon={UnderlineIcon} label="Underline (Ctrl+U)" active={st.underline} onClick={() => chain().toggleUnderline().run()} />
            <Tool icon={Strikethrough} label="Strikethrough" active={st.strike} onClick={() => chain().toggleStrike().run()} />
            <Popover button={({ open, toggle }) => (
              <Tool icon={Baseline} label="Text colour" active={open} onClick={toggle} className="relative">
                <span className="absolute inset-x-2 bottom-1 h-0.5 rounded" style={{ background: st.color || 'currentColor' }} />
              </Tool>
            )}>
              {(close) => <><div className="label px-1">Text colour</div><Swatches items={TEXT_COLORS} current={st.color} onPick={(v) => { (v ? chain().setColor(v) : chain().unsetColor()).run(); close(); }} /></>}
            </Popover>
            <Popover button={({ open, toggle }) => (
              <Tool icon={Highlighter} label="Highlight" active={open || Boolean(st.bg)} onClick={toggle} className="relative">
                <span className="absolute inset-x-2 bottom-1 h-0.5 rounded" style={{ background: st.bg || '#fde047' }} />
              </Tool>
            )}>
              {(close) => <><div className="label px-1">Highlight</div><Swatches kind="bg" items={HIGHLIGHTS} current={st.bg} onPick={(v) => { (v ? chain().setBackgroundColor(v) : chain().unsetBackgroundColor()).run(); close(); }} /></>}
            </Popover>
            <Sep />
            <Tool icon={List} label="Bullet list" active={st.bullet} onClick={() => chain().toggleBulletList().run()} />
            <Tool icon={ListOrdered} label="Numbered list" active={st.ordered} onClick={() => chain().toggleOrderedList().run()} />
            <Tool icon={AlignLeft} label="Align left" active={st.align === 'left'} onClick={() => chain().setTextAlign('left').run()} />
            <Tool icon={AlignCenter} label="Align centre" active={st.align === 'center'} onClick={() => chain().setTextAlign('center').run()} />
            <Tool icon={AlignRight} label="Align right" active={st.align === 'right'} onClick={() => chain().setTextAlign('right').run()} />
            <Sep />
            <Popover width="w-72" button={({ open, toggle }) => <Tool icon={Link2} label="Link" active={open || st.link} onClick={toggle} />}>
              {(close) => <LinkForm editor={editor} close={close} />}
            </Popover>
            <Tool icon={Eraser} label="Clear formatting" onClick={() => chain().unsetAllMarks().unsetTextAlign().clearNodes().run()} />
            <VariableMenu onInsert={insertVar} />
          </>
        ) : (
          <>
            <span className="px-2 text-xs font-medium text-muted">HTML source</span>
            <VariableMenu onInsert={insertVar} />
          </>
        )}
        <div className="ml-auto flex items-center gap-1">
          <Tool icon={Code2} label={mode === 'code' ? 'Back to visual editor' : 'Edit HTML'} active={mode === 'code'} onClick={mode === 'code' ? toVisual : toCode} />
          <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={format} title="Tidy spacing, greeting, bullets, links and signature"
            className="brand-gradient inline-flex h-8 items-center gap-1.5 rounded-full px-3.5 text-xs font-semibold text-white shadow-sm transition hover:brightness-110 active:scale-[.97]">
            <Wand2 className="h-3.5 w-3.5" /> Format
          </button>
        </div>
      </div>

      {mode === 'visual' ? (
        <div className="ep-paper cursor-text overflow-y-auto" style={{ minHeight, maxHeight: '58vh' }} onClick={(e) => { if (e.target === e.currentTarget) editor.commands.focus('end'); }}>
          <EditorContent editor={editor} />
        </div>
      ) : (
        <textarea className="block w-full resize-y bg-card p-4 font-mono text-xs leading-relaxed text-fg focus:outline-none" style={{ minHeight }} value={code} spellCheck={false}
          onChange={(e) => { setCode(e.target.value); onChangeRef.current?.(e.target.value); }} />
      )}

      <div className="flex items-center justify-between gap-3 border-t border-line px-3 py-1.5 text-[11px] text-muted">
        <span>{mode === 'visual' ? `${st.words || 0} words · about ${Math.max(1, Math.round((st.words || 0) / 200 * 60))} sec to read` : 'Editing raw HTML'}</span>
        <span className="hidden sm:inline">Tip: paste from Word, Gmail or Notepad, then press <b className="text-fg2">Format</b></span>
      </div>
    </div>
  );
}