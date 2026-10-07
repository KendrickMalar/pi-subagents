import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:net";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { createReviewChannelResources, createLaunchChannel, receiveRunnerReviewChannel, encodeReviewIdentity, encodeReviewTerminal, decodeReviewTerminal, type ReviewLaunchIdentityV1, type ReviewTerminalCaptureV1 } from "../../src/runs/shared/review-provenance-channel.ts";
const config = Buffer.from('{"actual":true}');
const digest = "a".repeat(64);
const identity: ReviewLaunchIdentityV1 = { version: 1, subjectRunId: "run-1", childIndex: 0, ownerSessionId: "session", ownerSubtreeId: "tree", processInstanceId: "instance", nonce: "b".repeat(32), configDigest: createHash("sha256").update(config).digest("hex"), cwd: "/repo" };
const capture: ReviewTerminalCaptureV1 = { rawOutcome: { exitCode: 1, signal: null }, originalAcceptanceDigest: digest, evidenceDigest: digest, repo: "/repo", cwd: "/repo", head: "c".repeat(40), trackedStateDigest: digest, captureTime: 123 };
const url = new URL("../../src/runs/shared/review-provenance-channel.ts", import.meta.url).href;
function childFixture(variant = "valid", actualConfig = config, actualCapture: unknown = capture) {
 const code = `import {createReviewChannelResources,receiveRunnerReviewChannel} from ${JSON.stringify(url)};import {fstatSync,readSync,writeSync} from 'node:fs';
 const resources=createReviewChannelResources();const reader=resources.registerBootstrapReader();let ticks=0;const heartbeat=setInterval(()=>ticks++,10);let diagnostic;
 for(const fake of [{},{owned:true},3,0,1,2]){if(await receiveRunnerReviewChannel(resources,fake,Buffer.from('irrelevant'),()=>({}),Date.now()+1000))throw Error('fake reader accepted')}
 if(await receiveRunnerReviewChannel(createReviewChannelResources(),reader,Buffer.from('irrelevant'),()=>({}),Date.now()+1000))throw Error('cross factory reader accepted');
 const runner=await receiveRunnerReviewChannel(resources,reader,Buffer.from(${JSON.stringify(actualConfig.toString())}),()=>(${JSON.stringify(actualCapture)}),Date.now()+${variant === "expired" ? "-1" : "500"},d=>{diagnostic=d;if(${JSON.stringify(variant)}==='callbackthrow')throw Error('diagnostic')});
 let open=false;try{open=fstatSync(3).isSocket()}catch{};let benign=false;if(${JSON.stringify(variant)}==='missing'||${JSON.stringify(variant)}==='expired'){const b=Buffer.alloc(9);benign=readSync(3,b,0,9,null)===9;b.fill(0)}
 clearInterval(heartbeat);let signed,oneShot=false,finalizationRejected=false;try{if(runner){const s=runner.finalize();signed={bytes:s.bytes.toString('base64'),tag:s.tag.toString('base64')};try{runner.finalize()}catch{oneShot=true}}}catch{finalizationRejected=true}
 const consumedRejected=await receiveRunnerReviewChannel(resources,reader,Buffer.from('irrelevant'),()=>({}),Date.now()+1000)===undefined;
 console.log(JSON.stringify({signed,oneShot,runnerKeys:runner?Object.keys(runner):[],consumedRejected,finalizationRejected,open,benign,ticks,diagnostic,markerRemoved:!process.env.PI_SUBAGENT_REVIEW_CHANNEL_V1}));`;
 const launchCode = ["true-trailing", "true-truncated"].includes(variant) ? `import {Socket} from 'node:net';import {spawn} from 'node:child_process';const input=new Socket({fd:3,readable:true,writable:false});const chunks=[];for await(const b of input)chunks.push(b);const frame=Buffer.concat(chunks);for(const b of chunks)b.fill(0);const child=spawn(process.execPath,['--experimental-strip-types','--input-type=module','-e',${JSON.stringify(code)}],{env:process.env,stdio:['ignore','pipe','pipe','pipe']});child.stdout.pipe(process.stdout);child.stderr.pipe(process.stderr);child.stdio[3].end(${variant === "true-trailing" ? "Buffer.concat([frame,Buffer.from(' ')])" : "frame.subarray(0,frame.length-1)"},()=>frame.fill(0));await new Promise(resolve=>child.once('close',resolve));` : code;
 const child=spawn(process.execPath,["--experimental-strip-types","--input-type=module","-e",launchCode],{env:{...process.env,PI_SUBAGENT_REVIEW_CHANNEL_V1:variant === "missing" ? "invalid" : "fd3"},stdio:["ignore","pipe","pipe","pipe"]});
 let stdout="",stderr="";child.stdout!.on("data",b=>stdout+=b);child.stderr!.on("data",b=>stderr+=b);
 const result=new Promise<Record<string, unknown>>((resolve,reject)=>{child.once("error",reject);child.once("close",(exit,signal)=>{try{assert.equal(exit,0,stderr);assert.equal(signal,null);resolve(JSON.parse(stdout))}catch(e){reject(e)}})});
 return {child,result};
}
async function transfer(actualConfig = config, actualCapture: unknown = capture) {
 const resources=createReviewChannelResources();const channel=createLaunchChannel(identity,resources);const {child,result}=childFixture("valid",actualConfig,actualCapture);
 const writer=resources.registerSpawnWriter(child);assert.ok(writer);await channel.writeInitial(writer,Date.now()+1000);
 const value=await result;assert.equal(value.open,false);return {channel,value,resources};
}
test("FD-received private signer authenticates raw failure and is one-shot", async () => {
 const {channel,value}=await transfer();assert.ok(value.signed);assert.equal(value.oneShot,true);assert.deepEqual(value.runnerKeys,["finalize"]);assert.equal(value.consumedRejected,true);
 const signed=value.signed as {bytes:string;tag:string};const bytes=Buffer.from(signed.bytes,"base64"),tag=Buffer.from(signed.tag,"base64");
 assert.equal(channel.verifyTerminal(bytes,tag)?.rawOutcome.exitCode,1);
 const bad=Buffer.from(tag);bad[0]=bad[0]!^1;assert.equal(channel.verifyTerminal(bytes,bad),undefined);
 assert.equal(channel.verifyTerminal(bytes,Buffer.alloc(1)),undefined);assert.equal(channel.verifyTerminal(Buffer.concat([bytes,Buffer.from(" ")]),tag),undefined);
 assert.equal(channel.verifyTerminal(Buffer.alloc(65537),tag),undefined);assert.equal(createLaunchChannel(identity,createReviewChannelResources()).verifyTerminal(bytes,tag),undefined);
});
test("config drift, malformed actual capture and repeated transfer produce no proof without closing unused writer",async()=>{
 assert.equal((await transfer(Buffer.from("edited"))).value.signed,undefined);
 const {value,channel,resources}=await transfer(config,{...capture,reviewed:true});assert.equal(value.finalizationRejected,true);
 const {child,result}=childFixture("missing");const writer=resources.registerSpawnWriter(child);assert.ok(writer);
 await assert.rejects(channel.writeInitial(writer,Date.now()+1000));assert.equal(child.stdio[3]!.destroyed,false);
 child.stdio[3]!.end("unrelated");assert.equal((await result).benign,true);
});
test("opaque handles reject fake, clone, numeric, cross-factory and consumed before I/O",async()=>{
 const resources=createReviewChannelResources();const other=createReviewChannelResources();const channel=createLaunchChannel(identity,resources);
 for(const fake of [{},{owned:true},3,0,1,2]){
  assert.equal(await receiveRunnerReviewChannel(resources,fake as never,config,()=>capture,Date.now()+500),undefined);
  await assert.rejects(channel.writeInitial(fake as never,Date.now()+500));
 }
 assert.equal(resources.registerSpawnWriter({stdio:[],pid:123} as unknown as ChildProcess),undefined);
 const {child,result}=childFixture("missing");const writer=other.registerSpawnWriter(child);assert.ok(writer);
 await assert.rejects(channel.writeInitial(writer,Date.now()+500));await assert.rejects(channel.writeInitial({...writer},Date.now()+500));
 assert.equal(child.stdio[3]!.destroyed,false);child.stdio[3]!.end("unrelated");assert.equal((await result).benign,true);
});
test("absolute bound on held/no-data and partial-held confirms close, ordinary timers, natural exit",async()=>{
 for(const variant of ["held","partialheld"]){const {child,result}=childFixture(variant);if(variant==='partialheld')child.stdio[3]!.write('{');const value=await result;
 assert.equal(value.signed,undefined);assert.equal(value.open,false);assert.ok(Number(value.ticks)>0);const d=value.diagnostic as {elapsedMs:number;eof:boolean};assert.ok(d.elapsedMs<1000);assert.equal(d.eof,false);assert.equal(value.markerRemoved,true);
 }
});
test("missing ownership and expired deadline preserve unrelated dedicated socket for benign I/O",async()=>{
 for(const variant of ["missing","expired"]){const {child,result}=childFixture(variant);child.stdio[3]!.end("unrelated");const value=await result;assert.equal(value.signed,undefined);assert.equal(value.open,true);assert.equal(value.benign,true);assert.equal(value.diagnostic,undefined)}
});
test("initial frame limit, truncation and extra bytes fail closed and close owned socket",async()=>{
 for(const bytes of [Buffer.alloc(4097),Buffer.from('{'),Buffer.from('{} '),Buffer.from('{"version":1,"identity":{},"key":"x"}')]){const {child,result}=childFixture();child.stdio[3]!.end(bytes);const value=await result;assert.equal(value.signed,undefined);assert.equal(value.open,false)}
});
test("diagnostic callback exception does not prevent actual owned close or signer",async()=>{
 const resources=createReviewChannelResources();const channel=createLaunchChannel(identity,resources);const {child,result}=childFixture("callbackthrow");const writer=resources.registerSpawnWriter(child);assert.ok(writer);await channel.writeInitial(writer,Date.now()+1000);const value=await result;assert.ok(value.signed);assert.equal(value.open,false);
});
test("strict codecs reject fake fields, invalid values and noncanonical bytes", () => {
	assert.equal(encodeReviewIdentity(identity).toString(), JSON.stringify(identity));
	const envelope = { version: 1 as const, identity, ...capture };
	const bytes = encodeReviewTerminal(envelope);
	assert.deepEqual(decodeReviewTerminal(bytes), envelope);
	for (const invalid of [[], { ...identity, extra: true }, { ...identity, childIndex: NaN }, { ...identity, childIndex: -1 }, { ...identity, cwd: "/repo/../repo" }, { ...identity, cwd: "/repo/" }, { ...identity, subjectRunId: "run\n" }, { ...identity, nonce: "x".repeat(32) }]) assert.throws(() => encodeReviewIdentity(invalid));
	for (const invalid of [{ ...envelope, reviewed: true }, { ...envelope, cwd: "/other" }, { ...envelope, rawOutcome: { exitCode: null, signal: null } }, { ...envelope, rawOutcome: { exitCode: -1, signal: null } }, { ...envelope, rawOutcome: { exitCode: 0, signal: "SIGTERM" } }, { ...envelope, captureTime: Infinity }, { ...envelope, head: "short" }, { ...envelope, evidenceDigest: "A".repeat(64) }, { ...envelope, repo: "/" + "x".repeat(65536) }]) assert.throws(() => encodeReviewTerminal(invalid));
	assert.throws(() => decodeReviewTerminal(Buffer.from(JSON.stringify(envelope, null, 2))));
	assert.throws(() => decodeReviewTerminal(Buffer.from('{"version":1,"version":1}')));
});


test("invalid and expired writer deadlines do not consume or close a new writer", async () => {
 const resources=createReviewChannelResources();const channel=createLaunchChannel(identity,resources);const {child,result}=childFixture();
 const writer=resources.registerSpawnWriter(child);assert.ok(writer);assert.equal(resources.registerSpawnWriter(child),undefined);
 for(const deadline of [NaN,Infinity,-1,Date.now()-1]){await assert.rejects(channel.writeInitial(writer,deadline));assert.equal(child.stdio[3]!.destroyed,false)}
 await channel.writeInitial(writer,Date.now()+1000);assert.ok((await result).signed);
 const {child:unused,result:unusedResult}=childFixture("missing");const another=resources.registerSpawnWriter(unused);assert.ok(another);
 await assert.rejects(createLaunchChannel(identity,resources).writeInitial(writer,Date.now()+1000));
 unused.stdio[3]!.end("unrelated");assert.equal((await unusedResult).benign,true);
});

test("trailing and truncated genuine secret frames are rejected without writing them to files", async () => {
 for(const variant of ["true-trailing", "true-truncated"]){
  const resources=createReviewChannelResources();const channel=createLaunchChannel(identity,resources);const {child,result}=childFixture(variant);
  const writer=resources.registerSpawnWriter(child);assert.ok(writer);await channel.writeInitial(writer,Date.now()+1000);
  const value=await result;assert.equal(value.signed,undefined);assert.equal(value.open,false);
 }
});

test("actual public slot3 EPIPE remains caught through queued error and owned close, then exits naturally", async () => {
 const code=`import {spawn} from 'node:child_process';import {createHash} from 'node:crypto';import {statSync} from 'node:fs';import {createLaunchChannel,createReviewChannelResources} from ${JSON.stringify(url)};
 const resources=createReviewChannelResources();const child=spawn(process.execPath,['-e',"require('node:fs').closeSync(3); console.log('peer-closed'); setTimeout(()=>console.log('peer-ordinary-timer'),100);"],{stdio:['ignore','pipe','pipe','pipe']});
 const stream=child.stdio[3];stream.pause();stream.allowHalfOpen=true;const writer=resources.registerSpawnWriter(child);if(!writer)throw Error('registration');
 const channel=createLaunchChannel(${JSON.stringify(identity)},resources);let started=false;
 child.stdout.on('data',async bytes=>{console.log('child:'+bytes.toString().trim());if(started)return;started=true;
 try{await channel.writeInitial(writer,Date.now()+500);throw Error('unexpected success')}catch(error){console.log('caught:'+String(error))}
 console.log('owned-close:'+stream.closed);setTimeout(()=>{console.log('ordinary-timer-and-io:'+statSync(process.cwd()).isDirectory())},50)});
 child.stderr.pipe(process.stderr);child.on('close',(code,signal)=>console.log('child-close:'+JSON.stringify({code,signal})));`;
 const child=spawn(process.execPath,["--experimental-strip-types","--input-type=module","-e",code],{stdio:["ignore","pipe","pipe"]});
 let stdout="",stderr="";child.stdout.on("data",b=>stdout+=b);child.stderr.on("data",b=>stderr+=b);
 const outcome=await new Promise<{code:number|null;signal:string|null}>((resolve,reject)=>{child.once('error',reject);child.once('close',(code,signal)=>resolve({code,signal}))});
 assert.equal(outcome.code,0,stderr);assert.equal(outcome.signal,null);
 assert.match(stdout,/caught:Error: Review channel write failed/);assert.match(stdout,/owned-close:true/);assert.match(stdout,/ordinary-timer-and-io:true/);assert.match(stdout,/peer-ordinary-timer/);assert.match(stdout,/child-close:\{"code":0,"signal":null\}/);
});

test("slow actual owned writer close fails within the original absolute deadline, not another 1000ms", async () => {
 const resources=createReviewChannelResources();const channel=createLaunchChannel(identity,resources);const {child,result}=childFixture();
 const stream=child.stdio[3]!;const destroy=stream.destroy.bind(stream);
 // Keep the actual spawned public socket: postpone its actual destruction/close.
 stream.destroy=(error?: Error)=>{setTimeout(()=>destroy(error),200);return stream};
 const writer=resources.registerSpawnWriter(child);assert.ok(writer);const start=Date.now();
 await assert.rejects(channel.writeInitial(writer,start+80),/close unconfirmed|deadline/);
 assert.ok(Date.now()-start<150,"cleanup must not add a fresh 1000ms");
 await new Promise<void>(resolve=>{if(stream.closed)resolve();else stream.once('close',resolve)});
 assert.equal(stream.closed,true);assert.ok((await result).signed);
});


test("registered FD3 replaced before adoption refuses the unrelated socket and preserves manual I/O", async () => {
 const server=createServer(socket=>{socket.on("error",()=>{});socket.write("unrelated")});await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
 const address=server.address();assert.ok(address&&typeof address!=="string");
 const code=`import {fstatSync,closeSync,readSync} from 'node:fs';import {connect} from 'node:net';import {createReviewChannelResources,receiveRunnerReviewChannel} from ${JSON.stringify(url)};
 const warm=connect(${address.port},'127.0.0.1');warm.on('error',()=>{});await new Promise(resolve=>warm.once('connect',resolve));warm.destroy();await new Promise(resolve=>warm.once('close',resolve));
 const r=createReviewChannelResources();const reader=r.registerBootstrapReader();if(!reader)throw Error('registration');const old=fstatSync(3,{bigint:true});closeSync(3);
 const socket=connect(${address.port},'127.0.0.1');socket.pause();await new Promise(resolve=>socket.once('connect',resolve));const fresh=fstatSync(3,{bigint:true});if(!fresh.isSocket()||old.dev===fresh.dev&&old.ino===fresh.ino)throw Error('actual different socket not installed');
 await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('replacement readiness timeout')),500);socket.once('readable',()=>{clearTimeout(timer);resolve()});socket.once('error',reject)});
 const result=await receiveRunnerReviewChannel(r,reader,Buffer.from('irrelevant'),()=>({}),Date.now()+100);let open=false;try{open=fstatSync(3).isSocket()}catch{};
 const b=socket.read(9);const manual=Buffer.isBuffer(b)&&b.length===9&&b.toString()==='unrelated';
 console.log(JSON.stringify({unsupported:result===undefined,open,manual}));socket.destroy();`;
 const child=spawn(process.execPath,["--experimental-strip-types","--input-type=module","-e",code],{env:{...process.env,PI_SUBAGENT_REVIEW_CHANNEL_V1:"fd3"},stdio:["ignore","pipe","pipe","pipe"]});
 let stdout="",stderr="";child.stdout.on("data",b=>stdout+=b);child.stderr.on("data",b=>stderr+=b);
 try{const exit=await new Promise(resolve=>child.once("close",resolve));assert.equal(exit,0,stderr);assert.deepEqual(JSON.parse(stdout),{unsupported:true,open:true,manual:true})}finally{server.close()}
});
