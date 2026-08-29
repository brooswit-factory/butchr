import { describe, expect, test } from "bun:test";
import { watchedKeys } from "../../src/jira-watch/routes.js";
import type { IssueLink } from "../../src/atlassian/types.js";

const link = (type: string, otherEnd: "inward" | "outward", key: string): IssueLink => ({ type, otherEnd, key });

describe("watchedKeys", () => {
  test("a task change notifies its implementing story and NOTHING the epic", () => {
    // The task's own links: Implements to its story (task is the implementer,
    // so from the task's point of view the boss — its story — is otherEnd
    // "inward", per the DIRECTION CONTRACT). The task does not watch its
    // story through this link (only the story watches the task).
    const taskLinks = [link("Implements", "inward", "KAN-STORY")];
    expect(watchedKeys(taskLinks)).toEqual([]);
    // From the story's point of view, the task (its implementer) is otherEnd
    // "outward" — the story watches it. The epic is never in the task's own
    // links (task.parent = epic is membership only, not a link), so nothing
    // routes the task's change to the epic.
    const storyLinks = [link("Implements", "outward", "KAN-TASK")];
    expect(watchedKeys(storyLinks)).toEqual(["KAN-TASK"]);
  });

  test("a story change notifies its epic (story-implements-epic) and the story's own agent", () => {
    // The story implements the epic: from the epic's point of view the story
    // is otherEnd "outward" — the epic watches it.
    const epicLinks = [link("Implements", "outward", "KAN-STORY")];
    expect(watchedKeys(epicLinks)).toEqual(["KAN-STORY"]);
  });

  test("a parent relationship alone routes nothing", () => {
    // parent is membership only; it never appears as a link at all.
    expect(watchedKeys([])).toEqual([]);
  });

  test("a boss does not hear what IT implements", () => {
    // A story's own Implements link to its epic, seen from the story's side:
    // the epic is otherEnd "inward" (the boss side) — the story does not
    // watch its epic through this link.
    const storyLinks = [link("Implements", "inward", "KAN-EPIC")];
    expect(watchedKeys(storyLinks)).toEqual([]);
  });

  test("a Relates link (either direction) is not routed", () => {
    expect(watchedKeys([link("Relates", "outward", "KAN-A")])).toEqual([]);
    expect(watchedKeys([link("Relates", "inward", "KAN-B")])).toEqual([]);
  });

  test("a Blocks link is not routed", () => {
    expect(watchedKeys([link("Blocks", "outward", "KAN-A")])).toEqual([]);
  });

  test("a Cloners link is not routed", () => {
    expect(watchedKeys([link("Cloners", "inward", "KAN-A")])).toEqual([]);
  });

  test("mixed links: only the routable ones are returned, in order", () => {
    const links = [
      link("Implements", "outward", "KAN-1"),
      link("Blocks", "outward", "KAN-2"),
      link("Relates", "inward", "KAN-3"),
      link("Implements", "inward", "KAN-4"),
      link("Duplicate", "outward", "KAN-5"),
    ];
    expect(watchedKeys(links)).toEqual(["KAN-1"]);
  });
});
