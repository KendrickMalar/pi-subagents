import assert from 'node:assert/strict';import childProcess from 'node:child_process';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {syncBuiltinESMExports} from 'node:module';import {test} from 'node:test';
import type {ExtensionAPI} from '@earendil-works/pi-coding-agent';
import {registerRuntimeAgent,clearRuntimeAgentsForPi} from '../../src/agents/runtime-agent-registry.ts';
import {executeAsyncSingle} from '../../src/runs/background/async-execution.ts';
import {readAsyncRecoveryDescriptor} from '../../src/runs/background/async-resume.ts';
import {DIRS} from '../../src/shared/types.ts';import {makeAgent} from '../support/helpers.ts';

test('detached preparation persists the fixed permitted catalog and rejects malformed recovery',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'catalog-recovery-'));
 const id='catalog-'+Date.now().toString(36);const asyncDir=path.join(DIRS.async,id);
 const pi={on(){},registerTool(){},events:{emit(){}}} as unknown as ExtensionAPI;
 for(const name of ['profile.developer.coder','profile.developer.tester','foreign'])registerRuntimeAgent({pi,name,definition:{description:'role',systemPrompt:'original '+name,tools:['read']}});
 const spawn=t.mock.method(childProcess,'spawn',()=>{throw new Error('captured detached spawn');});syncBuiltinESMExports();
 try{
  const result=await executeAsyncSingle(id,{agent:'manager',task:'prepare only',agentConfig:makeAgent('manager',{tools:['subagent'],allowNestedSubagents:true,allowedAgents:['profile.developer.coder','profile.developer.tester']}),ctx:{pi,cwd:root,currentSessionId:'catalog-parent'},artifactConfig:{enabled:false,includeInput:false,includeOutput:false,includeJsonl:false,includeMetadata:false,cleanupDays:7},shareEnabled:false,sessionRoot:path.join(root,'sessions'),maxSubagentDepth:3,acceptance:false});
  assert.equal(result.isError,true);assert.equal(spawn.mock.callCount(),1);
  const descriptor=readAsyncRecoveryDescriptor(asyncDir);assert.ok(descriptor);
  assert.deepEqual(descriptor.runtimeAgentSnapshot?.agents.map(a=>a.name),['profile.developer.coder','profile.developer.tester']);
  clearRuntimeAgentsForPi(pi);
  registerRuntimeAgent({pi,name:'profile.developer.coder',definition:{description:'changed',systemPrompt:'replacement'}});
  assert.equal(readAsyncRecoveryDescriptor(asyncDir)?.runtimeAgentSnapshot?.agents[0]?.definition.systemPrompt,'original profile.developer.coder');
  const file=path.join(asyncDir,'recovery-descriptor.json');const raw=JSON.parse(fs.readFileSync(file,'utf8'));raw.runtimeAgentSnapshot={version:2,agents:[]};fs.writeFileSync(file,JSON.stringify(raw));
  assert.throws(()=>readAsyncRecoveryDescriptor(asyncDir));
 }finally{clearRuntimeAgentsForPi(pi);t.mock.restoreAll();syncBuiltinESMExports();fs.rmSync(root,{recursive:true,force:true});fs.rmSync(asyncDir,{recursive:true,force:true});}
});
