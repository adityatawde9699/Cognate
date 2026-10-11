// W3C WebDriver over the real Tauri webview. Use only the smoke-identified build.
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import assert from 'node:assert/strict';

const application=resolve(process.env.COGNATE_SMOKE_BINARY || `src-tauri/target/release/cognate${process.platform==='win32'?'.exe':''}`);
const profile=mkdtempSync(join(tmpdir(),'cognate-native-smoke-'));
const env={...process.env};
if(process.platform==='linux') Object.assign(env,{XDG_CONFIG_HOME:join(profile,'config'),XDG_DATA_HOME:join(profile,'data'),XDG_CACHE_HOME:join(profile,'cache'),GDK_BACKEND:'x11',WEBKIT_DISABLE_DMABUF_RENDERER:'1'});
const driver=spawn(process.env.COGNATE_TAURI_DRIVER || 'tauri-driver',['--port','4450','--native-port','4451'],{env,stdio:['ignore','pipe','pipe']});
let logs=''; driver.stdout.on('data',b=>{logs+=b;}); driver.stderr.on('data',b=>{logs+=b;});
driver.on('error',error=>{logs+=String(error);});
let session,ownedPid;
const checks=[];
async function request(method,path,body) {
  const response=await fetch(`http://127.0.0.1:4450${path}`,{method,headers:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(30_000)});
  const json=await response.json();
  if(!response.ok || json.value?.error) throw new Error(JSON.stringify(json.value));
  return json.value;
}
async function wait(fn) {
  const until=Date.now()+30_000; let error;
  while(Date.now()<until) { try {const result=await fn();if(result)return result;}catch(e){error=e;} await delay(150); }
  throw error || new Error('Native smoke timed out');
}
const execute=script=>request('POST',`/session/${session}/execute/sync`,{script,args:[]});
async function invoke(command,args={}) {
  const result=await request('POST',`/session/${session}/execute/async`,{script:'const done=arguments[arguments.length-1]; window.__TAURI_INTERNALS__.invoke(arguments[0],arguments[1]).then(value=>done({ok:true,value}),error=>done({ok:false,error:String(error)}));',args:[command,args]});
  if(!result.ok) throw new Error(result.error); return result.value;
}
async function element(selector) { return request('POST',`/session/${session}/element`,{using:'css selector',value:selector}); }
const key=el=>el['element-6066-11e4-a52e-4f735466cecf'];
async function click(selector) {const el=await wait(()=>element(selector));await request('POST',`/session/${session}/element/${key(el)}/click`,{});}
async function launch() {
  const result=await request('POST','/session',{capabilities:{alwaysMatch:{'tauri:options':{application}},firstMatch:[{}]}}); session=result.sessionId;
  await request('POST',`/session/${session}/timeouts`,{script:30000});
  await wait(()=>execute('return !!window.__TAURI_INTERNALS__ && !!document.querySelector(".app-shell");'));
  assert.equal(await invoke('plugin:app|identifier'),'com.cognate.smoke','Refusing to mutate a production profile. Build with tauri.smoke.conf.json.');
  ownedPid=await invoke('desktop_process_id');
  await execute('const skip=[...document.querySelectorAll("button")].find(b=>/skip/i.test(b.textContent)); if(skip) skip.click(); return true;');
  await wait(()=>execute("return !document.querySelector('[aria-label=\"Welcome to Cognate\"]');"));
}
try {
  await wait(async()=>{const response=await fetch('http://127.0.0.1:4450/status');return response.ok;});
  await launch();
  checks.push({check:'webview-and-profile',passed:true});
  const health=await invoke('desktop_health'); checks.push(...health); assert(health.every(c=>c.passed),'Desktop integration probe failed');
  await click('.plan-capture');
  const title=await element('input[aria-label="Task title"]');
  await request('POST',`/session/${session}/element/${key(title)}/value`,{text:'Native smoke task',value:[...'Native smoke task']});
  await click('.editor-panel button[type="submit"]');
  const snapshot=await wait(async()=>{const state=await invoke('planning_snapshot');return state.tasks.some(t=>t.title==='Native smoke task')&&state;});
  const task=snapshot.tasks.find(t=>t.title==='Native smoke task');
  assert(snapshot.tasks.filter(t=>t.title==='Native smoke task').length===1);
  checks.push({check:'ui-task-sqlite-commit',passed:true});
  const backup=await invoke('backup_database',{reason:'native-smoke'});
  await invoke('mutate_tasks',{query:'UPDATE tasks SET title=? WHERE id=?',values:['Edited after snapshot',task.id]});
  await invoke('plugin:sql|close',{db:'sqlite:cognote.db'});
  await invoke('restore_backup',{name:backup.name});
  const restored=await invoke('planning_snapshot'); assert.equal(restored.tasks.find(t=>t.id===task.id).title,'Native smoke task');
  checks.push({check:'sqlite-backup-and-restore',passed:true});
  await invoke('plugin:window|close',{label:'main'});
  assert(!(await invoke('desktop_health')).find(c=>c.check==='window').passed);
  const second=spawn(application,[],{env,stdio:'ignore'});
  await wait(()=>second.exitCode!==null); assert.equal(second.exitCode,0);
  await wait(async()=>(await invoke('desktop_health')).find(c=>c.check==='window').passed);
  checks.push({check:'close-to-tray-and-second-launch-restoration',passed:true});
  ownedPid=await invoke('desktop_process_id'); assert(Number.isInteger(ownedPid)&&ownedPid>1);
  process.kill(ownedPid,'SIGKILL'); ownedPid=null;
  await request('DELETE',`/session/${session}`).catch(()=>{}); session=null;
  await launch();
  const reopened=await invoke('planning_snapshot'); assert.equal(reopened.tasks.find(t=>t.id===task.id).title,'Native smoke task');
  checks.push({check:'hard-kill-and-reopen-preserves-acknowledged-write',passed:true});
  mkdirSync('test-results',{recursive:true});
  writeFileSync('test-results/native-smoke.json',JSON.stringify({platform:process.platform,application,profile,checks,passed:true},null,2)+'\n');
  console.log(`Native smoke passed: ${checks.length} checks on ${process.platform}.`);
} catch(error) { console.error(logs.slice(-8000)); throw error; }
finally {
  if(session) await request('DELETE',`/session/${session}`).catch(()=>{});
  if(ownedPid) {try {process.kill(ownedPid,'SIGTERM');} catch {}}
  driver.kill();
}
