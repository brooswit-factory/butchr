/**
 * local/ui — the CodeMirror query box (`QueryEditor.tsx`) and the read-only
 * highlighted query (`JqlCode.tsx`).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { act, cleanup, render } from "@testing-library/react";
import { EditorView } from "@codemirror/view";
import { withDom } from "../setup/happy-dom.js";
import QueryEditor from "../../dashboard-app/src/components/rules-targeting/QueryEditor.js";
import { JqlCode } from "../../dashboard-app/src/components/rules-targeting/JqlCode.js";

withDom();
afterEach(cleanup);

function editorOf(container: HTMLElement): EditorView {
  const view = EditorView.findFromDOM(container.querySelector(".cm-editor") as HTMLElement);
  if (!view) throw new Error("no editor");
  return view;
}

describe("QueryEditor", () => {
  test("highlights JQL, reports edits, and follows outside value changes", () => {
    const seen: string[] = [];
    const { container, rerender } = render(<QueryEditor value="project = A AND status = Done" onChange={(v) => seen.push(v)} language="jql" disabled={false} testId="q" labelledBy="lbl" />);
    expect(container.querySelector(".rt-jql--keyword")?.textContent).toBe("AND");
    expect(container.querySelector(".rt-jql--field")?.textContent).toBe("project");
    expect(container.querySelector('[data-testid="q"]')?.getAttribute("aria-labelledby")).toBe("lbl");
    const view = editorOf(container);
    act(() => view.dispatch({ changes: { from: view.state.doc.length, insert: " OR x = y" } }));
    expect(seen).toEqual(["project = A AND status = Done OR x = y"]);
    rerender(<QueryEditor value="key = A-1" onChange={(v) => seen.push(v)} language="jql" disabled={false} />);
    expect(view.state.doc.toString()).toBe("key = A-1");
  });

  test("plain mode has no JQL marks; disabled makes it read-only", () => {
    const { container, rerender } = render(<QueryEditor value="is:open label:x" onChange={() => undefined} language="plain" disabled={false} placeholder="search" />);
    expect(container.querySelector(".rt-jql")).toBeNull();
    rerender(<QueryEditor value="is:open label:x" onChange={() => undefined} language="plain" disabled invalid />);
    expect(editorOf(container).state.readOnly).toBe(true);
    expect(container.querySelector(".rt-query-editor")?.getAttribute("data-invalid")).toBe("true");
  });

  test("autoFocus focuses the editor", () => {
    const { container } = render(<QueryEditor value="" onChange={() => undefined} language="jql" disabled={false} autoFocus />);
    expect(editorOf(container).hasFocus || document.activeElement === container.querySelector(".cm-content")).toBe(true);
  });
});

describe("JqlCode", () => {
  test("short queries render inline and highlighted; long ones render formatted in a block", () => {
    const { container, rerender } = render(<JqlCode query="project = A" />);
    expect(container.querySelector("code.rt-query .rt-jql--field")?.textContent).toBe("project");
    const long = 'assignee = currentUser() and status = "In Progress" and labels = "agent-ready" and issuetype = Task';
    rerender(<JqlCode query={long} />);
    expect(container.querySelector("pre.rt-query--block")?.textContent).toBe('assignee = currentUser()\nAND status = "In Progress"\nAND labels = "agent-ready"\nAND issuetype = Task');
    rerender(<JqlCode query={long} pretty={false} />);
    expect(container.querySelector("code.rt-query")?.textContent).toBe(long);
  });
});
