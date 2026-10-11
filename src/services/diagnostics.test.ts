import { beforeEach, expect, it } from 'vitest';
import { clearDiagnostics, diagnosticReport, measured, recordDiagnostic } from './diagnostics';
beforeEach(clearDiagnostics);
it('never retains personal payloads, identifiers, endpoints or raw errors',async()=>{
  await expect(measured('sync',async()=>{throw new Error('Network failed https://host/room/private-id?token=secret Task: private-title');})).rejects.toThrow();
  const encoded=JSON.stringify(diagnosticReport());
  for (const privateValue of ['https://host','private-id','secret','private-title']) expect(encoded).not.toContain(privateValue);
  expect(diagnosticReport().events[0].outcome).toBe('offline');
});
it('bounds the buffer and normalizes invalid timing values',()=>{
  for(let i=0;i<110;i++) recordDiagnostic('plan','ok',Infinity);
  expect(diagnosticReport().events).toHaveLength(100);
  expect(diagnosticReport().events.every(e=>e.duration_ms===0)).toBe(true);
  recordDiagnostic('unknown' as never,'payload' as never);
  expect(diagnosticReport().events).toHaveLength(100);
});
