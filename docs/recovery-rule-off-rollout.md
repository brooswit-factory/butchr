# Portable recovery and rule-OFF rollout

Build from the application recovery branch and sibling Drovr checkout pinned by `RECOVERY.md` and CI. Keep credentials, runtime settings, saved authority state, worker workspaces and native history on their existing hosts; none belongs in this repository or a deployment archive.

## Before changing a service

- Require the exact source head's normal CI checks, source review and clean build identity. Stage a versioned `dist/` release and record its checksums. Keep the previous release intact.
- Inventory each existing deployment owner separately. Discover the actual active service unit; do not assume a generic unit name. Record its previous active state, working directory, executable prefix and non-secret port/config/workspace locations locally.
- Preserve runtime configuration, authority/override state, intentional-stop and freeze markers, holds and provider settings in place. Check current rule/authority schema with `scripts/deploy/preflight.ts`; its optional socket read records a worker-identity digest without reading history or mutating a worker. A failed or incomplete preflight blocks the rollout.
- Confirm startup/shutdown and systemd kill behavior cannot stop the worker manager or unrelated sessions. Do not re-enable rules, clear holds, issue new permits, or toggle real work OFF as a deployment test.

The preflight source can be bundled for a deployment target without bringing a development checkout there:

```sh
bun build scripts/deploy/preflight.ts --target bun --outfile dist/deployment-preflight.js
bun dist/deployment-preflight.js --rules /existing/runtime/rules.json \
  --authority /existing/runtime/remote-rule-authority.json \
  --socket /existing/runtime/herdr.sock
```

Omit `--authority` only when that deployment has no saved remote authority. These are illustrative paths, not defaults. Never substitute a credential or transcript file.

## Serialized rollout

Change one existing service at a time. Preserve its existing environment/configuration and bind it to the staged versioned release using a reviewed service override. Reload the user service manager and restart only a previously running service. An inactive service stays inactive unless separately authorized to start. Record the exact override and previous release/state locally for rollback; do not publish unit contents or environment values.

Verify the service's actual source identity, health, authoritative connection and read-only worker inventory. Existing worker identities and intentional-stop/hold state must remain accounted for. Natural worker completion requires explanation rather than automatic recreation. Stop the rollout on unexpected activity or incomplete evidence.

Rollback restores the previous release/executable binding and previous service state while reusing unchanged runtime settings. Verify health and worker inventory again. A failed rollback or unavailable target is reported explicitly; it is never described as deployed.

Rule-OFF behavior is covered with synthetic, isolated real-herd regressions. It requires explicit current authority, fresh complete inventory and exact rule ownership; generation checks fence every destructive RPC. Missing rules, invalid updates, disconnects, incomplete inventory, stale generations, partial handoffs, unrelated workers, human sessions and reserved legacy local sessions cannot authorize an OFF sweep. The master pause remains a pause.
