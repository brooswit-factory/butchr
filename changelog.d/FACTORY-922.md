---
bump: patch
---

### Fixed

- A Jira issue poll that could not confirm whether a pure `updated` bump was a real change no longer notifies anyone (FACTORY-922/FACTORY-921): `decide()`'s old fallback used to deliver, unconditionally, on every bump it could not attribute to status/label/summary — even when nothing this poll had tried to check comments for ("unchecked"), the measured source of ~2 wakes/min/daemon of pure noise. It now actively tries the comment fetch; if the fetch is skipped under load or fails outright, it does not notify and leaves the comment-cursor snapshot untouched so the same diff reliably re-confirms on a later poll (logged once per skip as `[poll] skipped-comment-check key=<k> reason=<load|failed> retained-snapshot`, and counted in `/health` as `commentChecksSkipped`); if the fetch succeeds and nothing moved, it stays silent and advances the snapshot.
- Per the resolved decision on FACTORY-921: a reassignment, a description/brief edit, or a linked-issue add/remove are now confirmed diffs that wake the worker, named `assignee`/`description`/`issuelinks` respectively — same as status/label/summary always have. A priority-only or non-daemon-label-only change still never wakes anyone (unchanged — neither is a field this classifier tracks).
