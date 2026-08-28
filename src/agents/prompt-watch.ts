import { parsePrompt, keysToSelect, type Prompt } from "./prompt.js";

export interface PromptEvent { paneId: string; prompt: Prompt }

export interface PromptWatchDeps {
  /** Register a callback fired with the pane id whenever an agent becomes blocked. Returns unsubscribe. */
  onBlocked: (cb: (paneId: string) => void) => () => void;
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
  onError?: (e: unknown) => void;
}

/** Watch for blocked agents, read the prompt, and auto-answer or expose it. Returns unsubscribe. */
export function watchPrompts(deps: PromptWatchDeps): () => void {
  return deps.onBlocked(async (paneId) => {
    try {
      const text = await deps.read(paneId);
      // Pure acknowledgment screens (first-run onboarding, update notices) have
      // no options to choose — just press enter. Safe by construction: the
      // pattern requires the literal continue wording, and a real selection
      // dialog never uses it.
      if (/Press Enter to continue/i.test(text)) {
        await deps.send(paneId, "\r");
        return;
      }
      const prompt = parsePrompt(text);
      if (!prompt) return;
      const choice = await deps.onPrompt({ paneId, prompt });
      if (typeof choice === "number") await deps.send(paneId, keysToSelect(prompt.current, choice));
      else deps.onExposed?.({ paneId, prompt });
    } catch (e) {
      deps.onError?.(e);
    }
  });
}
