import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {test} from 'node:test';
import type {ExtensionAPI,ExtensionContext,ToolDefinition} from '@earendil-works/pi-coding-agent';
import {registerRuntimeAgent,listRuntimeAgentConfigs,clearRuntimeAgentsForPi} from '../../src/agents/runtime-agent-registry.ts';
import {captureRuntimeAgentSnapshot,type RuntimeAgentSnapshot} from '../../src/agents/runtime-agent-snapshot.ts';
import {buildInProcessChildLaunch,inheritedChildRuntime,type BuildInProcessChildLaunchInput} from '../../src/runs/shared/child-launch.ts';
import type {ChildRuntimeConfig} from '../../src/runs/shared/child-runtime-config.ts';
import registerFanout from '../../src/extension/fanout-child.ts';
import {createEventBus,makeMinimalCtx} from '../support/helpers.ts';
const owner=()=>({on(){},registerTool(){}} as unknown as ExtensionAPI);
function fixture(){
 const pi=owner();for(const name of ['profile.developer.coder','profile.developer.tester','other'])registerRuntimeAgent({pi,name,definition:{description:'role',systemPrompt:'role prompt',tools:['read'],model:'openai-codex/gpt-6.1-sol',thinking:'medium',allowNestedSubagents:false,allowedAgents:[]}});
 const snapshot=captureRuntimeAgentSnapshot(pi);clearRuntimeAgentsForPi(pi);return snapshot;
}
function input(snapshot:RuntimeAgentSnapshot):BuildInProcessChildLaunchInput & {runtimeAgentSnapshot:RuntimeAgentSnapshot}{
 return {cwd:os.tmpdir(),host:'parent',sessionEnabled:false,inheritProjectContext:false,inheritGlobalContext:false,inheritSkills:false,childAgentName:'manager',childIndex:0,allowNestedSubagents:true,tools:['subagent','subagent_supervisor','bg_wait'],descendantAllowedAgents:['profile.developer.coder','profile.developer.tester'],extensions:[],runtimeAgentSnapshot:snapshot};
}
test('common native launch intersects and fixes descendant runtime definitions',()=>{
 const launch=buildInProcessChildLaunch(input(fixture()));
 const config=launch.config as ChildRuntimeConfig & {runtimeAgentSnapshot?:RuntimeAgentSnapshot};
 assert.deepEqual(config.runtimeAgentSnapshot?.agents.map(a=>a.name),['profile.developer.coder','profile.developer.tester']);
 const inherited=inheritedChildRuntime(config) as ReturnType<typeof inheritedChildRuntime> & {runtimeAgentSnapshot?:RuntimeAgentSnapshot};
 assert.deepEqual(inherited?.runtimeAgentSnapshot,config.runtimeAgentSnapshot);
 const leaf=buildInProcessChildLaunch({...input(fixture()),tools:['read'],allowNestedSubagents:false});
 assert.equal((leaf.config as typeof config).runtimeAgentSnapshot,undefined);
});

test('fanout child list and models share inherited definitions and dispose only this owner',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'inherited-roles-'));
 const tools=new Map<string,ToolDefinition>();
 const handlers=new Map<string,Array<()=>void>>();
 const pi={events:createEventBus(),on(name:string,handler:()=>void){const list=handlers.get(name)??[];list.push(handler);handlers.set(name,list);},registerTool(tool:ToolDefinition){tools.set(tool.name,tool);},getAllTools(){return [...tools.values()];},getCommands(){return [];}} as unknown as ExtensionAPI;
 try{
  registerRuntimeAgent({pi,name:'unrelated',definition:{description:'keep',systemPrompt:'keep'}});
  const config=buildInProcessChildLaunch({...input(fixture()),cwd:root}).config;
  registerFanout(pi,config);
  const tool=tools.get('subagent');assert.ok(tool);
  const ctx={...makeMinimalCtx(root),model:{provider:'openai-codex',id:'gpt-6.1-sol'},modelRegistry:{getAvailable:()=>[{provider:'openai-codex',id:'gpt-6.1-sol'}]}} as unknown as ExtensionContext;
  const result=await tool.execute('list',{action:'list',capabilities:true},new AbortController().signal,undefined,ctx);
  const text=JSON.stringify(result.content);
  assert.ok(text.includes('profile.developer.coder'),text);assert.ok(text.includes('profile.developer.tester'),text);
  for(const name of ['profile.developer.coder','profile.developer.tester']){
   const model=await tool.execute('model-'+name,{action:'models',agent:name},new AbortController().signal,undefined,ctx);
   assert.ok(!model.isError,JSON.stringify(model.content));assert.match(JSON.stringify(model.content),/gpt-6\.1-sol/);
  }
  for(const handler of handlers.get('session_shutdown')??[])handler();
  assert.deepEqual(listRuntimeAgentConfigs(pi).map(a=>a.name),['unrelated']);
 }finally{clearRuntimeAgentsForPi(pi);fs.rmSync(root,{recursive:true,force:true});}
});

test('failed inherited registration does not poison the fanout owner on retry',()=>{
 const tools=new Map<string,ToolDefinition>();
 const pi={events:createEventBus(),on(){},registerTool(tool:ToolDefinition){tools.set(tool.name,tool);},getAllTools(){return [...tools.values()];},getCommands(){return [];}} as unknown as ExtensionAPI;
 const base:ChildRuntimeConfig={fanoutChild:true,depth:1,waitTool:{enabled:true},fast:false};
 try{
  assert.throws(()=>registerFanout(pi,{...base,runtimeAgentSnapshot:{version:1,agents:[{name:'worker',definition:{description:'collision',systemPrompt:'collision'}}]}}));
  registerFanout(pi,{...base,runtimeAgentSnapshot:fixture()});
  assert.ok(tools.has('subagent'),'the valid retry must install the tool');
  assert.equal(listRuntimeAgentConfigs(pi).length,3);
 }finally{clearRuntimeAgentsForPi(pi);}
});
