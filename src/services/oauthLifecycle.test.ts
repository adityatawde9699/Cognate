import {beforeEach,describe,it,expect,vi} from 'vitest';
const mocks=vi.hoisted(()=>({secrets:new Map<string,string>(),settings:new Map<string,string>(),invoke:vi.fn(),replace:vi.fn(),clear:vi.fn()}));
vi.mock('../db',()=>({IS_TAURI:true,getSetting:async(key:string,fallback:string)=>mocks.settings.get(key) ?? fallback,setSetting:async(key:string,value:string)=>{mocks.settings.set(key,value);},replaceCalendarSource:mocks.replace,clearCalendarSource:mocks.clear}));
vi.mock('../utils/secrets',()=>({getSecret:async(key:string)=>mocks.secrets.get(key) ?? '',setSecret:async(key:string,value:string)=>{mocks.secrets.set(key,value);}}));
vi.mock('@tauri-apps/api/core',()=>({invoke:mocks.invoke}));
import {beginConnect,completeConnect,cancelConnect,disconnectCalendar,syncFreeBusy,REDIRECT_URI} from './oauthCalendarService';
const tokens=()=>({provider:'google',clientId:'client',access:'old-token',refresh:'refresh',expiresAt:Date.now()-1000});
beforeEach(()=>{mocks.secrets.clear();mocks.settings.clear();mocks.invoke.mockReset();mocks.replace.mockReset();mocks.clear.mockReset();mocks.invoke.mockImplementation(async(command:string)=>command==='oauth_token'?JSON.stringify({access_token:'new-token',refresh_token:'refresh',expires_in:3600}):command==='oauth_api'?JSON.stringify({calendars:{primary:{busy:[{start:'2026-10-06T09:00:00Z',end:'2026-10-06T10:00:00Z'}]}}}):8788);});
describe('calendar OAuth lifecycle',()=>{
  it('binds a loopback listener, exchanges one verified callback and rejects replay',async()=>{
    const auth=new URL(await beginConnect('google','client'));
    expect(mocks.invoke).toHaveBeenCalledWith('start_oauth',{state:auth.searchParams.get('state')});
    const callback=`${REDIRECT_URI}?state=${auth.searchParams.get('state')}&code=approved`;
    await completeConnect(callback);expect(mocks.secrets.get('cal_oauth_pending')).toBe('');
    await expect(completeConnect(callback)).rejects.toThrow('No sign-in');
    expect(mocks.invoke.mock.calls.filter(call=>call[0]==='oauth_token')).toHaveLength(1);
  });
  it('does not exchange a mismatched callback and supports cancellation',async()=>{
    await beginConnect('google','client');
    await expect(completeConnect(`${REDIRECT_URI}?state=wrong&code=x`)).rejects.toThrow('state');
    expect(mocks.invoke.mock.calls.some(call=>call[0]==='oauth_token')).toBe(false);
    await cancelConnect();expect(mocks.secrets.get('cal_oauth_pending')).toBe('');
  });
  it('refreshes once for concurrent callers and preserves availability on provider failure',async()=>{
    mocks.secrets.set('cal_oauth_tokens',JSON.stringify(tokens()));
    await Promise.all([syncFreeBusy(),syncFreeBusy()]);
    expect(mocks.invoke.mock.calls.filter(call=>call[0]==='oauth_token')).toHaveLength(1);
    const committed=mocks.replace.mock.calls.length;
    mocks.invoke.mockImplementation(async(command:string)=>{if(command==='oauth_api')throw new Error('Provider unavailable');return '{}';});
    await expect(syncFreeBusy()).rejects.toThrow('Provider unavailable');expect(mocks.replace.mock.calls).toHaveLength(committed);
  });
  it('cannot resurrect tokens after disconnect during refresh',async()=>{
    mocks.secrets.set('cal_oauth_tokens',JSON.stringify(tokens()));
    let finish:(value:string)=>void=()=>{};
    const pending=new Promise<string>(resolve=>{finish=resolve;});
    mocks.invoke.mockImplementation(async(command:string)=>command==='oauth_token'?pending:undefined);
    const sync=syncFreeBusy();await vi.waitFor(()=>expect(mocks.invoke).toHaveBeenCalledWith('oauth_token',expect.anything()));
    await disconnectCalendar();finish(JSON.stringify({access_token:'late',expires_in:3600}));
    await expect(sync).rejects.toThrow('connection changed');expect(mocks.secrets.get('cal_oauth_tokens')).toBe('');expect(mocks.replace).not.toHaveBeenCalled();
  });
  it('follows Microsoft pagination but rejects off-provider next links before committing',async()=>{
    mocks.secrets.set('cal_oauth_tokens',JSON.stringify({...tokens(),provider:'microsoft',expiresAt:Date.now()+3600000}));
    let page=0;
    mocks.invoke.mockImplementation(async(command:string)=>{
      if(command!=='oauth_api')return undefined;
      page++;return JSON.stringify({value:[{start:{dateTime:`2026-10-06T${page===1?'09':'11'}:00:00`},end:{dateTime:`2026-10-06T${page===1?'10':'12'}:00:00`},showAs:'busy'}],...(page===1?{'@odata.nextLink':'https://graph.microsoft.com/v1.0/me/calendarView?$skip=200'}:{})});
    });
    expect(await syncFreeBusy()).toBe(2);expect(mocks.replace.mock.calls[0][1]).toHaveLength(2);
    mocks.invoke.mockResolvedValue(JSON.stringify({value:[],'@odata.nextLink':'https://evil.example/steal-token'}));
    await expect(syncFreeBusy()).rejects.toThrow('pagination URL');expect(mocks.replace).toHaveBeenCalledTimes(1);
  });
});
