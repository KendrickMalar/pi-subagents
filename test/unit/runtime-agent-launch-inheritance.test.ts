import assert from 'node:assert/strict';import {test} from 'node:test';import os from 'node:os';
import type {ExtensionAPI} from '@earendil-works/pi-coding-agent';
import * as snapshotApi from '../../src/agents/runtime-agent-snapshot.ts';
import {registerRuntimeAgent,clearRuntimeAgentsForPi} from '../../src/agents/runtime-agent-registry.ts';
import type {AgentConfig} from '../../src/agents/agents.ts';
import type {ResolvedSubagentCapabilityCeiling} from '../../src/runs/shared/capability-ceiling.ts';
import {buildRunnerChildLaunch} from '../../src/runs/background/runner-child-launch.ts';
import type {RunnerSubagentStep} from '../../src/runs/shared/parallel-utils.ts';
const owner=()=>({on(){},registerTool(){}} as unknown as ExtensionAPI);
const manager={name:'manager',tools:['subagent'],allowedAgents:['coder','tester']} as AgentConfig;
const prepare=()=>{
 const fn=(snapshotApi as unknown as Record<string,unknown>).prepareRuntimeAgentSnapshot;
 assert.equal(typeof fn,'function','launch snapshot preparation must exist');
 return fn as (pi:ExtensionAPI|undefined,agent:AgentConfig,ceiling?:ResolvedSubagentCapabilityCeiling,retained?:snapshotApi.RuntimeAgentSnapshot)=>snapshotApi.RuntimeAgentSnapshot|undefined;
};
test('launch capture intersects selected-agent policy and keeps retained empty meaningful',()=>{
 const pi=owner();try{
  for(const name of ['coder','tester','foreign'])registerRuntimeAgent({pi,name,definition:{description:'role',systemPrompt:'original '+name,tools:['read']}});
  const current=prepare()(pi,manager,{version:1,allowedAgents:['tester','foreign'],denyExtensions:false,sources:['parent']});
  assert.deepEqual(current?.agents.map(a=>a.name),['tester']);
  assert.deepEqual(prepare()(pi,manager,undefined,{version:1,agents:[]})?.agents,[]);
  assert.equal(prepare()(pi,{...manager,tools:['read'],allowNestedSubagents:false}),undefined);
  const fixed=prepare()(pi,manager);assert.ok(fixed);clearRuntimeAgentsForPi(pi);
  registerRuntimeAgent({pi,name:'coder',definition:{description:'replacement',systemPrompt:'replacement'}});
  assert.deepEqual(prepare()(pi,manager,undefined,fixed),fixed);
 }finally{clearRuntimeAgentsForPi(pi);}
});
test('runner launch carries the same validated, policy-limited snapshot as foreground',()=>{
 const snapshot:snapshotApi.RuntimeAgentSnapshot={version:1,agents:[{name:'coder',definition:{description:'role',systemPrompt:'original coder',tools:['read'],allowNestedSubagents:false}}]};
 const step={agent:'manager',task:'task',tools:['subagent'],allowNestedSubagents:true,allowedAgents:['coder'],extensions:[],runtimeAgentSnapshot:snapshot} as RunnerSubagentStep & {runtimeAgentSnapshot:snapshotApi.RuntimeAgentSnapshot};
 const launch=buildRunnerChildLaunch(step,{cwd:os.tmpdir(),id:'snapshot-test',flatIndex:0},{sessionEnabled:false,watchdogStatus(){}});
 assert.deepEqual(launch.config.runtimeAgentSnapshot,snapshot);
});

test('explicit pi runners remain native for both manager and inherited role',()=>{
 const pi=owner();try{
  registerRuntimeAgent({pi,name:'coder',definition:{description:'native',systemPrompt:'native',tools:['read'],runner:{type:'pi'}}});
  const snapshot=prepare()(pi,{...manager,allowedAgents:['coder'],runner:{type:'pi'}});
  assert.deepEqual(snapshot?.agents.map(a=>a.name),['coder']);
  assert.deepEqual(snapshotApi.validateRuntimeAgentSnapshot(snapshot).agents[0]?.definition.runner,{type:'pi'});
 }finally{clearRuntimeAgentsForPi(pi);}
});
