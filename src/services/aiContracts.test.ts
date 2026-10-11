import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mock = vi.hoisted(()=>({settings:new Map<string,string>(), invoke:vi.fn()}));
vi.mock('../db',()=>({getSetting:async(k:string,fallback='')=>mock.settings.get(k)??fallback}));
vi.mock('../utils/secrets',()=>({getSecret:async()=> 'private-api-key'}));
vi.mock('@tauri-apps/api/core',()=>({invoke:mock.invoke}));
import { estimateScheduling, generateTasks, queryToPredicate, quickAddParseAI, suggestTags } from './aiService';
import { approveAiRequest, cancelAiRequest, getAiRequest, subscribeAiRequest, withAiRequest } from './aiRequests';
import { aiEndpoint, isLocalProvider } from './privateAi';

const tasks=[{id:'a',title:'Private task title',importance:3,effort:2}];
let unsubscribe:()=>void;
beforeEach(()=>{
  vi.stubGlobal('window',{__TAURI_INTERNALS__:{},dispatchEvent:vi.fn()});
  mock.settings.clear(); mock.settings.set('ai_provider','ollama'); mock.invoke.mockReset();
  unsubscribe=subscribeAiRequest(()=>{});
});
afterEach(()=>{unsubscribe();vi.unstubAllGlobals();});
describe('AI advice contracts',()=>{
  it('accepts complete bounded estimates and captures the actual request provenance',async()=>{
    mock.invoke.mockResolvedValue(JSON.stringify([{id:'a',duration_min:45,energy:'hi'}]));
    const result=await estimateScheduling(tasks);
    expect(result[0]).toMatchObject({id:'a',duration_min:45,energy:'hi',provenance:{provider:'ollama',model:'llama3.1',local:true}});
    expect(result[0].provenance.estimated_at).toMatch(/^\d{4}-/);
  });
  it.each([
    [{id:'a',duration_min:'45',energy:'hi'}], [{id:'a',duration_min:31,energy:'hi'}],
    [{id:'a',duration_min:300,energy:'hi'}], [{id:'a',duration_min:45,energy:'HIGH'}],
    [{id:'outside',duration_min:45,energy:'hi'}], [{id:'a',duration_min:45,energy:'hi'},{id:'a',duration_min:30,energy:'med'}],
    {id:'a',duration_min:45,energy:'hi'}, [null], [],
  ].map(raw=>({raw})))('rejects invalid or ambiguous estimates as a whole',async ({raw})=>{
    mock.invoke.mockResolvedValue(JSON.stringify(raw));
    await expect(estimateScheduling(tasks)).rejects.toThrow('invalid advice');
  });
  it('rejects impossible generated dates and coerced task fields',async()=>{
    mock.invoke.mockResolvedValue('[{"title":"Task","description":"","tags":[],"deadline":"2026-02-30","importance":3,"effort":3}]');
    await expect(generateTasks('Project')).rejects.toThrow('invalid advice');
    mock.invoke.mockResolvedValue('["valid",{"secret":"value"}]');
    await expect(suggestTags(tasks[0])).rejects.toThrow('invalid advice');
    mock.invoke.mockResolvedValue('{"done":"false"}');
    await expect(queryToPredicate('open',[])).rejects.toThrow('invalid advice');
  });
  it('keeps deterministic capture when the provider is offline or malformed',async()=>{
    mock.invoke.mockRejectedValue(new Error('offline'));
    await expect(quickAddParseAI('Write report tomorrow')).resolves.toEqual({});
    mock.invoke.mockResolvedValue('{"importance":999}');
    await expect(quickAddParseAI('Write report tomorrow')).resolves.toEqual({});
  });
  it('requires exact-payload remote review before invoking the provider',async()=>{
    mock.settings.set('ai_base_url','https://remote.example/v1');
    mock.invoke.mockResolvedValue('[{"id":"a","duration_min":45,"energy":"hi"}]');
    const request=estimateScheduling(tasks);
    await vi.waitFor(()=>expect(getAiRequest()?.status).toBe('review'));
    expect(getAiRequest()).toMatchObject({local:false,endpoint:'https://remote.example/v1'});
    expect(getAiRequest()?.prompt).toContain('Private task title'); expect(mock.invoke).not.toHaveBeenCalled();
    approveAiRequest(); await request; expect(getAiRequest()).toBeNull();
  });
  it('cancels remote consent and active work without waiting for the provider',async()=>{
    const run=vi.fn(async()=> 'not sent');
    const request=withAiRequest({provider:'custom',model:'model',endpoint:'https://remote.example/v1',system:'instructions',prompt:'private'},run);
    cancelAiRequest(); await expect(request).rejects.toMatchObject({name:'AbortError'}); expect(run).not.toHaveBeenCalled();
    mock.invoke.mockImplementation((command:string)=> command==='ai_cancel' ? Promise.resolve() : new Promise(()=>{}));
    const active=estimateScheduling(tasks);
    await vi.waitFor(()=>expect(mock.invoke).toHaveBeenCalledWith('ai_generate',expect.anything()));
    cancelAiRequest(); await expect(active).rejects.toMatchObject({name:'AbortError'});
    expect(mock.invoke).toHaveBeenCalledWith('ai_cancel',expect.anything()); expect(getAiRequest()).toBeNull();
  });
  it('classifies Anthropic by its actual destination and rejects unsafe overrides',()=>{
    expect(isLocalProvider('anthropic','http://localhost:11434')).toBe(false);
    expect(aiEndpoint('anthropic','http://localhost:11434')).toBe('https://api.anthropic.com/v1/messages');
    for (const url of ['https://host/v1?token=secret','https://host/v1#secret','https://user:pass@host/v1','http://remote.example/v1']) expect(()=>aiEndpoint('custom',url)).toThrow();
  });
});
