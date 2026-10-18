import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {test} from 'node:test';
import type {ExtensionAPI} from '@earendil-works/pi-coding-agent';import type {AgentConfig} from '../../src/agents/agents.ts';
import {createChildSafeState} from '../../src/extension/fanout-child.ts';
import {persistForegroundRunHistory,restoreForegroundRunHistory} from '../../src/runs/foreground/foreground-history.ts';
import {validateRuntimeAgentSnapshot,prepareRuntimeAgentSnapshot} from '../../src/agents/runtime-agent-snapshot.ts';
import {registerRuntimeAgent,clearRuntimeAgentsForPi} from '../../src/agents/runtime-agent-registry.ts';

test('foreground 64KiB-plus snapshot survives save restore and retained resume preparation',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'history-inheritance-'));const pi={on(){},registerTool(){}} as unknown as ExtensionAPI;
 const snapshot=validateRuntimeAgentSnapshot({version:1,agents:[{name:'coder',definition:{description:'role',systemPrompt:'x'.repeat(70000),tools:['read']}}]});
 const state=createChildSafeState();state.currentSessionId='history-parent';
 state.foregroundRuns!.set('paused',{runId:'paused',mode:'single',cwd:root,sessionId:'history-parent',updatedAt:1,children:[{agent:'manager',index:0,status:'paused',resumeContract:{runtimeAgentSnapshot:snapshot,outputMode:'inline',acceptance:false}}]});
 try{
  persistForegroundRunHistory(state,{resultsDir:root});
  const restored=createChildSafeState();restored.currentSessionId='history-parent';
  assert.equal(restoreForegroundRunHistory(restored,{resultsDir:root}),1,'a valid snapshot must not drop the run');
  const retained=restored.foregroundRuns!.get('paused')!.children[0]!.resumeContract!.runtimeAgentSnapshot;
  assert.ok(retained);assert.equal(retained.agents[0]!.definition.systemPrompt.length,70000);
  registerRuntimeAgent({pi,name:'coder',definition:{description:'current',systemPrompt:'replacement'}});
  const prepared=prepareRuntimeAgentSnapshot(pi,{name:'manager',tools:['subagent'],allowedAgents:['coder']} as AgentConfig,undefined,retained);
  assert.equal(prepared?.agents[0]?.definition.systemPrompt,'x'.repeat(70000));
 }finally{clearRuntimeAgentsForPi(pi);fs.rmSync(root,{recursive:true,force:true});}
});

test('foreground retains the original bound for non-snapshot resume fields',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'history-base-bound-'));const state=createChildSafeState();state.currentSessionId='bound-parent';
 const snapshot=validateRuntimeAgentSnapshot({version:1,agents:[{name:'coder',definition:{description:'role',systemPrompt:'x'.repeat(70000)}}]});
 state.foregroundRuns!.set('oversized-base',{runId:'oversized-base',mode:'single',cwd:root,sessionId:'bound-parent',updatedAt:1,children:[{agent:'manager',index:0,status:'paused',resumeContract:{runtimeAgentSnapshot:snapshot,output:'z'.repeat(70000)}}]});
 try{persistForegroundRunHistory(state,{resultsDir:root});const restored=createChildSafeState();restored.currentSessionId='bound-parent';assert.equal(restoreForegroundRunHistory(restored,{resultsDir:root}),0);}finally{fs.rmSync(root,{recursive:true,force:true});}
});
