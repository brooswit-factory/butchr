import {unitAgentKey,type AgentMatch,type ExecutionUnit} from '../rules/execution.js';
import type {Rule} from '../rules/rules.js';
export function admittedPolicyUnits<M extends AgentMatch>(units:readonly ExecutionUnit<M>[],policy:{isUnresolvedAgent:(id:string)=>boolean;ruleForAgent:(id:string)=>Rule|undefined}):ExecutionUnit<M>[] {
 return units.flatMap(unit=>{const id=unitAgentKey(unit);if(policy.isUnresolvedAgent(id))return [];const original=unit.kind==='resource'?unit.match.rule:unit.rule,rule=policy.ruleForAgent(id)??original;return [unit.kind==='resource'?{kind:'resource' as const,match:{...unit.match,rule}}:{...unit,rule}];});
}
