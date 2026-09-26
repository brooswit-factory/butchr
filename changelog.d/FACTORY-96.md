bump: patch

### Fixed
- **Claude/Codex model-power bands corrected to the operator's final split (FACTORY-96).** FACTORY-75/PR #481 shipped four equal 25-wide bands (Haiku 0-24, Sonnet 25-49, Opus 50-74, Fable 75-100). The operator's actual final ask (FACTORY-73 comments 25036/25085) is asymmetric: Haiku 0-10, Sonnet 11-59, Opus 60-84, Fable 85-100 — Haiku the bottom 10%, Fable the top 15%, Opus the 25% below Fable. `CLAUDE_MODEL_POWER_TABLE`/`CODEX_MODEL_POWER_TABLE` (`src/resources/power-scale.ts`) and `docs/power-scale.md` are updated to match; the load-bearing consequence is that the Servy Epic/Bug canonical target (`modelPower=75`) now resolves to **Opus**, not Fable. No mechanism changed — same pure data tables, same resolver functions, `tier1`-`tier5` back-compat untouched.
