/**
 * local/ui — the rule editor's query box: a CodeMirror 6 editor, with JQL
 * highlighting from `view-model/jql.ts`'s tokens and LaunchPad's code
 * colours (`RulesTargeting.css`'s `.rt-jql--*`). Default-exported so
 * `RuleEditor` can lazy-load it: CodeMirror only downloads once a rule is
 * opened for editing.
 *
 * Controlled from the outside: `value` changes (Format, discarding a
 * change) replace the document; typing reports through `onChange`.
 */
import { useEffect, useRef } from "react";
import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { bracketMatching } from "@codemirror/language";
import { Compartment, EditorState, RangeSetBuilder, type Extension } from "@codemirror/state";
import { Decoration, EditorView, keymap, placeholder as placeholderText, ViewPlugin, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { tokenizeJql } from "../../view-model/jql.js";
import { installCspSafeStyleMount } from "../../theme/csp-styles.js";

// butchr's CSP blocks the <style> tag CodeMirror would inject; see `csp-styles.ts`.
if (typeof document !== "undefined") installCspSafeStyleMount(document);

export interface QueryEditorProps {
  value: string;
  onChange: (value: string) => void;
  language: "jql" | "plain";
  disabled: boolean;
  placeholder?: string;
  /** Id of the visible label. */
  labelledBy?: string;
  invalid?: boolean;
  autoFocus?: boolean;
  testId?: string;
}

function jqlDecorations(text: string): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  for (const token of tokenizeJql(text)) {
    if (token.type !== "space") builder.add(token.from, token.to, Decoration.mark({ class: `rt-jql rt-jql--${token.type}` }));
  }
  return builder.finish();
}

/** Re-lexes the whole query on every change — queries are a line or two, so this is cheaper than an incremental parser. */
const jqlHighlighter = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = jqlDecorations(view.state.doc.toString());
    }
    update(update: ViewUpdate) {
      if (update.docChanged) this.decorations = jqlDecorations(update.state.doc.toString());
    }
  },
  { decorations: (plugin) => plugin.decorations },
);

/** Sizes and fonts only; colours, borders and focus come from LaunchPad tokens in `RulesTargeting.css`. */
const baseTheme = EditorView.theme({
  "&": { fontSize: "13px" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { fontFamily: "var(--lp-font-family-monospace)", lineHeight: "20px" },
  ".cm-content": { padding: "6px 0", minHeight: "40px", caretColor: "var(--lp-color-text-ui-primary-base)" },
  ".cm-line": { padding: "0 10px" },
  ".cm-placeholder": { color: "var(--lp-color-text-field-placeholder)" },
  ".cm-matchingBracket": { backgroundColor: "var(--lp-color-bg-interactive-tertiary-hover)", outline: "1px solid var(--lp-color-border-ui-primary)" },
});

const editableExtension = (disabled: boolean): Extension => [EditorView.editable.of(!disabled), EditorState.readOnly.of(disabled)];

export default function QueryEditor({ value, onChange, language, disabled, placeholder, labelledBy, invalid, autoFocus, testId }: QueryEditorProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const editable = useRef(new Compartment());

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const attributes: Record<string, string> = { spellcheck: "false", autocorrect: "off", autocapitalize: "off", "aria-multiline": "true" };
    if (labelledBy) attributes["aria-labelledby"] = labelledBy;
    if (testId) attributes["data-testid"] = testId;
    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: value,
        extensions: [
          history(),
          closeBrackets(),
          bracketMatching(),
          EditorView.lineWrapping,
          keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...historyKeymap]),
          language === "jql" ? jqlHighlighter : [],
          placeholder ? placeholderText(placeholder) : [],
          editable.current.of(editableExtension(disabled)),
          EditorView.contentAttributes.of(attributes),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) onChangeRef.current(update.state.doc.toString());
          }),
          baseTheme,
        ],
      }),
    });
    viewRef.current = view;
    if (autoFocus) view.focus();
    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // The editor is built once per language; `value`/`disabled` changes are applied by the effects below.
  }, [language]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (current !== value) view.dispatch({ changes: { from: 0, to: current.length, insert: value } });
  }, [value]);

  useEffect(() => {
    viewRef.current?.dispatch({ effects: editable.current.reconfigure(editableExtension(disabled)) });
  }, [disabled]);

  return <div ref={hostRef} className="rt-query-editor" data-invalid={invalid ? "true" : undefined} data-disabled={disabled ? "true" : undefined} />;
}
