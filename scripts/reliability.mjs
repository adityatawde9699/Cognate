import { createServer } from 'vite';
import { execFileSync } from 'node:child_process';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const server = await createServer({configFile:false,optimizeDeps:{noDiscovery:true,entries:[]},server:{middlewareMode:true,hmr:false},appType:'custom'});
const seed = 20261011;
let state = seed;
const random = max => { state = (Math.imul(state,1664525)+1013904223)>>>0; return state%max; };
try {
  const {planLocally} = await server.ssrLoadModule('/src/services/planService.ts');
  const corpus = JSON.parse(readFileSync('src/services/fixtures/planner-contract.json','utf8'));
  const cases = corpus.map(c=>c.request);
  for (let i=0;i<256;i++) {
    const start=240+random(300), end=start+120+random(600);
    const tasks=Array.from({length:random(80)},(_,n)=>{
      const pinned=random(5)===0;
      return {id:`case-${i}-task-${n}`,title:`Synthetic ${n}`,duration_min:1+random(240),energy:['hi','med','lo'][random(3)],deadline:['','2026-10-10','2026-10-11','2026-10-12'][random(4)],priority:['high','medium','low'][random(3)],importance:1+random(5),pinned,pinned_start_min:pinned && random(5) ? random(1441) : null};
    });
    const busy=Array.from({length:random(12)},(_,n)=>{const s=random(1400);return {start_min:s,end_min:Math.min(1440,s+1+random(180)),title:`Synthetic meeting ${n}`};});
    cases.push({date:'2026-10-11',work_start_min:start,work_end_min:end,tasks,busy,energy_curve:Array.from({length:24},()=>random(3))});
  }
  const executable = process.env.COGNATE_PLANNER_RUNNER || `src-tauri/target/debug/planner-fixture${process.platform==='win32'?'.exe':''}`;
  const native=JSON.parse(execFileSync(executable,[],{input:JSON.stringify(cases),maxBuffer:32*1024*1024,encoding:'utf8'}));
  for (const [index,request] of cases.entries()) {
    let result;
    try { result=planLocally(request); } catch { assert('Err' in native[index],`TS rejected input accepted by Rust, case ${index}`); continue; }
    assert('Ok' in native[index],`Rust rejected input accepted by TS, case ${index}`);
    const {pin:_pin,...rust}=native[index].Ok;
    assert.deepEqual(result,rust,`Rust/TS planner drift, seed ${seed}, case ${index}`);
    const ids=[...result.blocks,...result.unscheduled].map(b=>b.task_id);
    assert.equal(new Set(ids).size, request.tasks.length); assert.equal(ids.length,request.tasks.length);
    for (const b of result.blocks) {
      assert(b.start_min>=request.work_start_min && b.end_min<=request.work_end_min && b.end_min>b.start_min);
      assert(!request.busy.some(m=>m.start_min<b.end_min && m.end_min>b.start_min));
      assert(!result.blocks.some(other=>other!==b && other.start_min<b.end_min && other.end_min>b.start_min));
    }
  }
  mkdirSync('test-results',{recursive:true});
  writeFileSync('test-results/planner-parity.json',JSON.stringify({seed,cases:cases.length,passed:true},null,2)+'\n');
  console.log(`Production Rust/TS differential planner check passed: ${cases.length} cases (seed ${seed}).`);
} finally {await server.close();}
