import { beforeEach, expect, it, vi } from 'vitest';
const mocks=vi.hoisted(()=>({check:vi.fn(),backup:vi.fn(),maintenance:vi.fn(),relaunch:vi.fn()}));
vi.mock('../db',()=>({IS_TAURI:true,runDatabaseMaintenance:mocks.maintenance}));
vi.mock('./backupService',()=>({createBackup:mocks.backup}));
vi.mock('@tauri-apps/plugin-updater',()=>({check:mocks.check}));
vi.mock('@tauri-apps/plugin-process',()=>({relaunch:mocks.relaunch}));
import {checkForUpdate,installUpdate,type AvailableUpdate} from './updateService';
beforeEach(()=>{vi.clearAllMocks();mocks.backup.mockResolvedValue({name:'safety.db'});mocks.maintenance.mockImplementation(async(fn:()=>Promise<void>)=>fn());});
const update=(install:()=>Promise<void>):AvailableUpdate=>({version:'next',notes:'',raw:{version:'next',downloadAndInstall:install}});
it('propagates unavailable update checks instead of claiming latest',async()=>{
  mocks.check.mockRejectedValue(new Error('network unavailable'));
  await expect(checkForUpdate()).rejects.toThrow('network unavailable');
  mocks.check.mockResolvedValue(null);await expect(checkForUpdate()).resolves.toBeNull();
});
it('never downloads or restarts when the safety backup fails',async()=>{
  const install=vi.fn();mocks.backup.mockRejectedValue(new Error('disk full'));
  await expect(installUpdate(update(install))).rejects.toThrow('disk full');
  expect(install).not.toHaveBeenCalled();expect(mocks.maintenance).not.toHaveBeenCalled();expect(mocks.relaunch).not.toHaveBeenCalled();
});
it('retains the running app when signature verification or installation fails',async()=>{
  await expect(installUpdate(update(async()=>{throw new Error('invalid signature');}))).rejects.toThrow('invalid signature');
  expect(mocks.backup).toHaveBeenCalledWith('pre-update');expect(mocks.relaunch).not.toHaveBeenCalled();
});
it('backs up and drains storage before install, then restarts after success',async()=>{
  const order:string[]=[];
  mocks.backup.mockImplementation(async()=>{order.push('backup');return {name:'backup'};});
  mocks.maintenance.mockImplementation(async(fn:()=>Promise<void>,freeze:boolean)=>{expect(freeze).toBe(true);order.push('drain');await fn();});
  mocks.relaunch.mockImplementation(async()=>{order.push('relaunch');});
  await installUpdate(update(async()=>{order.push('install');}));expect(order).toEqual(['backup','drain','install','relaunch']);
});
