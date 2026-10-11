import { measured } from './diagnostics';
import { isLocalProvider } from './privateAi';

export interface AiRequestPreview {
  provider: string; model: string; endpoint: string; system: string; prompt: string;
  local: boolean; status: 'review' | 'running';
}
let current: AiRequestPreview | null = null;
let controller: AbortController | null = null;
let approve: (() => void) | null = null;
const listeners = new Set<() => void>();
const publish = () => listeners.forEach(fn => fn());
export const getAiRequest = () => current;
export function subscribeAiRequest(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn); }; }
export function approveAiRequest() { approve?.(); }
export function cancelAiRequest() { controller?.abort(); }
export const cancelledAi = () => new DOMException('AI request cancelled. Your existing plan is preserved.', 'AbortError');
export function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const cancel = () => reject(cancelledAi());
    if (signal.aborted) { promise.catch(() => {}); cancel(); return; }
    signal.addEventListener('abort', cancel, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', cancel));
  });
}
/** Every remote request requires review of the exact payload and destination. */
export async function withAiRequest<T>(preview: Omit<AiRequestPreview, 'local' | 'status'>, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  if (current) throw new Error('Another AI request is active. Finish or cancel it first.');
  if (!listeners.size) throw new Error('AI request review is unavailable. Retry after opening Cognate.');
  const local = isLocalProvider(preview.provider, preview.endpoint);
  const active = new AbortController(); controller = active;
  current = { ...preview, local, status: local ? 'running' : 'review' };
  try {
    if (!local) {
      const consent = new Promise<void>(resolve => { approve = resolve; });
      publish(); await abortable(consent, active.signal); approve = null;
    }
    current = { ...preview, local, status: 'running' }; publish();
    return await measured('ai', () => abortable(run(active.signal), active.signal));
  } finally { current = null; controller = null; approve = null; publish(); }
}
