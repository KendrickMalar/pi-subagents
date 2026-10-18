import type {ExtensionAPI} from '@earendil-works/pi-coding-agent';
import {listRuntimeAgentDefinitions,listRuntimeAgentConfigs,mergeRuntimeAgents,registerRuntimeAgent,validateRuntimeAgentDefinition,type RuntimeAgentDefinition,type RuntimeAgentRegistration} from './runtime-agent-registry.ts';
import {isAgentAllowedByCapabilityCeiling,intersectSubagentCapabilityCeilings,type ResolvedSubagentCapabilityCeiling} from '../runs/shared/capability-ceiling.ts';
import {discoverAgents,discoverAgentSnapshot,type AgentScope,type AgentConfig} from './agents.ts';

export interface RuntimeAgentSnapshotEntry {readonly name:string;readonly definition:RuntimeAgentDefinition}
export interface RuntimeAgentSnapshot {readonly version:1;readonly agents:readonly RuntimeAgentSnapshotEntry[]}
const MAX_AGENTS=200;
const MAX_BYTES=1024*1024;
function isNativeLocal(definition:Pick<RuntimeAgentDefinition,'runner'|'machine'>):boolean{
 return (definition.runner===undefined||definition.runner.type==='pi')&&definition.machine===undefined;
}
function object(value:unknown):Record<string,unknown>{
 if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Invalid runtime agent snapshot object');
 return value as Record<string,unknown>;
}
function keys(value:Record<string,unknown>,allowed:readonly string[]):void{
 if(Object.keys(value).some(key=>!allowed.includes(key)))throw new Error('Unknown runtime agent snapshot field');
}
function freeze<T>(value:T):T{
 if(value&&typeof value==='object'){
  for(const child of Object.values(value))freeze(child);
  Object.freeze(value);
 }
 return value;
}

/** Parse a detached JSON value, never retain references to the launching owner. */
export function validateRuntimeAgentSnapshot(value:unknown):RuntimeAgentSnapshot{
 let json:string|undefined;
 try{json=JSON.stringify(value);}catch{throw new Error('Runtime agent snapshot is not JSON');}
 if(json===undefined||Buffer.byteLength(json,'utf8')>MAX_BYTES)throw new Error('Runtime agent snapshot exceeds 1 MiB');
 const input=object(JSON.parse(json));keys(input,['version','agents']);
 if(input.version!==1||!Array.isArray(input.agents)||input.agents.length>MAX_AGENTS)throw new Error('Invalid runtime agent snapshot version or agent count');
 const identities=new Set<string>();
 const agents:RuntimeAgentSnapshotEntry[]=input.agents.map((raw:unknown)=>{
  const entry=object(raw);keys(entry,['name','definition']);
  if(typeof entry.name!=='string'||!entry.name||entry.name.trim()!==entry.name||entry.name.length>128||/[\x00-\x1f\x7f]/.test(entry.name))throw new Error('Invalid runtime agent snapshot name');
  const definition=validateRuntimeAgentDefinition(entry.definition);
  if(!isNativeLocal(definition))throw new Error('Runtime agent inheritance supports native local definitions only');
  for(const key of [entry.name,...(definition.aliases??[]).filter(alias=>alias!==entry.name)]){
   if(identities.has(key))throw new Error('Runtime agent snapshot identity collision');
   identities.add(key);
  }
  return {name:entry.name,definition};
 });
 return freeze({version:1,agents});
}

export function captureRuntimeAgentSnapshot(pi:ExtensionAPI,ceiling?:ResolvedSubagentCapabilityCeiling):RuntimeAgentSnapshot{
 const agents=listRuntimeAgentDefinitions(pi).filter(entry=>
  isNativeLocal(entry.definition)&&isAgentAllowedByCapabilityCeiling(entry.name,ceiling));
 return validateRuntimeAgentSnapshot({version:1,agents});
}

export function filterRuntimeAgentSnapshot(snapshot:RuntimeAgentSnapshot,ceiling?:ResolvedSubagentCapabilityCeiling):RuntimeAgentSnapshot{
 const validated=validateRuntimeAgentSnapshot(snapshot);
 return validateRuntimeAgentSnapshot({version:1,agents:validated.agents.filter(entry=>isAgentAllowedByCapabilityCeiling(entry.name,ceiling))});
}

/** Registration is transactional for this attempt and cleanup never clears another owner. */
export function registerRuntimeAgentSnapshot(pi:ExtensionAPI,snapshot:RuntimeAgentSnapshot):RuntimeAgentRegistration{
 const validated=validateRuntimeAgentSnapshot(snapshot);
 const handles:RuntimeAgentRegistration[]=[];
 try{
  for(const entry of validated.agents)handles.push(registerRuntimeAgent({pi,name:entry.name,definition:entry.definition}));
 }catch(error){for(const handle of handles.reverse())handle.dispose();throw error;}
 let disposed=false;
 return {dispose(){if(disposed)return;disposed=true;for(const handle of handles.reverse())handle.dispose();}};
}

/** Parent and fanout execution must use the same configured/runtime collision checks. */
export function discoverAgentsForRuntime(pi:ExtensionAPI,cwd:string,scope:AgentScope,preferredModelProvider?:string,options:Parameters<typeof discoverAgents>[3]={}){
 if(listRuntimeAgentConfigs(pi).length===0)return discoverAgents(cwd,scope,preferredModelProvider,options);
 const snapshot=discoverAgentSnapshot(cwd,scope,preferredModelProvider,{...options,includeChains:false});
 const all=snapshot.all,discovered=snapshot.effective;
 const merged=mergeRuntimeAgents(pi,discovered,[...all.builtin,...all.package,...all.user,...all.project],{cwd,scope,preferredModelProvider});
 if(discovered.maxThinking===undefined)return merged;
 return {...merged,agents:merged.agents.map(agent=>agent.maxThinking===discovered.maxThinking?agent:{...agent,maxThinking:discovered.maxThinking})};
}

/** Retained empty is authority too: revival must not acquire the live owner's catalog. */
export function prepareRuntimeAgentSnapshot(pi:ExtensionAPI|undefined,agent:Pick<AgentConfig,'name'|'tools'|'excludeTools'|'allowNestedSubagents'|'allowedAgents'|'runner'|'machine'>,ceiling?:ResolvedSubagentCapabilityCeiling,retained?:RuntimeAgentSnapshot):RuntimeAgentSnapshot|undefined{
 if(!isNativeLocal(agent)||agent.excludeTools?.includes('subagent')||(!agent.tools?.includes('subagent')&&agent.allowNestedSubagents!==true)||ceiling?.allowedTools&&!ceiling.allowedTools.includes('subagent'))return undefined;
 const effective=intersectSubagentCapabilityCeilings(ceiling,agent.allowedAgents===undefined?undefined:{version:1,allowedAgents:[...agent.allowedAgents],denyExtensions:false,sources:['agent:'+agent.name]});
 if(retained!==undefined)return filterRuntimeAgentSnapshot(retained,effective);
 if(pi===undefined)return undefined;
 const snapshot=captureRuntimeAgentSnapshot(pi,effective);
 return snapshot.agents.length?snapshot:undefined;
}
