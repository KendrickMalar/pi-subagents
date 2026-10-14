import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {test} from 'node:test';
import * as sdk from '@earendil-works/pi-coding-agent';
import type {ExtensionAPI} from '@earendil-works/pi-coding-agent';
import {registerRuntimeAgent,clearRuntimeAgentsForPi} from '../../src/agents/runtime-agent-registry.ts';
import {captureRuntimeAgentSnapshot} from '../../src/agents/runtime-agent-snapshot.ts';
import {buildInProcessChildLaunch} from '../../src/runs/shared/child-launch.ts';
import {createDefaultChildSessionFactory} from '../../src/runs/shared/child-session.ts';

test('real native factory exposes the parent-permitted runtime roles without a model request',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'native-inheritance-'));
 const parent={on(){},registerTool(){}} as unknown as ExtensionAPI;
 let underlying:Awaited<ReturnType<typeof sdk.createAgentSession>>['session']|undefined;
 const errors:string[]=[];
 const factory=createDefaultChildSessionFactory({loadPiCodingAgent:async()=>({...sdk,createAgentSession:async options=>{
  const created=await sdk.createAgentSession(options);underlying=created.session;return created;
 }})});
 try{
  for(const name of ['profile.developer.coder','profile.developer.tester','foreign'])registerRuntimeAgent({pi:parent,name,definition:{description:'inherited test role',systemPrompt:'test prompt',tools:['read'],model:'inherit',thinking:'medium',allowNestedSubagents:false,allowedAgents:[]}});
  const snapshot=captureRuntimeAgentSnapshot(parent);
  const launch=buildInProcessChildLaunch({cwd:root,host:'parent',sessionEnabled:false,inheritProjectContext:false,inheritGlobalContext:false,inheritSkills:false,childAgentName:'native-inheritance-manager',childIndex:0,tools:['subagent','subagent_supervisor','bg_wait'],allowNestedSubagents:true,descendantAllowedAgents:['profile.developer.coder','profile.developer.tester'],extensions:[],runtimeAgentSnapshot:snapshot,model:'anthropic/claude-sonnet-4-5'});
  const child=await factory.create({...launch.session,onExtensionError:error=>errors.push(String(error.event)+': '+String(error.error))});
  assert.ok(underlying);assert.deepEqual(errors,[]);
  const names=underlying.getActiveToolNames();
  for(const name of ['subagent','subagent_supervisor','bg_wait'])assert.ok(names.includes(name),name);
  const subagent=underlying.agent.state.tools.find(tool=>tool.name==='subagent');assert.ok(subagent);
  // Execute only readonly management through the real SDK-bound tool, never prompt.
  const list=await subagent.execute('native-list',{action:'list',capabilities:true},new AbortController().signal);
  const text=JSON.stringify(list.content);
  assert.ok(text.includes('profile.developer.coder'),text);assert.ok(text.includes('profile.developer.tester'),text);
  assert.ok(!text.includes('foreign (runtime)'),text);
  for(const name of ['profile.developer.coder','profile.developer.tester']){
   const result=await subagent.execute('native-models-'+name,{action:'models',agent:name},new AbortController().signal);
   assert.ok(!JSON.stringify(result.content).includes('not found'),JSON.stringify(result.content));
  }
  assert.equal(child.messages.length,0);assert.equal(underlying.messages.length,0);
  await child.dispose();assert.deepEqual(errors,[]);
 }finally{await factory.dispose();clearRuntimeAgentsForPi(parent);fs.rmSync(root,{recursive:true,force:true});}
});
