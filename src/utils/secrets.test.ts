import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({invoke:vi.fn(),get:vi.fn(),set:vi.fn()}));
vi.mock('../db',()=>({IS_TAURI:true,getSetting:mocks.get,setSetting:mocks.set}));
vi.mock('@tauri-apps/api/core',()=>({invoke:mocks.invoke}));
import {getSecret,setSecret,migrateSecrets} from './secrets';
beforeEach(()=>vi.resetAllMocks());
describe('desktop secret storage',()=>{
  it('never reads or writes plaintext when the keychain is locked',async()=>{
    mocks.invoke.mockRejectedValue(new Error('locked'));
    await expect(getSecret('crdt_signing_key')).rejects.toThrow('Secure storage');
    await expect(setSecret('ai_api_key','secret')).rejects.toThrow('not saved');
    expect(mocks.get).not.toHaveBeenCalled();expect(mocks.set).not.toHaveBeenCalled();
  });
  it('returns empty only for a confirmed missing credential',async()=>{
    mocks.invoke.mockResolvedValue(null);
    expect(await getSecret('ai_api_key')).toBe('');
  });
  it('retains the legacy secret when secure migration fails verification',async()=>{
    mocks.get.mockImplementation((key:string)=>Promise.resolve(key==='ai_api_key' ? 'legacy-secret' : ''));
    mocks.invoke.mockImplementation((command:string)=>Promise.resolve(command==='secret_get' ? null : undefined));
    await migrateSecrets();
    expect(mocks.set).not.toHaveBeenCalled();
  });
});
