import assert from 'node:assert/strict';
import {test} from 'node:test';
import type {ExtensionAPI} from '@earendil-works/pi-coding-agent';
import {registerRuntimeAgent,listRuntimeAgentConfigs,clearRuntimeAgentsForPi,type RuntimeAgentDefinition} from '../../src/agents/runtime-agent-registry.ts';
import type {ResolvedSubagentCapabilityCeiling} from '../../src/runs/shared/capability-ceiling.ts';
type Snapshot={version:1;agents:readonly {name:string;definition:RuntimeAgentDefinition}[]};
type Api={
 captureRuntimeAgentSnapshot:(pi:ExtensionAPI,ceiling?:ResolvedSubagentCapabilityCeiling)=>Snapshot;
 validateRuntimeAgentSnapshot:(value:unknown)=>Snapshot;
 filterRuntimeAgentSnapshot:(value:Snapshot,ceiling?:ResolvedSubagentCapabilityCeiling)=>Snapshot;
 registerRuntimeAgentSnapshot:(pi:ExtensionAPI,value:Snapshot)=>{dispose():void};
};
const url=new URL('../../src/agents/runtime-agent-snapshot.ts',import.meta.url).href;
const imported:unknown=await import(url).catch(()=>({}));
function fn<K extends keyof Api>(name:K):Api[K]{
 const value=(imported as Record<string,unknown>)[name];
 assert.equal(typeof value,'function',name+' must exist');return value as Api[K];
}
const owner=()=>({on(){},registerTool(){}} as unknown as ExtensionAPI);
const definition=(text='prompt'):RuntimeAgentDefinition=>({description:'test role',systemPrompt:text,tools:['read'],excludeTools:['bash'],model:'openai-codex/gpt-6.1-sol',thinking:'medium',extensions:['/owned/tool.ts'],allowNestedSubagents:false,allowedAgents:[]});
const ceiling=(names:string[]):ResolvedSubagentCapabilityCeiling=>({version:1,denyExtensions:false,allowedAgents:names,sources:['test']});

test('capture uses only its owner and canonical permitted roles',()=>{
 const pi=owner(),other=owner();try{
  for(const name of ['profile.developer.coder','profile.developer.tester','profile.developer.other'])registerRuntimeAgent({pi,name,definition:definition()});
  registerRuntimeAgent({pi:other,name:'foreign',definition:definition()});
  const snapshot=fn('captureRuntimeAgentSnapshot')(pi,ceiling(['profile.developer.coder','profile.developer.tester']));
  assert.deepEqual(snapshot.agents.map(a=>a.name),['profile.developer.coder','profile.developer.tester']);
  assert.deepEqual(fn('captureRuntimeAgentSnapshot')(pi,ceiling([])).agents,[]);
  assert.equal(fn('captureRuntimeAgentSnapshot')(other).agents.length,1);
 }finally{clearRuntimeAgentsForPi(pi);clearRuntimeAgentsForPi(other);}
});

test('capture deeply fixes definitions and filtering cannot regain excluded roles',()=>{
 const pi=owner();try{
  registerRuntimeAgent({pi,name:'role',definition:definition('original')});
  const snapshot=fn('captureRuntimeAgentSnapshot')(pi);
  listRuntimeAgentConfigs(pi)[0]!.tools!.push('write');
  clearRuntimeAgentsForPi(pi);registerRuntimeAgent({pi,name:'role',definition:definition('replacement')});
  assert.equal(snapshot.agents[0]!.definition.systemPrompt,'original');
  assert.deepEqual(snapshot.agents[0]!.definition.tools,['read']);
  assert.ok(Object.isFrozen(snapshot)&&Object.isFrozen(snapshot.agents[0]!.definition.tools));
  assert.deepEqual(fn('filterRuntimeAgentSnapshot')(fn('filterRuntimeAgentSnapshot')(snapshot,ceiling([]))).agents,[]);
  assert.deepEqual(fn('validateRuntimeAgentSnapshot')(JSON.parse(JSON.stringify(snapshot))),snapshot);
 }finally{clearRuntimeAgentsForPi(pi);}
});

test('validation rejects malformed, duplicate, colliding and oversized payloads without registrations',()=>{
 const validate=fn('validateRuntimeAgentSnapshot');
 for(const value of [{version:2,agents:[]},{version:1,agents:[],extra:true},{version:1,agents:[{name:'a',definition:{...definition(),unknown:true}}]},{version:1,agents:[{name:'a',definition:definition()},{name:'a',definition:definition()}]},{version:1,agents:[{name:'a',definition:{...definition(),aliases:['b']}},{name:'b',definition:definition()}]},{version:1,agents:Array.from({length:201},(_,i)=>({name:'role-'+i,definition:definition()}))},{version:1,agents:[{name:'large',definition:definition('x'.repeat(1024*1024))}]}])assert.throws(()=>validate(value));
});

test('registration rollback and dispose preserve parent and unrelated child registrations',()=>{
 const parent=owner(),child=owner();try{
  registerRuntimeAgent({pi:parent,name:'a',definition:definition()});registerRuntimeAgent({pi:parent,name:'b',definition:definition()});
  registerRuntimeAgent({pi:child,name:'b',definition:definition('existing')});
  const snapshot=fn('captureRuntimeAgentSnapshot')(parent);
  assert.throws(()=>fn('registerRuntimeAgentSnapshot')(child,snapshot));
  assert.deepEqual(listRuntimeAgentConfigs(child).map(a=>a.name),['b']);
  clearRuntimeAgentsForPi(child);
  registerRuntimeAgent({pi:child,name:'unrelated',definition:definition()});
  const handle=fn('registerRuntimeAgentSnapshot')(child,snapshot);handle.dispose();handle.dispose();
  assert.deepEqual(listRuntimeAgentConfigs(child).map(a=>a.name),['unrelated']);
  assert.deepEqual(listRuntimeAgentConfigs(parent).map(a=>a.name),['a','b']);
 }finally{clearRuntimeAgentsForPi(parent);clearRuntimeAgentsForPi(child);}
});

test('snapshot registration preserves ordinary operator model overrides without overriding tools or body',async()=>{
 const fs=await import('node:fs'),os=await import('node:os'),path=await import('node:path');
 const {mergeRuntimeAgents}=await import('../../src/agents/runtime-agent-registry.ts');
 const {discoverAgents}=await import('../../src/agents/agents.ts');
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'snapshot-settings-'));const oldHome=process.env.HOME,oldAgent=process.env.PI_CODING_AGENT_DIR;
 const parent=owner(),child=owner();
 try{
  process.env.HOME=home;delete process.env.PI_CODING_AGENT_DIR;
  const dir=path.join(home,'.pi','agent');fs.mkdirSync(dir,{recursive:true});
  fs.writeFileSync(path.join(dir,'settings.json'),JSON.stringify({subagents:{defaultModel:'openai/gpt-5-mini',agentOverrides:{role:{model:'anthropic/claude-sonnet-4',thinking:'medium',tools:['bash'],systemPrompt:'not allowed'}}}}));
  registerRuntimeAgent({pi:parent,name:'role',definition:{description:'role',systemPrompt:'original',tools:['read']}});
  const snapshot=fn('captureRuntimeAgentSnapshot')(parent);const handle=fn('registerRuntimeAgentSnapshot')(child,snapshot);
  try{
   const settings={cwd:home,scope:'both' as const};
   const read=(pi:ExtensionAPI)=>mergeRuntimeAgents(pi,discoverAgents(home,'both'),undefined,settings).agents.find(a=>a.name==='role');
   const before=read(parent),after=read(child);assert.ok(before&&after);
   for(const role of [before,after]){assert.equal(role.source,'runtime');assert.equal(role.filePath,'runtime:role');assert.equal(role.model,'anthropic/claude-sonnet-4');assert.equal(role.thinking,'medium');assert.deepEqual(role.tools,['read']);assert.equal(role.systemPrompt,'original');}
  }finally{handle.dispose();}
 }finally{clearRuntimeAgentsForPi(parent);clearRuntimeAgentsForPi(child);if(oldHome===undefined)delete process.env.HOME;else process.env.HOME=oldHome;if(oldAgent===undefined)delete process.env.PI_CODING_AGENT_DIR;else process.env.PI_CODING_AGENT_DIR=oldAgent;fs.rmSync(home,{recursive:true,force:true});}
});
