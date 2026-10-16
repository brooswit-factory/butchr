bump: patch

### Fixed
- **The flattened kickoff reminder no longer keeps a stray Markdown `##` heading marker (FACTORY-940).** `flattenToSingleLine` (`src/agents/argv.ts`) only collapsed whitespace, so `briefs/_before-you-stop.md`'s leading `## Before you stop or go idle` heading survived into `KICKOFF_PROMPT`/`AGENTS_KICKOFF_PROMPT` as a literal `##` sitting mid-sentence. The function now also strips a leading Markdown line marker (heading, blockquote, or list bullet) before collapsing whitespace. Cosmetic only — no change to the reminder's actual wording.
