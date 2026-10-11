import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir, cpus, platform, release } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';
import assert from 'node:assert/strict';

const folder=mkdtempSync(join(tmpdir(),'cognate-relay-benchmark-'));
const allocator=createServer();allocator.listen(0,'127.0.0.1');await once(allocator,'listening');
const port=allocator.address().port;await new Promise(resolve=>allocator.close(resolve));
const url=`http://127.0.0.1:${port}`;
const executable=resolve(process.env.COGNATE_RELAY_BINARY || `server/target/release/cognate-relay${process.platform==='win32'?'.exe':''}`);
let child,logs='';
async function start() {
  child=spawn(executable,[],{env:{...process.env,RELAY_ADDR:`127.0.0.1:${port}`,RELAY_DATA:join(folder,'data.json'),RELAY_TOKEN:'synthetic-benchmark-token',RELAY_RATE_LIMIT:'100000'},stdio:['ignore','pipe','pipe']});
  child.stdout.on('data',b=>{logs+=b;});child.stderr.on('data',b=>{logs+=b;});
  const until=Date.now()+10000;
  while(Date.now()<until) {try {if((await fetch(`${url}/health`)).ok)return;}catch {} await delay(100);}
  throw new Error(`Relay failed to start: ${logs}`);
}
async function stop(signal='SIGTERM') { if(child && child.exitCode===null) {child.kill(signal);await once(child,'exit');} }
function usage(pid) {
  if(process.platform!=='linux')return null;
  const status=readFileSync(`/proc/${pid}/status`,'utf8'),stat=readFileSync(`/proc/${pid}/stat`,'utf8').split(') ')[1].split(' ');
  const ticks=Number(execFileSync('getconf',['CLK_TCK'],{encoding:'utf8'}));
  return {cpu_ms:(Number(stat[11])+Number(stat[12]))/ticks*1000,peak_rss_bytes:Number(status.match(/VmHWM:\s+(\d+)/)?.[1]||0)*1024};
}
const headers={'Authorization':'Bearer synthetic-benchmark-token','Content-Type':'application/json'};
const body=JSON.stringify({v:1,nonce:'synthetic-nonce',ct:'x'.repeat(30000)});
const samples=[];
try {
  await start();const before=usage(child.pid),cpu=process.cpuUsage(),startTime=performance.now();
  for(let i=0;i<250;i++) {
    const startTime=performance.now();
    const response=await fetch(`${url}/v2/rooms/synthetic/batches/batch-${i}`,{method:'PUT',headers,body,signal:AbortSignal.timeout(15000)});
    assert.equal(response.status,200);const ack=await response.json();assert.equal(ack.durable,true);assert.equal(ack.cursor,i+1);
    samples.push(performance.now()-startTime);
  }
  const duration=performance.now()-startTime,after=usage(child.pid),clientCpu=process.cpuUsage(cpu);
  await stop('SIGKILL');await start();
  let cursor=0,count=0;
  for(let page=0;page<251;page++) {
    const response=await fetch(`${url}/v2/rooms/synthetic/batches?after=${cursor}`,{headers});assert.equal(response.status,200);
    const result=await response.json();count+=result.batches.length;cursor=result.cursor;if(!result.batches.length)break;
  }
  assert.equal(count,250);assert.equal(cursor,250);
  const duplicate=await fetch(`${url}/v2/rooms/synthetic/batches/batch-0`,{method:'PUT',headers,body});assert.equal((await duplicate.json()).cursor,1);
  const collision=await fetch(`${url}/v2/rooms/synthetic/batches/batch-0`,{method:'PUT',headers,body:JSON.stringify({v:1,nonce:'synthetic-nonce',ct:'different'})});assert.equal(collision.status,409);
  const sorted=[...samples].sort((a,b)=>a-b);
  const report={format:'cognate-relay-benchmark',version:1,commit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),working_tree_modified:!!execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim(),captured_at:new Date().toISOString(),platform:platform(),os_release:release(),cpu:cpus()[0]?.model,mode:'release binary, loopback HTTP, actual fsync-backed journal; synthetic opaque payloads, not signed client convergence',batches:250,payload_bytes:Buffer.byteLength(body),total_ms:duration,median_ms:sorted[125],p95_ms:sorted[237],relay_cpu_ms:after&&before?after.cpu_ms-before.cpu_ms:null,relay_peak_rss_bytes:after?.peak_rss_bytes??null,client_cpu_ms:(clientCpu.user+clientCpu.system)/1000,samples_ms:samples,restart_replay:true,duplicate_acknowledgement:true,collision_rejected:true};
  const path=process.argv[2]||'benchmarks/relay-latest.json';mkdirSync(resolve(path,'..'),{recursive:true});writeFileSync(path,JSON.stringify(report,null,2)+'\n');
  console.log(`250 durable HTTP batches: median ${report.median_ms.toFixed(1)} ms, p95 ${report.p95_ms.toFixed(1)} ms. Hard-kill/replay, duplicate ACK and collision checks passed.`);
  if(process.env.COGNATE_BENCH_CHECK==='1') assert(report.p95_ms<1000,'Relay p95 exceeded the provisional CI regression allowance');
} finally {await stop();}
