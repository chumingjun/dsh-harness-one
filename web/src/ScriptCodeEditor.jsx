import { useEffect, useRef } from 'react';
import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap } from '@codemirror/autocomplete';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { javascript } from '@codemirror/lang-javascript';
import {
  bracketMatching,
  defaultHighlightStyle,
  foldGutter,
  foldKeymap,
  HighlightStyle,
  indentOnInput,
  syntaxHighlighting,
} from '@codemirror/language';
import { Annotation, EditorState } from '@codemirror/state';
import {
  drawSelection,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
} from '@codemirror/view';
import { tags } from '@lezer/highlight';

const externalSync = Annotation.define();

// 暗色高亮，对齐画布设计令牌（紫 #8B5CF6 / 青 #06B6D4）
const scriptHighlight = HighlightStyle.define([
  { tag: [tags.keyword, tags.modifier, tags.controlKeyword], color: '#C4B5FD' },
  { tag: [tags.string, tags.special(tags.string)], color: '#6EE7B7' },
  { tag: [tags.number, tags.bool, tags.null, tags.atom], color: '#FBBF24' },
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName)], color: '#67E8F9' },
  { tag: tags.propertyName, color: '#93C5FD' },
  { tag: [tags.variableName, tags.self], color: '#E7E2D9' },
  { tag: [tags.definition(tags.variableName), tags.local(tags.variableName)], color: '#E7E2D9' },
  { tag: [tags.comment, tags.blockComment], color: '#8A857C', fontStyle: 'italic' },
  { tag: [tags.operator, tags.punctuation, tags.separator], color: '#B8B2A7' },
  { tag: [tags.typeName, tags.className, tags.standard(tags.variableName)], color: '#FCA5A5' },
  { tag: tags.regexp, color: '#F0ABFC' },
  { tag: tags.invalid, color: '#F87171' },
]);

const scriptTheme = EditorView.theme(
  {
    '&': { backgroundColor: 'transparent' },
    '.cm-gutters': {
      backgroundColor: 'rgba(255,255,255,0.02)',
      color: 'var(--fg-faint)',
      border: 'none',
      borderRight: '1px solid var(--border)',
    },
    '.cm-lineNumbers .cm-gutterElement': { padding: '0 8px 0 10px', minWidth: '30px' },
    '.cm-activeLine': { backgroundColor: 'rgba(139,92,246,0.08)' },
    '.cm-activeLineGutter': { backgroundColor: 'rgba(139,92,246,0.12)', color: 'var(--fg)' },
    '.cm-matchingBracket': { backgroundColor: 'rgba(6,182,212,0.25)', outline: 'none' },
    '.cm-nonmatchingBracket': { backgroundColor: 'rgba(248,113,113,0.3)' },
    '.cm-foldGutter span': { cursor: 'pointer', color: 'var(--fg-faint)' },
    '.cm-foldGutter span:hover': { color: 'var(--fg)' },
    '.cm-foldPlaceholder': {
      backgroundColor: 'rgba(139,92,246,0.15)',
      border: 'none',
      color: 'var(--fg-muted)',
      margin: '0 2px',
      padding: '0 4px',
      borderRadius: '4px',
    },
  },
  { dark: true },
);

export function ScriptCodeEditor({ value, onChange, minHeight = '310px', readOnly = false }) {
  const hostRef = useRef(null);
  const viewRef = useRef(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    if (!hostRef.current) return undefined;
    const state = EditorState.create({
      doc: String(value || ''),
      extensions: [
        lineNumbers(),
        highlightActiveLineGutter(),
        foldGutter(),
        history(),
        drawSelection(),
        indentOnInput(),
        bracketMatching(),
        closeBrackets(),
        autocompletion(),
        highlightActiveLine(),
        keymap.of([
          ...closeBracketsKeymap,
          ...defaultKeymap,
          ...historyKeymap,
          ...foldKeymap,
          ...completionKeymap,
          indentWithTab,
        ]),
        javascript(),
        syntaxHighlighting(scriptHighlight),
        // 兜底：javascript() 之外的标签用默认高亮再叠一层，避免漏色
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        scriptTheme,
        EditorView.lineWrapping,
        EditorView.editable.of(!readOnly),
        EditorState.readOnly.of(readOnly),
        EditorView.theme({
          '&': { minHeight },
          '.cm-scroller': { minHeight: 'inherit', maxHeight: '58vh', overflow: 'auto' },
        }),
        EditorView.updateListener.of((update) => {
          const synced = update.transactions.some((transaction) => transaction.annotation(externalSync));
          if (update.docChanged && !synced) onChangeRef.current?.(update.state.doc.toString());
        }),
        EditorView.domEventHandlers({
          keydown(event) {
            // 面板外层有全局快捷键（Delete/Cmd+D），编辑器内按键不外泄
            event.stopPropagation();
            return false;
          },
        }),
      ],
    });
    const view = new EditorView({ state, parent: hostRef.current });
    viewRef.current = view;
    return () => { view.destroy(); viewRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [minHeight, readOnly]);

  useEffect(() => {
    const view = viewRef.current;
    const next = String(value || '');
    if (!view || view.state.doc.toString() === next) return;
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: next },
      annotations: externalSync.of(true),
    });
  }, [value]);

  return <div ref={hostRef} className="tpl-cm script-code-editor" />;
}
