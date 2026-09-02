/**
 * Manual/operator check — NOT wired into `bun run check` (same reasoning as
 * its precedents, scripts/verify-workspace-ground-truth.ts and
 * scripts/verify-spawn-effort.ts: it needs a real, live GitHub pull request
 * and a real cross-account review, which a CI sandbox cannot promise).
 *
 * Measures whether a submitted GitHub PR review's recorded commit is
 * immutable, across every surface the review protocol reads or could read:
 *
 *   A. REST, list form:    GET /repos/{repo}/pulls/{n}/reviews          → .commit_id
 *   B. REST, by review id: GET /repos/{repo}/pulls/{n}/reviews/{id}     → .commit_id
 *   C. GraphQL:            gh pr view --json reviews                   → .reviews[].commit.oid
 *   D. gh pr view --json reviewDecision,headRefOid,state,mergedAt
 *
 * `snapshot` reads all four surfaces for a PR right now and writes a
 * timestamped JSON file. `diff` compares two such snapshots and reports,
 * per review, which fields moved and which held still. Neither subcommand
 * mutates the PR, the branch, or any repository setting — this only reads.
 *
 * Usage:
 *   bun run scripts/verify-review-commit-immutability.ts snapshot <owner/repo> <pr-number> [out-file]
 *   bun run scripts/verify-review-commit-immutability.ts diff <snapshot-a.json> <snapshot-b.json>
 *
 * `snapshot` with no [out-file] writes to
 * docs/review-commit-immutability/snapshots/<owner>-<repo>-pr<n>-<ISO-timestamp>.json
 * (directory created if absent) and also prints the path. `diff` writes
 * nothing; it prints a plain-text report to stdout and exits 0 regardless
 * of what it finds — movement is a measurement, not a failure of this tool.
 */
import { execSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

interface RestReview {
  id: number;
  user: { login: string };
  state: string;
  submitted_at: string;
  commit_id: string;
  body: string;
}

interface GraphqlReview {
  id: string;
  author: { login: string } | null;
  state: string;
  submittedAt: string;
  commit: { oid: string };
  body: string;
}

interface PrMeta {
  headRefOid: string;
  reviewDecision: string | null;
  state: string;
  mergedAt: string | null;
}

interface Snapshot {
  timestampUtc: string;
  repo: string;
  pr: number;
  commands: string[];
  restList: RestReview[];
  restById: Record<string, RestReview>;
  graphql: GraphqlReview[];
  prMeta: PrMeta;
}

function run(cmd: string): string {
  return execSync(cmd, { encoding: "utf8", maxBuffer: 1024 * 1024 * 16 });
}

function takeSnapshot(repo: string, pr: number): Snapshot {
  const commands: string[] = [];
  const timestampUtc = new Date().toISOString();

  const restListCmd = `gh api repos/${repo}/pulls/${pr}/reviews`;
  commands.push(restListCmd);
  const restList: RestReview[] = JSON.parse(run(restListCmd));

  const restById: Record<string, RestReview> = {};
  for (const r of restList) {
    const cmd = `gh api repos/${repo}/pulls/${pr}/reviews/${r.id}`;
    commands.push(cmd);
    restById[String(r.id)] = JSON.parse(run(cmd));
  }

  const graphqlCmd = `gh pr view ${pr} --repo ${repo} --json reviews`;
  commands.push(graphqlCmd);
  const graphql: GraphqlReview[] = JSON.parse(run(graphqlCmd)).reviews;

  const metaCmd = `gh pr view ${pr} --repo ${repo} --json headRefOid,reviewDecision,state,mergedAt`;
  commands.push(metaCmd);
  const prMeta: PrMeta = JSON.parse(run(metaCmd));

  return { timestampUtc, repo, pr, commands, restList, restById, graphql, prMeta };
}

function cmdSnapshot(args: string[]): void {
  const [repo, prStr, outFile] = args;
  if (!repo || !prStr) throw new Error("usage: snapshot <owner/repo> <pr-number> [out-file]");
  const pr = Number(prStr);
  if (!Number.isInteger(pr)) throw new Error(`pr-number must be an integer, got ${prStr}`);

  const snap = takeSnapshot(repo, pr);

  const [owner, name] = repo.split("/");
  const defaultDir = join("docs", "review-commit-immutability", "snapshots");
  const defaultOut = join(defaultDir, `${owner}-${name}-pr${pr}-${snap.timestampUtc.replace(/[:.]/g, "-")}.json`);
  const outPath = outFile ?? defaultOut;
  mkdirSync(dirname(outPath), { recursive: true });

  writeFileSync(outPath, JSON.stringify(snap, null, 2) + "\n");
  console.log(`snapshot written: ${outPath}`);
  console.log(`  timestampUtc: ${snap.timestampUtc}`);
  console.log(`  headRefOid:   ${snap.prMeta.headRefOid}`);
  console.log(`  reviewDecision: ${snap.prMeta.reviewDecision}`);
  console.log(`  reviews: ${snap.restList.length}`);
  for (const r of snap.restList) console.log(`    #${r.id} ${r.user.login} ${r.state} @ ${r.submitted_at} -> commit_id ${r.commit_id}`);
}

function cmdDiff(args: string[]): void {
  const [fileA, fileB] = args;
  if (!fileA || !fileB) throw new Error("usage: diff <snapshot-a.json> <snapshot-b.json>");
  const a: Snapshot = JSON.parse(readFileSync(fileA, "utf8"));
  const b: Snapshot = JSON.parse(readFileSync(fileB, "utf8"));

  console.log(`A: ${fileA}`);
  console.log(`   ${a.timestampUtc}  repo=${a.repo} pr=${a.pr}  headRefOid=${a.prMeta.headRefOid}  reviewDecision=${a.prMeta.reviewDecision}  state=${a.prMeta.state}`);
  console.log(`B: ${fileB}`);
  console.log(`   ${b.timestampUtc}  repo=${b.repo} pr=${b.pr}  headRefOid=${b.prMeta.headRefOid}  reviewDecision=${b.prMeta.reviewDecision}  state=${b.prMeta.state}`);
  console.log("");

  if (a.repo !== b.repo || a.pr !== b.pr) {
    console.log(`WARNING: snapshots are of different PRs (${a.repo}#${a.pr} vs ${b.repo}#${b.pr}) — diff below compares by review id anyway, but this is unusual.`);
  }

  console.log(`headRefOid:      ${a.prMeta.headRefOid === b.prMeta.headRefOid ? "UNCHANGED" : "MOVED"}  (${a.prMeta.headRefOid} -> ${b.prMeta.headRefOid})`);
  console.log(`reviewDecision:  ${a.prMeta.reviewDecision === b.prMeta.reviewDecision ? "UNCHANGED" : "MOVED"}  (${a.prMeta.reviewDecision} -> ${b.prMeta.reviewDecision})`);
  console.log("");

  const ids = new Set<string>([...a.restList.map((r) => String(r.id)), ...b.restList.map((r) => String(r.id))]);
  for (const id of ids) {
    const ra = a.restById[id];
    const rb = b.restById[id];
    console.log(`review ${id}:`);
    if (!ra) {
      console.log("  present only in B (new review since A) — nothing to diff");
      continue;
    }
    if (!rb) {
      console.log("  present only in A (not found in B) — cannot confirm persistence");
      continue;
    }
    const gA = a.graphql.find((g) => g.submittedAt === ra.submitted_at && (g.author?.login ?? null) === ra.user.login);
    const gB = b.graphql.find((g) => g.submittedAt === rb.submitted_at && (g.author?.login ?? null) === rb.user.login);

    const restListA = a.restList.find((r) => r.id === ra.id)?.commit_id;
    const restListB = b.restList.find((r) => r.id === rb.id)?.commit_id;

    console.log(`  submitted_at:        ${ra.submitted_at === rb.submitted_at ? "UNCHANGED" : "MOVED"}  (${ra.submitted_at} -> ${rb.submitted_at})`);
    console.log(`  state:               ${ra.state === rb.state ? "UNCHANGED" : "MOVED"}  (${ra.state} -> ${rb.state})`);
    console.log(`  body:                ${ra.body === rb.body ? "UNCHANGED" : "MOVED"}`);
    console.log(`  REST list commit_id: ${restListA === restListB ? "UNCHANGED" : "MOVED"}  (${restListA} -> ${restListB})`);
    console.log(`  REST byId commit_id: ${ra.commit_id === rb.commit_id ? "UNCHANGED" : "MOVED"}  (${ra.commit_id} -> ${rb.commit_id})`);
    if (gA && gB) {
      console.log(`  GraphQL commit.oid:  ${gA.commit.oid === gB.commit.oid ? "UNCHANGED" : "MOVED"}  (${gA.commit.oid} -> ${gB.commit.oid})`);
    } else {
      console.log("  GraphQL commit.oid:  could not correlate this review between snapshots (matched by submittedAt+author) — not compared");
    }
    console.log("");
  }
}

function main(): void {
  const [mode, ...rest] = process.argv.slice(2);
  if (mode === "snapshot") return cmdSnapshot(rest);
  if (mode === "diff") return cmdDiff(rest);
  throw new Error(
    "usage:\n" +
      "  bun run scripts/verify-review-commit-immutability.ts snapshot <owner/repo> <pr-number> [out-file]\n" +
      "  bun run scripts/verify-review-commit-immutability.ts diff <snapshot-a.json> <snapshot-b.json>",
  );
}

try {
  main();
} catch (e) {
  console.error("FAILED:", e);
  process.exit(1);
}
