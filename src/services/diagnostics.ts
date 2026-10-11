/** Session-only, bounded and allowlisted. Never retain error text or payloads. */
export type DiagnosticArea = 'plan' | 'sync' | 'ai' | 'update' | 'notification' | 'storage';
export type FailureCode = 'cancelled' | 'offline' | 'storage' | 'validation' | 'permission' | 'unknown';
interface Diagnostic { area: DiagnosticArea; outcome: 'ok' | FailureCode; duration_ms: number; at: string }
const events: Diagnostic[] = [];
export function failureCode(error: unknown): FailureCode {
  const message = error instanceof Error ? error.message : String(error);
  if (/cancel|abort/i.test(message)) return 'cancelled';
  if (/quota|sqlite|database|disk|storage/i.test(message)) return 'storage';
  if (/network|offline|unreachable|fetch|timed? ?out|HTTP 5/i.test(message)) return 'offline';
  if (/invalid|malformed|signature|decrypt|changed|collision|truncat|refused/i.test(message)) return 'validation';
  if (/permission|denied|keychain|secure storage|HTTP 40[13]/i.test(message)) return 'permission';
  return 'unknown';
}
export function recordDiagnostic(area: DiagnosticArea, outcome: Diagnostic['outcome'], duration = 0) {
  if (!['plan','sync','ai','update','notification','storage'].includes(area) || !['ok','cancelled','offline','storage','validation','permission','unknown'].includes(outcome)) return;
  events.push({ area, outcome, duration_ms: Number.isFinite(duration) ? Math.max(0, Math.round(duration)) : 0, at: new Date().toISOString() });
  if (events.length > 100) events.splice(0, events.length - 100);
  if (typeof window !== 'undefined') window.dispatchEvent(new Event('diagnostics-changed'));
}
export async function measured<T>(area: DiagnosticArea, run: () => Promise<T>): Promise<T> {
  const start = performance.now();
  try { const result = await run(); recordDiagnostic(area, 'ok', performance.now() - start); return result; }
  catch (error) { recordDiagnostic(area, failureCode(error), performance.now() - start); throw error; }
}
export function diagnosticReport() {
  return { format: 'cognate-diagnostics', version: 1, captured_at: new Date().toISOString(), events: events.map(event => ({ ...event })) };
}
export function clearDiagnostics() { events.length = 0; if (typeof window !== 'undefined') window.dispatchEvent(new Event('diagnostics-changed')); }
