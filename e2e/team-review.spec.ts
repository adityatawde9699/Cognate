import {test,expect} from '@playwright/test';
import {FakeBatchRelay} from '../src/services/fixtures/fakeBatchRelay';

test('team review excludes unknown capacity and applies only a current proposal',async({page})=>{
 const relay=new FakeBatchRelay();
 await page.route('https://relay.example/**',async route=>{
  const req=route.request();
  if(req.method()==='OPTIONS'){await route.fulfill({status:204,headers:{'access-control-allow-origin':'*','access-control-allow-methods':'GET,PUT,POST,OPTIONS','access-control-allow-headers':'*'}});return;}
  const response=relay.handle(req.method(),req.url(),req.postData() ?? undefined);
  await route.fulfill({status:response.status,body:await response.text(),headers:{'content-type':'application/json','access-control-allow-origin':'*'}});
 });
 await page.goto('/');await expect(page.locator('.plan-autoplan')).toBeVisible();
 await page.evaluate(async()=>{
  const dbPath='/src/db.js',sharePath='/src/services/shareService.ts';
  const db=await import(/* @vite-ignore */dbPath),service=await import(/* @vite-ignore */sharePath);
  await db.initDb();
  const p=await db.createProject('Reviewed team','green');
  await db.createTask({title:'Reviewed assignment',description:'',deadline:'',tags:[],importance:3,effort:3,project_id:p.id});
  await service.createShare(p.id,'Reviewed team','https://relay.example');
 });
 await page.locator('.dock-link',{hasText:'Settings'}).click();await page.getByRole('button',{name:'Sync & Team'}).click();
 await page.getByRole('button',{name:'Balance workload'}).click();
 await expect(page.getByText('Excluded from automatic assignments.',{exact:false})).toBeVisible();
 await expect(page.getByRole('button',{name:/^Apply \d+ assignment/})).toHaveCount(0);
 await page.getByRole('button',{name:'Share my busy times'}).click();
 await expect(page.getByText('Availability shared',{exact:true})).toBeVisible();
 await page.getByRole('button',{name:'Balance workload'}).click();
 await expect(page.getByRole('list',{name:'Proposed assignments'})).toContainText('Reviewed assignment');
 await page.evaluate(async()=>{
  const path='/src/db.js';const db=await import(/* @vite-ignore */path);
  await db.createCalendarEvent({title:'Changed since review',start:db.getLocalDateString()+'T09:00:00',end:db.getLocalDateString()+'T10:00:00',source:'manual'});
 });
 await page.getByRole('button',{name:'Apply 1 assignment',exact:true}).click();
 await expect(page.getByText('Tasks, roster or availability changed. Review a fresh proposal.',{exact:true})).toBeVisible();
 await page.getByRole('button',{name:'Share my busy times'}).click();
 await expect(page.getByText(/Saved today’s availability for sharing/)).toBeVisible();
 await page.getByRole('button',{name:'Balance workload'}).click();
 await page.getByRole('button',{name:'Apply 1 assignment',exact:true}).click();
 await expect(page.getByRole('list',{name:'Proposed assignments'})).toHaveCount(0);
 const assignments=await page.evaluate(async()=>{const dbPath='/src/db.js',projectPath='/src/services/collabProjection.ts';const db=await import(/* @vite-ignore */dbPath),projection=await import(/* @vite-ignore */projectPath);return projection.projectAssignees(await db.loadOps()).size;});
 expect(assignments).toBe(1);
});
