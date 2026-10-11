/** Provider output is untrusted. Reject the entire response before any writes. */
export const invalidAdvice = () => new Error('AI returned invalid advice. Your existing tasks and plan are unchanged.');
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalidAdvice();
  return value as Record<string, unknown>;
}
export function text(value: unknown, max = 4000, empty = false): string {
  if (typeof value !== 'string' || value.length > max || (!empty && !value.trim()) || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) throw invalidAdvice();
  return value.trim();
}
export function integer(value: unknown, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) throw invalidAdvice();
  return value;
}
export function list(value: unknown, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max) throw invalidAdvice();
  return value;
}
export function tags(value: unknown, max: number): string[] {
  const result = list(value, max).map(t => text(t, 64).toLowerCase().replace(/^#/, ''));
  if (result.some(t => !t) || new Set(result).size !== result.length) throw invalidAdvice();
  return result;
}
export function date(value: unknown): string {
  if (value === '') return '';
  const result = text(value, 10);
  const stamp = Date.parse(`${result}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(result) || !Number.isFinite(stamp) || new Date(stamp).toISOString().slice(0, 10) !== result) throw invalidAdvice();
  return result;
}
export function uniqueId(row: Record<string, unknown>, allowed: Set<string>, seen: Set<string>): string {
  const id = text(row.id, 512);
  if (!allowed.has(id) || seen.has(id)) throw invalidAdvice();
  seen.add(id); return id;
}
