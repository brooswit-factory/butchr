# Supported local maintenance

Build with the pinned sibling SDK described in RECOVERY.md. `bun run build`
produces `dist/butchr-operator.js` (the package command is `butchr-operator`).
Run as the existing daemon owner. Importing/building this command never applies
maintenance. The commands do not install hooks, stop services, launch workers,
change Servr rules or clear independent policy/security/quota/stop/freeze holds.

## Readiness and exact native-reference recovery

```sh
bun dist/butchr-operator.js readiness --socket /existing/herdr.sock \
  --herdr-bin /existing/trusted/herdr
```

The optional existing Herdr binary provides its supported `integration status`
when the server lacks the integration-list RPC. Missing or outdated official
Codex/Claude integrations are reported; unknown status is never called ready.
Hook installation and any required Codex approval remain separate, explicit
operator actions using Herdr's own integration workflow. Installing hooks does
not backfill a session already running before installation.

For an existing idle Codex worker with no registered native reference:

```sh
bun dist/butchr-operator.js native-session plan --socket /existing/herdr.sock \
  --pane EXISTING_PANE --native-root /explicitly/permitted/native/directory
```

The Linux collector examines only that pane's single foreground Codex process,
its same-owner PID generation/cwd/executable, and its currently open native
file descriptors inside the explicitly permitted roots. It reads the bounded
identity header only. Zero or multiple matches, inconsistent metadata,
symlinks, changing files/processes and access denial refuse the plan. It never
searches for the newest file by cwd, searches other homes, retries an inaccessible
path through another route, or reads/copies credentials. Existing references
are never overwritten. Native records remain in place.

Review the exact plan and hash. Only an explicitly authorized operator may
run the same command with `apply` and `--confirm EXACT_PLAN_HASH`. The command
rechecks provenance, uses Herdr's recognized `herdr:codex` native reporting
contract without replacement markers or sequence overrides, and requires matching pane and agent metadata readback. Concurrent ownership is never intentionally overwritten. An RPC acknowledgment alone
is failure if the reference did not appear. Inspect an uncertain outcome before
retrying. The command requests no target start or source stop; restoring a
reference may allow an already-running daemon to resume its independently
configured reconciliation. Stop that daemon through its supported service
manager first when that execution has not been authorized.

## Retire historical one-attempt validation mode

This operation is for the temporary local validation fence, not for independent
worker holds. It grants no new canary attempt and never resets a spent receipt.
It requires a complete terminal receipt, exact immutable permit/latch binding,
and stable source/target/human inventory. A partial worker must already remain
durably marked blocked; retirement does not repair or adopt that worker.

```sh
bun dist/butchr-operator.js retire-validation plan --socket /existing/herdr.sock \
  --state /existing/private/control --permit /existing/private/permit.json \
  --runtime /existing/release --workspaces /existing/workspaces \
  --freeze-root /existing/freeze/control
```

First read `GET /api/operator-paths` through the existing same-origin, same-owner
local dashboard route. It returns only the running PID, runtime, effective freeze
root and workspace root; match the PID/release to the selected service and use
those exact roots. This reflects environment-file overrides without opening
credential files or returning other environment fields. An unavailable or
mismatched readback must be resolved before confirming a plan.

An absent effective freeze directory is valid: the plan records its absence,
creates nothing, and rechecks its existence and every existing canonical ancestor
on subsequent hold reads. A new directory, hold file, symlink or non-directory
ancestor changes or refuses the plan. Do not create a directory to pass planning.

`plan` is read-only. Review its exact survivor inventory, evidence hashes,
independent hold fingerprints and confirmation hash. Required explicit authority:
retire **only this historical validation mode**, preserve its original permit,
spent claim and all independent holds, and permit normal reconciliation of the
current authoritative enabled rules. A generic timeout or expired permit does
not supply that confirmation.

Before applying, use the existing service manager to stop only the selected
Butchr daemon and its automatic watchdog launchers, under separate stop/restart
authorization. Workers remain running in Herdr. The default unit is
`butchr.service`; `--unit` selects an existing `butchr-*.service`. The apply
command independently checks inactive/dead state, no pending service jobs,
matching release binding and no competing runtime. Unknown process access fails
closed; it is not treated as absence. A changed inventory, hold or authority
requires replanning and renewed exact confirmation.

Run the same arguments with `apply --confirm EXACT_PLAN_HASH
--approval-reference EXPLICIT_OPERATOR_AUTHORIZATION` only after that approval.
The product writes an owner-private immutable audit and retirement record under
its exclusive control lock, with durable writes and late survivor/hold checks.
The original permit, spent receipt and mode latch stay byte-identical. The next
startup recognizes only that exact audited retirement, even if the historical
canary environment setting remains present; changing its permit path is refused.
This avoids manual latch deletion and hidden service overrides. A torn transaction
or altered original/audit evidence remains blocked and requires inspection.

```sh
bun dist/butchr-operator.js retire-validation status \
  --socket /existing/herdr.sock --state /existing/private/control \
  --permit /existing/private/permit.json
```

Restart the selected daemon only when separately authorized, then verify build,
health, authoritative connection and worker/hold inventory. Current rule enable
states and genuine holds continue to govern the normal lifecycle. Rolling back
to a build without retirement support re-establishes the historical fence; it
never renews a consumed attempt. Audit/plan files are private operational data
and must not be committed or published.

Protocol references: Herdr 0.8.2 [recognized native sources](https://github.com/herdrdev/herdr/blob/v0.8.2/src/agent_resume.rs) and [session ownership/replacement guards](https://github.com/herdrdev/herdr/blob/v0.8.2/src/terminal/state.rs).

## Paid-launch readiness guard

Daemon launches check official Claude/Codex integration status before workspace
creation or a paid target start. Missing, outdated or unknown status blocks the
launch; the read-only result is shared and cached for 30 seconds, including
failures. The check uses the existing owner-local Herdr binary when present,
then PATH, so a minimal service PATH does not mask an installed integration.
No hook installation, rule changes, quota override or paid readiness probe occurs.
After an authorized integration repair, status is rechecked automatically.
Preserved uncommitted staging panes still require normal ownership recovery;
this guard never closes a pane or fabricates a native session reference.

### Interrupted empty Claude bootstrap

`butchr-operator staged-bootstrap plan` inspects a specific Codex source and
unregistered Claude staging target. It is a read-only recovery for an interrupted
handoff that is now blocked by ambiguous physical inventory. It requires the
connected Servr rule to remain enabled for Claude, the original managed source,
an exact deterministic staging name, one foreground process per pane, matching
process generations and executable identities, and no canary, freeze, stop or
partial-handoff hold. It refuses active handoffs.

```sh
butchr-operator staged-bootstrap plan \
  --worker RESOURCE_PROVIDER:RULE_ID:RESOURCE_ID \
  --source SOURCE_PANE --target TARGET_PANE \
  --socket EXISTING_HERDR_SOCKET --state OWNER_PRIVATE_STATE_DIRECTORY \
  --daemon-url http://127.0.0.1:PORT \
  --native-root EXACT_OWNER_CLAUDE_PROJECT_DIRECTORY \
  --target-executable EXACT_CANONICAL_CLAUDE_IMAGE
```

The foreground process's generated random bootstrap nonce must match exactly one
bounded native history in that project. Only the original bootstrap prompt and
its readiness acknowledgement are allowed: extra turns, tools, file backups,
unknown records, ambiguous sessions or changed files refuse recovery. The target
must be idle, unfocused, at the bottom of its screen with an empty input prompt.
The source's registered native history must still be readable. Plans contain
identity hashes and sizes, never conversation bodies or credentials. Planning
creates no directories or files and sends no prompts.

Review the exact plan and its effects before saving it in an existing owner-private
directory as a mode `0600` file. Applying requires separate explicit authorization:

```sh
butchr-operator staged-bootstrap apply --plan-file PRIVATE_PLAN_FILE \
  --confirm EXACT_PLAN_HASH --approval-reference EXPLICIT_AUTHORIZATION
butchr-operator staged-bootstrap status --plan-file PRIVATE_PLAN_FILE
```

Apply revalidates the entire evidence twice, records a durable private audit, and
closes only the proven empty staging pane. Both native histories remain on disk;
the command never closes the source, changes settings, clears holds, or launches
a worker. Removing the duplicate can allow **normal reconciliation to launch a
paid replacement and import the full source history**. The plan reports source
size and estimated import chunk count so the operator can assess this cost. The
normal handoff must acknowledge the history before retiring the original source.

A lost close response retains an uncertainty lock. Subsequent apply calls only
verify physical absence and history preservation; they never repeat an uncertain
close. Inspect the status and private receipt if either pane or its identity
changes. Never delete the lock, fabricate a native reference, manually close a
pane, or use this command to discard useful work. Registered targets or targets
with any additional work require a separate history-preserving recovery.
