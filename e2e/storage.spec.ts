import { test, expect } from '@playwright/test';

test('legacy migration retains the source and survives an interrupted first transaction', async ({ page }) => {
  const legacy = [{id:'legacy',title:'Legacy work',description:'',deadline:'',tags:[],importance:3,effort:3,done:false,priority:'medium',created_at:'2026-01-01',sort_order:0}];
  await page.addInitScript(rows => {
    if (!localStorage.getItem('cn_tasks_v2')) localStorage.setItem('cn_tasks_v2',JSON.stringify(rows));
    if (!sessionStorage.getItem('injected-migration')) {
      const original = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function(...args) {
        if (this.name==='workspace') {
          sessionStorage.setItem('injected-migration','1');
          throw new DOMException('Injected storage interruption','QuotaExceededError');
        }
        return original.apply(this,args as Parameters<typeof original>);
      };
    }
  }, legacy);
  await page.goto('/');
  await expect.poll(() => page.evaluate(()=>sessionStorage.getItem('injected-migration'))).toBe('1');
  expect(await page.evaluate(()=>localStorage.getItem('cn_tasks_v2'))).toBe(JSON.stringify(legacy));
  await page.reload();
  await page.locator('.nav-btn',{hasText:'Tasks'}).click();
  await expect(page.locator('.task-card',{hasText:'Legacy work'})).toHaveCount(1);
  await page.reload();
  await page.locator('.nav-btn',{hasText:'Tasks'}).click();
  await expect(page.locator('.task-card',{hasText:'Legacy work'})).toHaveCount(1);
  expect(await page.evaluate(()=>localStorage.getItem('cn_tasks_v2'))).toBe(JSON.stringify(legacy));
});

test('a failed IndexedDB save preserves the editor input and durable task history', async ({ page }) => {
  await page.goto('/');
  await page.locator('.nav-btn',{hasText:'Tasks'}).click();
  await expect(page.locator('.task-card')).toHaveCount(6);
  await page.locator('.canvas-actions .btn-primary').click();
  await page.locator('.editor-title').fill('Keep this unsaved input');
  await page.evaluate(() => {
    const original = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function(...args) {
      if (this.name==='workspace') throw new DOMException('Injected quota failure','QuotaExceededError');
      return original.apply(this,args as Parameters<typeof original>);
    };
  });
  await page.locator('.editor-panel button[type="submit"]').click();
  await expect(page.locator('.editor-title')).toHaveValue('Keep this unsaved input');
  await expect(page.locator('.editor-panel').getByRole('alert')).toContainText('Save failed');
  await page.reload();
  await page.locator('.nav-btn',{hasText:'Tasks'}).click();
  await expect(page.locator('.task-card',{hasText:'Keep this unsaved input'})).toHaveCount(0);
  await expect(page.locator('.task-card')).toHaveCount(6);
});

test('stale cross-tab workspace writes fail without overwriting the committed revision', async ({ page, context }) => {
  await page.goto('/');
  await page.locator('.nav-btn',{hasText:'Tasks'}).click();
  await expect(page.locator('.task-card')).toHaveCount(6);
  const second = await context.newPage();
  await second.goto('/');
  await second.locator('.nav-btn',{hasText:'Tasks'}).click();
  await expect(second.locator('.task-card')).toHaveCount(6);
  const result = await page.evaluate(async () => {
    // Use the actual adapter with two independently held snapshots.
    // @ts-ignore Vite serves the source module in this development E2E runner.
    const storage = await import('/src/services/browserStorage.ts');
    const a = await storage.readBrowserWorkspace(()=>{throw new Error('Already migrated');});
    const b = await storage.readBrowserWorkspace(()=>{throw new Error('Already migrated');});
    a.state.settings = {...a.state.settings,storage_test:'committed'};
    b.state.settings = {...b.state.settings,storage_test:'stale'};
    await storage.writeBrowserWorkspace(a.state,a.revision);
    let rejected = false;
    try { await storage.writeBrowserWorkspace(b.state,b.revision); } catch { rejected=true; }
    const final = await storage.readBrowserWorkspace(()=>{throw new Error('Already migrated');});
    return {rejected,value:final.state.settings.storage_test};
  });
  expect(result).toEqual({rejected:true,value:'committed'});
});

test('simultaneous browser identity registration stores one complete matching keypair', async ({page}) => {
  await page.goto('/');
  await expect(page.locator('.plan-view')).toBeVisible();
  const result = await page.evaluate(async()=>{
    // @ts-ignore browser-served module
    const db = await import('/src/db.js');
    // @ts-ignore browser-served module
    const storage = await import('/src/services/browserStorage.ts');
    // @ts-ignore browser-served module
    const cryptoModule = await import('/src/services/crypto.ts');
    const first=await cryptoModule.generateSigningKeypair(),second=await cryptoModule.generateSigningKeypair();
    const pairs=await Promise.all([first,second].map(async pair=>({priv:await cryptoModule.exportPrivateKey(pair.privateKey),pub:await cryptoModule.exportPublicKey(pair.publicKey)})));
    await storage.patchBrowserWorkspace(state=>{
      delete state.settings.crdt_signing_key;delete state.settings.crdt_signing_pub;delete state.settings.crdt_signing_binding;
    });
    const actor=await db.getSetting('crdt_actor','');
    const registrations=await Promise.all(pairs.map(pair=>db.registerBrowserIdentity(actor,pair.priv,pair.pub)));
    const installed=registrations[0];
    const challenge=crypto.getRandomValues(new Uint8Array(32));
    // @ts-ignore browser-served module
    const vault=await import('/src/utils/browserVault.ts');
    const priv=await cryptoModule.importPrivateKey(await vault.decryptBrowserSecret(installed.priv)),pub=await cryptoModule.importPublicKey(installed.pub);
    return {same:registrations.every(entry=>entry.priv===installed.priv && entry.pub===installed.pub),valid:await cryptoModule.verifyBytes(pub,await cryptoModule.signBytes(priv,challenge),challenge)};
  });
  expect(result).toEqual({same:true,valid:true});
});

test('browser secrets are ciphertext and the non-exportable vault key survives reload',async({page})=>{
  await page.goto('/');await expect(page.locator('.plan-view')).toBeVisible();
  const stored=await page.evaluate(async()=>{
    // @ts-ignore browser-served module
    const secrets=await import('/src/utils/secrets.ts');
    // @ts-ignore browser-served module
    const db=await import('/src/db.js');
    await secrets.setSecret('vault-test','SECRET-AT-REST');
    return {stored:await db.getSetting('vault-test',''),plain:await secrets.getSecret('vault-test')};
  });
  expect(stored.plain).toBe('SECRET-AT-REST');expect(stored.stored).toContain('cognate-vault-v1:');expect(stored.stored).not.toContain('SECRET-AT-REST');
  await page.reload();await expect(page.locator('.plan-view')).toBeVisible();
  expect(await page.evaluate(async()=>{
    // @ts-ignore browser-served module
    return (await import('/src/utils/secrets.ts')).getSecret('vault-test');
  })).toBe('SECRET-AT-REST');
  const exportable=await page.evaluate(async()=>{
    const db=await new Promise<IDBDatabase>((resolve,reject)=>{const request=indexedDB.open('cognate-secret-vault',1);request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});
    const key=await new Promise<CryptoKey>((resolve,reject)=>{const request=db.transaction('keys').objectStore('keys').get('device');request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});db.close();return key.extractable;
  });
  expect(exportable).toBe(false);
});

test('encrypted recovery restores browser tasks and signing identity into an empty independent device',async({browser})=>{
  const A=await browser.newContext(),B=await browser.newContext();
  try {
    for(const context of [A,B]) await context.addInitScript(()=>{localStorage.setItem('cn_set_seeded','1');localStorage.setItem('cn_set_onboarded','1');});
    const a=await A.newPage();await a.goto('/');await expect(a.locator('.plan-view')).toBeVisible();
    const recovery=await a.evaluate(async()=>{
      // @ts-ignore browser-served module
      const db=await import('/src/db.js');
      // @ts-ignore browser-served module
      const identity=await import('/src/services/identity.ts');
      // @ts-ignore browser-served module
      const recovery=await import('/src/services/recoveryService.ts');
      await db.createTask({title:'Recover across devices',description:'',deadline:'',tags:[],importance:3,effort:3});
      return {kit:await recovery.exportRecoveryKit('browser-recovery-passphrase'),identity:await identity.publicIdentity()};
    });
    expect(recovery.kit).not.toContain('Recover across devices');
    const b=await B.newPage();await b.goto('/');await expect(b.locator('.plan-view')).toBeVisible();
    const restored=await b.evaluate(async({kit})=>{
      // @ts-ignore browser-served module
      const db=await import('/src/db.js');
      // @ts-ignore browser-served module
      const recovery=await import('/src/services/recoveryService.ts');
      // @ts-ignore browser-served module
      const identity=await import('/src/services/identity.ts');
      await recovery.importRecoveryKit(kit,'browser-recovery-passphrase');
      return {identity:await identity.publicIdentity(),tasks:await db.getAllTasks('all'),secret:await db.getSetting('crdt_signing_key','')};
    },recovery);
    expect(restored.identity).toEqual(recovery.identity);expect(restored.tasks[0].title).toBe('Recover across devices');expect(restored.secret).toContain('cognate-vault-v1:');
    await b.reload();await b.locator('.nav-btn',{hasText:'Tasks'}).click();await expect(b.locator('.task-card',{hasText:'Recover across devices'})).toBeVisible();
  }finally{await A.close();await B.close();}
});
