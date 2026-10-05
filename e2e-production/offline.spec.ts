import {test,expect} from '@playwright/test';
test('production shell, fonts, and lazy chunks boot offline after installation',async({page,context})=>{
  const errors:string[]=[];
  page.on('pageerror',error=>errors.push(error.message));
  page.on('requestfailed',request=>errors.push(`${request.url()}: ${request.failure()?.errorText}`));
  await page.goto('/');
  await expect(page.locator('.plan-view')).toBeVisible();
  await page.evaluate(async()=>{
    const registration=await navigator.serviceWorker.ready;
    if (!registration.active) throw new Error('Offline worker has not activated.');
    const names=await caches.keys();
    const cache=await caches.open(names.find(name=>name.startsWith('cognate-shell-'))!);
    const requests=await cache.keys();
    if (!requests.some(request=>request.url.endsWith('.js')) || !requests.some(request=>request.url.endsWith('.css'))) throw new Error('Compiled shell assets were not precached.');
  });
  await page.waitForFunction(()=>Boolean(navigator.serviceWorker.controller));
  await context.setOffline(true);
  await page.reload();
  expect(errors).toEqual([]);
  await expect(page.locator('.plan-view')).toBeVisible();
  await page.getByRole('button',{name:'Open settings',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Settings',exact:true})).toBeVisible();
});

test('failed updates preserve offline boot and successful updates wait for every editing tab',async({page,context})=>{
  const {readFile,writeFile,unlink}=await import('node:fs/promises');
  const workerPath=new URL('../dist/sw.js',import.meta.url),original=await readFile(workerPath,'utf8');
  const indexPath=new URL('../dist/index.html',import.meta.url),originalIndex=await readFile(indexPath,'utf8'),probePath=new URL('../dist/update-probe-test.js',import.meta.url);
  try {
    await page.goto('/');await expect(page.locator('.plan-view')).toBeVisible();
    await page.waitForFunction(()=>!!navigator.serviceWorker.controller);
    const initial=await page.evaluate(async()=> (await caches.keys()).find(key=>key.startsWith('cognate-shell-'))!);
    // A bad deployment cannot replace the last complete shell.
    await writeFile(workerPath,original.replace(initial,`${initial}-broken`).replace('const SHELL = ','const SHELL = ["/missing-update-asset.js"]; const UNUSED_SHELL = '));
    await page.evaluate(async()=>{
      const registration=(await navigator.serviceWorker.getRegistration())!;
      await registration.update();
      if(registration.installing) await new Promise<void>(resolve=>{const worker=registration.installing!;worker.addEventListener('statechange',()=>{if(worker.state==='redundant' || worker.state==='installed')resolve();});});
    });
    await context.setOffline(true);await page.reload();await expect(page.locator('.plan-view')).toBeVisible();
    await context.setOffline(false);
    const second=await context.newPage();await second.goto('/');await expect(second.locator('.plan-view')).toBeVisible();
    await page.locator('.nav-btn',{hasText:'Tasks'}).click();await page.locator('.canvas-actions .btn-primary').click();
    await page.locator('.editor-title').fill('Unsaved during update');
    await writeFile(probePath,"window.__COGNATE_UPDATE_PROBE__='new-version';");
    await writeFile(indexPath,originalIndex.replace('</head>','<script src="/update-probe-test.js"></script></head>'));
    await writeFile(workerPath,original.replace(initial,`${initial}-next`).replace('const SHELL = [','const SHELL = ["/update-probe-test.js",'));
    await page.evaluate(async()=>{await (await navigator.serviceWorker.getRegistration())!.update();});
    await page.waitForFunction(async()=>!!(await navigator.serviceWorker.getRegistration())?.waiting);
    await expect(page.locator('.editor-title')).toHaveValue('Unsaved during update');
    expect(await page.evaluate(()=>caches.keys())).toContain(initial);
    await page.close();
    expect(await second.evaluate(async()=>!!(await navigator.serviceWorker.getRegistration())?.waiting)).toBe(true);
    await second.close();
    const reopened=await context.newPage();await reopened.goto('/');await expect(reopened.locator('.plan-view')).toBeVisible();
    await reopened.waitForFunction(async()=>!(await navigator.serviceWorker.getRegistration())?.waiting);
    await expect.poll(()=>reopened.evaluate(async old=>!(await caches.keys()).includes(old),initial)).toBe(true);
    const keys=await reopened.evaluate(()=>caches.keys());expect(keys).toContain(`${initial}-next`);expect(keys).not.toContain(initial);
    await context.setOffline(true);await reopened.reload();await expect(reopened.locator('.plan-view')).toBeVisible();
    expect(await reopened.evaluate(()=>(window as any).__COGNATE_UPDATE_PROBE__)).toBe('new-version');
  } finally {await writeFile(workerPath,original);await writeFile(indexPath,originalIndex);await unlink(probePath).catch(()=>{});await context.setOffline(false);}
});
