import { parsePrompt, keysToSelect, type Prompt } from "./prompt.js";

export interface PromptEvent { paneId: string; prompt: Prompt; pollSeq: number }

export interface PromptWatchDeps {
  /** Register a callback fired with the pane id and poll sequence whenever an agent is blocked. Returns unsubscribe. */
  onBlocked: (cb: (paneId: string, pollSeq: number) => void) => () => void;
  /** Read the detection region of a pane (the prompt), ANSI stripped. */
  read: (paneId: string) => Promise<string>;
  /** Send raw text/keys to a pane. */
  send: (paneId: string, text: string) => Promise<void>;
  /**
   * Decide a blocked prompt. Return the 1-based option to choose, or
   * undefined/null to leave it for a human (exposed via onExposed).
   */
  onPrompt: (e: PromptEvent) => number | null | undefined | Promise<number | null | undefined>;
  onExposed?: (e: PromptEvent) => void;
  /**
   * A pane the herd reports blocked whose text does NOT parse as a dialog
   * (KAN-756, item C — a blocked pane the parser cannot make sense of used
   * to be dropped here with no signal at all, which is exactly how a real
   * dialog the parser wrongly rejects would go silently stuck: the KAN-682
   * lesson applied to the parser itself, not just the poll loop). Fired
   * every time this happens — the caller is expected to de-duplicate its own
   * logging by distinct text, since this can otherwise fire once per poll
   * for as long as the pane stays in this state.
   */
  onUnparseable?: (e: { paneId: string; text: string; pollSeq: number }) => void;
  onError?: (e: unknown) => void;
}

/** Watch for blocked agents, read the prompt, and auto-answer or expose it. Returns unsubscribe. */
export function watchPrompts(deps: PromptWatchDeps): () => void {
  return deps.onBlocked(async (paneId, pollSeq) => {
    try {
      const text = await deps.read(paneId);
      // Codex uses a different cursor/footer for real selection menus. Adapt
      // those lines to the shared parser so the normal choice policy applies.
      const prompt = parsePrompt(text) ?? parsePrompt(text
        .replace(/^(\s*)›(?=\s*\d+\.)/gm, "$1>")
        .replace(/^\s*Press Enter to continue\s*\.?\s*$/gim, "Enter to confirm"));
      const hasNumberedChoices = /^\s*[❯›>]?\s*\d+\.\s+\S/m.test(text);
      // ACK-only startup screens retain their bare Enter behavior. A menu
      // that fails parsing must be exposed as unparseable, never accepted.
      if (!prompt && !hasNumberedChoices && /Press Enter to continue/i.test(text)) {
        await deps.send(paneId, "\r");
        return;
      }
      if (!prompt) {
        deps.onUnparseable?.({ paneId, text, pollSeq });
        return;
      }
      const choice = await deps.onPrompt({ paneId, prompt, pollSeq });
      if (typeof choice === "number") await deps.send(paneId, keysToSelect(prompt.current, choice));
      else deps.onExposed?.({ paneId, prompt, pollSeq });
    } catch (e) {
      deps.onError?.(e);
    }
  });
}
