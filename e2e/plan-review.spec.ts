import {test,expect} from '@playwright/test';

test('saved plan explains its freshness after reload and captures require review',async({page})=>{
 await page.goto('/');await page.locator('.plan-autoplan').click();
 await expect(page.locator('.plan-review')).toContainText('matches your current');
 const reason=await page.locator('.plan-block-why').first().innerText();
 await page.reload();await expect(page.locator('.plan-review')).toContainText('matches your current');
 await expect(page.locator('.plan-block-why').first()).toHaveText(reason);
 await page.getByRole('button',{name:'Capture task',exact:true}).click();
 await page.locator('.editor-title').fill('Review this new capture');
 await page.locator('.editor-panel button[type="submit"]').click();
 await expect(page.locator('.plan-review')).toContainText('Review needed');
 await expect(page.getByRole('button',{name:'Review Review this new capture',exact:true})).toBeVisible();
});

test('keyboard reschedule traps focus, restores focus on cancel, and atomically pins a time',async({page})=>{
 await page.goto('/');await page.locator('.plan-autoplan').click();
 const move=page.getByRole('button',{name:/^Reschedule /}).first();await expect(move).toBeVisible();
 await move.focus();await page.keyboard.press('Enter');
 const dialog=page.getByRole('dialog',{name:/Reschedule /});
 await expect(dialog).toBeVisible();await expect(dialog.getByLabel('Start time')).toBeFocused();
 await page.keyboard.press('Shift+Tab');await expect(dialog.getByRole('button',{name:'Save and pin'})).toBeFocused();
 await page.keyboard.press('Escape');await expect(dialog).toHaveCount(0);await expect(move).toBeFocused();
 await page.keyboard.press('Enter');await dialog.getByLabel('Start time').fill('11:00');
 await dialog.getByLabel('Duration (minutes)').fill('30');await dialog.getByRole('button',{name:'Save and pin'}).click();
 await expect(dialog).toHaveCount(0);await expect(page.locator('.plan-pin.is-pinned')).toHaveCount(1);
 await expect(page.locator('.plan-block').filter({has:page.locator('.plan-pin.is-pinned')}).locator('.plan-block-time')).toContainText('11:00');
 await expect(page.locator('.plan-review')).toContainText('matches your current');
 await page.reload();await expect(page.locator('.plan-pin.is-pinned')).toHaveCount(1);
});

test('reschedule conflict keeps the entered values and previous schedule',async({page})=>{
 await page.goto('/');await page.locator('.plan-autoplan').click();
 await expect(page.locator('.plan-block-time').first()).toBeVisible();
 const before=await page.locator('.plan-block-time').allTextContents();
 await page.evaluate(async()=>{const path='/src/db.js';const db=await import(/* @vite-ignore */path);await db.createCalendarEvent({title:'Occupied',start:db.getLocalDateString()+'T13:00:00',end:db.getLocalDateString()+'T14:00:00',source:'manual'});});
 await page.getByRole('button',{name:/^Reschedule /}).first().click();
 const dialog=page.getByRole('dialog',{name:/Reschedule /});
 await dialog.getByLabel('Start time').fill('13:00');await dialog.getByLabel('Duration (minutes)').fill('30');
 await dialog.getByRole('button',{name:'Save and pin'}).click();
 await expect(dialog.getByRole('alert')).toContainText('conflicts');
 await expect(dialog.getByLabel('Start time')).toHaveValue('13:00');
 expect(await page.locator('.plan-block-time').allTextContents()).toEqual(before);
});

test('failed planning preserves the prior plan and shows a persistent retry message',async({page})=>{
 await page.goto('/');await page.locator('.plan-autoplan').click();await expect(page.locator('.plan-review')).toContainText('matches your current');
 await expect(page.locator('.plan-block-time').first()).toBeVisible();
 const before=await page.locator('.plan-block-time').allTextContents();
 await page.evaluate(()=>{const put=IDBObjectStore.prototype.put;IDBObjectStore.prototype.put=function(...args){if(this.name==='workspace')throw new DOMException('Injected quota failure','QuotaExceededError');return put.apply(this,args as Parameters<typeof put>);};});
 await page.locator('.plan-autoplan').click();await expect(page.locator('.plan-action-error')).toContainText('previous plan is preserved');
 expect(await page.locator('.plan-block-time').allTextContents()).toEqual(before);
});

test('narrow touch viewport keeps capture, reschedule and backlog reachable',async({page},testInfo)=>{
 await page.setViewportSize({width:390,height:844});await page.goto('/');
 await page.locator('.plan-autoplan').click();await expect(page.getByRole('button',{name:/^Reschedule /}).first()).toBeVisible();
 const first=await page.locator('.plan-block').nth(0).boundingBox(),second=await page.locator('.plan-block').nth(1).boundingBox();
 expect(first && second && first.y+first.height<=second.y).toBeTruthy();
 await page.screenshot({path:testInfo.outputPath('plan-mobile.png')});
 await page.getByRole('button',{name:/^Reschedule /}).first().click();
 await expect(page.getByRole('dialog',{name:/Reschedule /})).toBeVisible();
 expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
 await page.getByRole('button',{name:'Cancel',exact:true}).click();
 await page.getByRole('button',{name:'Capture task',exact:true}).click();await expect(page.locator('.editor-title')).toBeVisible();
 await page.locator('.editor-title').fill('Touch capture to review');
 await page.locator('.editor-panel button[type="submit"]').click();
 const captured=page.getByRole('button',{name:'Review Touch capture to review',exact:true});await captured.scrollIntoViewIfNeeded();await expect(captured).toBeInViewport();
});
