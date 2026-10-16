bump: minor

### Removed
- Removed the admission:withheld Jira label namespace, producer/carry-forward wiring, registry and sweep support. Label synchronization now owns only agent:* and pr:*.
- check_worker now reports staffed, not-staffed or could-not-look using the live herd observation or agent:* label. Obsolete admission markers never change that result.
- Stall remediation no longer reads worker labels or treats the obsolete marker as a waiting exemption. In Review, unanswered asks, quota protection and wake deduplication remain intact.
- Actual admission caps, wait queues, rate limits, safety controls and capacity dashboard rows are unchanged. Existing deployed daemons must receive the updated build before they stop recreating the old label; removing stored Jira labels is a separate coordinated operation.
