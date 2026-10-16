bump: major

### BREAKING
- **`BUTCHR_MAX_AGENTS` is removed, and this daemon no longer caps how many
  agents it runs (FACTORY-1013).** For every enabled query/rule, every
  eligible match is reconciled into its agent on the poll it is seen — no
  cap, no waiting queue, no fairness ordering, no pacing. **On a host whose
  fleet was previously held under a cap, the agent count rises to the full
  matched set on the first poll after this build is deployed.** Narrow the
  rules' queries before deploying if that is not what you want: there is
  deliberately no knob to re-cap it. A daemon whose environment still sets
  `BUTCHR_MAX_AGENTS` does not fail to start — the variable is simply never
  read, like any other unrecognized environment variable — and a
  `settings.json` that still carries it is reported as an unknown key by the
  settings loader exactly as it would for any other non-allowlisted key.
- **`Rule.role` (`"worker" | "sentinel"`), `Rule.maxNewPerTick` and
  `Rule.minSecondsBetweenAdmissions` are removed from the rules schema.** All
  three existed only to configure the cap (exempt a rule's agents from it, or
  pace its admissions into it). A deployed `rules.json` that still carries
  them KEEPS LOADING — the three keys stay in the parser's accepted-key set
  (`REMOVED_RULE_FIELDS`, `src/rules/rules.ts`) purely so an upgrade does not
  fail the whole file with `unknown field` — but they are parsed into nothing
  and read by nothing, so a rule that relied on `role: "sentinel"` or on
  `maxNewPerTick` to throttle itself no longer gets either. Any OTHER unknown
  key is still a hard load error, unchanged. No migration runs, and the
  FACTORY-810 startup migration that used to write `role: "sentinel"` is
  itself removed.
- **Response fields are removed from four read surfaces.** `/health` loses
  `admission`; `/dashboard` loses the top-level `admission` object and the
  `kind: "withheld"` row kind; `GET /api/rules` loses each rule's `role`,
  `maxNewPerTick` and `minSecondsBetweenAdmissions`; `GET
  /api/rules/catalog` loses `capacityRoles`; the rules dry-run preview loses
  `warning`; and the rules write-plan's `confirmReason` loses its
  `"capacity-sentinel"` value. `/config-inventory` and `GET /api/rules` no
  longer produce the `"admission cap: matched resource(s) currently withheld
  by the fleet-wide agent cap"` staffing reason. Any consumer reading those
  must be updated. `butchr session create` loses `--role`.

### Removed
- **The capacity admission system is gone.** For every enabled query/rule,
  every eligible match is now reconciled into its agent on the poll it is
  seen — no cap, no waiting queue, no fairness ordering, no pacing. Removed
  `src/agents/admission.ts` in full: the fleet-wide `AdmissionController`,
  the withholding ("waiting for a slot") queue, the BUTCHR-297 aging/wait
  ledger, the per-source residency census and its trust state
  (`ImplausibleZeroGuard`), the shared-cap reservations, and the
  `[admission]`/`[admission2]` journal lines.
- `BUTCHR_MAX_AGENTS` and `Config.maxAgents` are gone, along with the
  Settings-page entry for them and their confirm ceiling (50) / hard maximum
  (100). The generic settings-write confirm mechanism itself stays — it is a
  write-safety affordance, not part of the capacity system — but no shipped
  setting fires it any more.
- The per-rule capacity role `Rule.role` (`"worker" | "sentinel"`),
  `AGENT_ROLES`, `src/agents/capacity-role.ts`, the FACTORY-810 startup
  migration `src/rules/capacity-role-migration.ts`, `setRuleRole`, the
  `"Included in capacity"` rule-form toggle, the `capacityRoles` field on
  `GET /api/rules/catalog`, the `"capacity-sentinel"` write-plan confirm
  reason, and `SessionDefinition.role` / `butchr session create --role`.
- The per-rule admission pacing `Rule.maxNewPerTick` and
  `Rule.minSecondsBetweenAdmissions` (FACTORY-907), their validation, their
  read-only `GET /api/rules` fields, and the
  `[admission2] rate-limit …` line.
- `/dashboard` loses the `withheld` row kind and the admission panel (cap /
  residency / sentinels / per-source census state) on both the
  server-rendered page and the JSON response; `/health` loses its
  `admission` sibling field; `/config-inventory` and `GET /api/rules` lose
  the `"admission cap: matched resource(s) currently withheld by the
  fleet-wide agent cap"` staffing reason and the per-provider admission
  census that had to rule a withholding out before a genuine zero could be
  asserted. `butchr rules check` and the Rules-page dry-run preview lose
  their "would exceed maxAgents" warning.

### Changed
- **What was deliberately PRESERVED, and must stay preserved.**
- **Idempotent reconciliation.** `checkResidency`
  (`src/agents/residency-guard.ts`) survives untouched: exactly one active
  owner per matched resource, so a repeated poll never spawns a duplicate for
  a resource that already has an agent. It never rations, queues or paces —
  it only ever drops a candidate that already HAS its own agent.
- Query membership and configured enablement (`enabled: false` still stops a
  rule's agents), explicit operator/agent stop controls (`stand_down`,
  `atRest`/asleep, freeze), crash-loop and respawn-rate suppression, and the
  Rocket.Chat temporary-account cap (a real external resource bound, not the
  internal capacity system).
- Real provider and API error handling: model/credential quota exhaustion,
  GitHub/Jira/Zendesk API failures, and the account-policy launch refusal all
  behave exactly as before.
- Deploying this build is FACTORY-1012's job, not this change's. See the
  BREAKING section above for what an operator must check first (query
  breadth) and for what keeps working untouched on an existing
  `rules.json`/`settings.json`.
