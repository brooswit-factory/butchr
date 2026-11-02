/** Pure library: importing it never reads history/state, changes services or issues a permit. */
export {prepareExistingTargetContinuationOperator} from '../../src/control-panel/worker-continuation-operator.js';
export {issueExistingTargetContinuationPermit} from '../../src/control-panel/worker-rollout.js';
export {createContinuationPolicyReader,continuationIssueHash} from '../../src/control-panel/worker-continuation-policy.js';
export {createRealWorkerRenewalInspection,realRenewalInspectionIO,renewalEvidenceHash} from '../../src/control-panel/worker-renewal-inspection.js';
export {readRegisteredRuleIntent} from '../../src/control-panel/registered-rule-readback.js';
export {REPLACEMENT_HISTORY_LIMITS} from '../../src/control-panel/worker-replacement-operator.js';

export {assertClaudeTargetReady} from '../../src/control-panel/worker-target-readiness.js';
// Pure existing configured-client factories for operator-local read-only policy checks.
// Callers keep configuration/credentials on the owning host; no import-time reads.
export {AtlassianClient} from '../../src/atlassian/client.js';
export {loadAtlassianConfig} from '../../src/config/config.js';
export {splitServiceEnvironment} from '../../src/control-panel/worker-renewal-inspection.js';
