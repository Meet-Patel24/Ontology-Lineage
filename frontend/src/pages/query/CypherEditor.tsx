import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap, completionStatus } from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { bracketMatching } from "@codemirror/language";
import { EditorState, Prec } from "@codemirror/state";
import { EditorView, keymap, placeholder } from "@codemirror/view";
import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { cypherCompletions, cypherHighlight, cypherLanguage, type SchemaVocab } from "../../lib/cypherLang";

export interface CypherEditorHandle {
  setValue: (v: string) => void;
  getValue: () => string;
  focus: () => void;
}

interface Props {
  initialValue?: string;
  onChange?: (v: string) => void;
  onRun: (v: string) => void;
  /** dir -1 = older, +1 = newer. Returns the text to show, or null to do nothing. */
  onHistory: (dir: -1 | 1, current: string) => string | null;
  vocab: () => SchemaVocab;
  disabled?: boolean;
}

const theme = EditorView.theme(
  {
    "&": { backgroundColor: "transparent", color: "#111827", fontSize: "13px" },
    ".cm-content": { fontFamily: "JetBrains Mono, Cascadia Code, Consolas, monospace", caretColor: "#001689", padding: "6px 0" },
    "&.cm-focused": { outline: "none" },
    ".cm-cursor": { borderLeftColor: "#001689", borderLeftWidth: "2px" },
    ".cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection": { backgroundColor: "#0FBDFF40 !important" },
    ".cm-activeLine": { backgroundColor: "transparent" },
    ".cm-placeholder": { color: "#94A3B8" },
    ".cm-tooltip": { backgroundColor: "#ffffff", border: "1px solid #CDD5E1", color: "#111827" },
    ".cm-tooltip-autocomplete > ul > li[aria-selected]": { backgroundColor: "#001689", color: "#fff" },
    ".cm-completionDetail": { color: "#6B7280", fontStyle: "normal", marginLeft: "8px" },
    ".cm-matchingBracket": { backgroundColor: "#0FBDFF33", outline: "none" },
    ".cm-scroller": { maxHeight: "40vh", overflow: "auto" },
  },
  { dark: false },
);

export const CypherEditor = forwardRef<CypherEditorHandle, Props>(function CypherEditor(
  { initialValue = "", onChange, onRun, onHistory, vocab },
  ref,
) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const cbs = useRef({ onChange, onRun, onHistory, vocab });
  cbs.current = { onChange, onRun, onHistory, vocab };

  useImperativeHandle(ref, () => ({
    setValue: (v: string) => {
      const view = viewRef.current;
      if (!view) return;
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: v }, selection: { anchor: v.length } });
    },
    getValue: () => viewRef.current?.state.doc.toString() ?? "",
    focus: () => viewRef.current?.focus(),
  }));

  useEffect(() => {
    if (!hostRef.current) return;
    const replaceDoc = (view: EditorView, text: string) =>
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text }, selection: { anchor: text.length } });

    const runKeys = Prec.highest(
      keymap.of([
        {
          key: "Mod-Enter",
          run: (view) => {
            cbs.current.onRun(view.state.doc.toString());
            return true;
          },
        },
        {
          key: "Escape",
          run: (view) => {
            if (completionStatus(view.state) === "active") return false;
            replaceDoc(view, "");
            return true;
          },
        },
        {
          key: "ArrowUp",
          run: (view) => {
            if (completionStatus(view.state) === "active") return false;
            const { state } = view;
            const line = state.doc.lineAt(state.selection.main.head).number;
            if (state.doc.length > 0 && line !== 1) return false;
            const next = cbs.current.onHistory(-1, state.doc.toString());
            if (next === null) return false;
            replaceDoc(view, next);
            return true;
          },
        },
        {
          key: "ArrowDown",
          run: (view) => {
            if (completionStatus(view.state) === "active") return false;
            const { state } = view;
            const line = state.doc.lineAt(state.selection.main.head).number;
            if (state.doc.length > 0 && line !== state.doc.lines) return false;
            const next = cbs.current.onHistory(1, state.doc.toString());
            if (next === null) return false;
            replaceDoc(view, next);
            return true;
          },
        },
      ]),
    );

    const view = new EditorView({
      parent: hostRef.current,
      state: EditorState.create({
        doc: initialValue,
        extensions: [
          runKeys,
          history(),
          closeBrackets(),
          bracketMatching(),
          autocompletion({ override: [cypherCompletions(() => cbs.current.vocab())], activateOnTyping: true }),
          keymap.of([...closeBracketsKeymap, ...completionKeymap, ...historyKeymap, indentWithTab, ...defaultKeymap]),
          cypherLanguage,
          cypherHighlight,
          placeholder("Type a Cypher query, Ctrl+Enter to run"),
          EditorView.lineWrapping,
          theme,
          EditorView.updateListener.of((u) => {
            if (u.docChanged) cbs.current.onChange?.(u.state.doc.toString());
          }),
        ],
      }),
    });
    viewRef.current = view;
    view.focus();
    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <div ref={hostRef} className="min-w-0 flex-1" />;
});
