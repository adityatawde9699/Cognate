import { createServer } from 'vite';
import { performance } from 'node:perf_hooks';
import { cpus, totalmem, platform, release, arch } from 'node:os';
import { mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';

const repetitions = Number(process.env.COGNATE_BENCH_REPETITIONS || 7);
assert(Number.isInteger(repetitions) && repetitions >= 3 && repetitions <= 30);
const server = await createServer({ configFile: false, optimizeDeps: { noDiscovery: true, entries: [] }, server: { middlewareMode: true, hmr: false }, appType: 'custom' });
const rows = [];
try {
  const { planLocally } = await server.ssrLoadModule('/src/services/planService.ts');
  const { Clock, entityToOps, merge, materialize } = await server.ssrLoadModule('/src/services/oplog.ts');
  const { projectTasks } = await server.ssrLoadModule('/src/services/projector.ts');
  function measure(name, size, fn) {
    for (let i = 0; i < 2; i++) fn();
    const samples = [];
    for (let i = 0; i < repetitions; i++) {
      const cpu = process.cpuUsage(), before = process.memoryUsage(), start = performance.now();
      fn();
      const elapsed = performance.now() - start, used = process.cpuUsage(cpu), after = process.memoryUsage();
      samples.push({ duration_ms: elapsed, cpu_ms: (used.user + used.system) / 1000, rss_bytes: after.rss, heap_delta_bytes: after.heapUsed - before.heapUsed });
    }
    const sorted = samples.map(s => s.duration_ms).sort((a,b) => a-b);
    rows.push({ name, size, median_ms: sorted[Math.floor(sorted.length/2)], p95_ms: sorted[Math.ceil(sorted.length*.95)-1], samples });
  }
  for (const size of [100, 1000, 10000]) {
    const tasks = Array.from({length:size}, (_,i) => ({id:`task-${i}`,title:`Synthetic task ${i}`,duration_min:15+(i%4)*15,energy:['hi','med','lo'][i%3],deadline:'',priority:['high','medium','low'][i%3],importance:1+i%5,pinned:false,pinned_start_min:null}));
    const request = {date:'2026-10-11',work_start_min:360,work_end_min:1380,tasks,busy:[{start_min:720,end_min:780,title:'Synthetic meeting'}]};
    measure('typescript-planner', size, () => {
      const result = planLocally(request);
      assert.equal(result.blocks.length + result.unscheduled.length, size);
      for (const block of result.blocks) assert(block.start_min >= 360 && block.end_min <= 1380);
    });
  }
  const clock = new Clock('synthetic-benchmark');
  const ops = Array.from({length:10000}, (_,i) => entityToOps(clock,`task-${i}`,{title:`Synthetic task ${i}`,importance:3,effort:3,done:false,tags:[]},1000)).flat();
  assert.equal(ops.length,50000);
  measure('operation-admission-merge', ops.length, () => assert.equal(merge(ops,ops).length,50000));
  measure('operation-materialization', ops.length, () => assert.equal(materialize(ops).size,10000));
  measure('task-projection', ops.length, () => assert.equal(projectTasks(ops).length,10000));
  measure('history-serialization', ops.length, () => assert.equal(JSON.parse(JSON.stringify(ops)).length,50000));
  const report = { format:'cognate-benchmark',version:1,commit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),working_tree_modified:!!execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim(),captured_at:new Date().toISOString(),runtime:process.version,mode:'Vite SSR transforms, Node runtime; not browser or native startup',hardware:{platform:platform(),release:release(),arch:arch(),cpu:cpus()[0]?.model,logical_cpus:cpus().length,total_memory_bytes:totalmem()},warmups:2,repetitions,process_peak_rss_bytes:process.resourceUsage().maxRSS*1024,rows };
  const path = resolve(process.argv[2] || 'benchmarks/latest.json'); mkdirSync(resolve(path,'..'),{recursive:true}); writeFileSync(path,JSON.stringify(report,null,2)+'\n');
  for (const row of rows) console.log(`${row.name} (${row.size}): median ${row.median_ms.toFixed(1)} ms, p95 ${row.p95_ms.toFixed(1)} ms`);
  console.log(`Raw benchmark report: ${path}`);
  if (process.env.COGNATE_BENCH_CHECK === '1') {
    // Generous CI allowances derived from the retained local baseline, not UI SLAs.
    const budgets = {'typescript-planner':250,'operation-admission-merge':2500,'operation-materialization':2000,'task-projection':2000,'history-serialization':500};
    for (const row of rows) assert(row.p95_ms <= budgets[row.name],`${row.name} exceeded the regression budget`);
  }
} finally { await server.close(); }
