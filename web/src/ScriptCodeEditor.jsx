import { useEffect, useRef } from 'react';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { javascript } from '@codemirror/lang-javascript';
import { Annotation, EditorState } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';

const externalSync = Annotation.define();

export function ScriptCodeEditor({ value, onChange, minHeight = '310px' }) {
  const hostRef = useRef(null);
  const viewRef = useRef(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    if (!hostRef.current) return undefined;
    const state = EditorState.create({
      doc: String(value || ''),
      extensions: [
        history(),
        keymap.of([...defaultKeymap, ...historyKeymap]),
        javascript(),
        EditorView.lineWrapping,
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
            event.stopPropagation();
            return false;
          },
        }),
      ],
    });
    const view = new EditorView({ state, parent: hostRef.current });
    viewRef.current = view;
    return () => { view.destroy(); viewRef.current = null; };
  }, [minHeight]);

  useEffect(() => {
    const view = viewRef.current;
    const next = String(value || '');
    if (!view || view.state.doc.toString() === next) return;
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: next },
      annotations: externalSync.of(true),
    });
  }, [value]);

  return <div ref={hostRef} className="script-code-editor cm-template-editor" />;
}
