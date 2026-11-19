/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   src/services/localLlm.ts — built-in llama.cpp model (desktop only)
   ──────────────────────────────────────────────────────
   Thin wrappers over the Rust commands that download and run a GGUF model
   inside the app. Inference itself goes through the normal `ai_generate`
   path with provider "embedded", so nothing leaves the device.
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

export const EMBEDDED_PROVIDER = 'embedded';
export const DEFAULT_EMBEDDED_MODEL = 'qwen2.5-1.5b';

export interface Hardware {
  backend: string;       // "cuda" | "metal" | "vulkan" | "cpu"
  device: string | null; // GPU name when one is usable
  vramMb: number | null;
  engine: boolean;       // this build includes the engine
  gpu: boolean;          // layers will be offloaded to the GPU
}
export interface BuiltInModel {
  id: string; label: string; blurb: string; sizeBytes: number; installed: boolean; downloading: boolean;
}
export interface LocalLlmStatus { hardware: Hardware; models: BuiltInModel[] }
export interface DownloadProgress {
  id: string; received: number; total: number;
  phase: 'downloading' | 'verifying' | 'done' | 'error' | 'cancelled';
  error?: string | null;
}

const isDesktop = () => typeof window !== 'undefined' && Boolean((window as any).__TAURI_INTERNALS__);

export async function getLocalLlmStatus(): Promise<LocalLlmStatus | null> {
  if (!isDesktop()) return null;
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<LocalLlmStatus>('local_llm_status');
}
export async function downloadBuiltInModel(id: string): Promise<void> {
  const { invoke } = await import('@tauri-apps/api/core');
  await invoke('local_llm_download', { id });
}
export async function cancelBuiltInDownload(id: string): Promise<void> {
  const { invoke } = await import('@tauri-apps/api/core');
  await invoke('local_llm_cancel_download', { id });
}
export async function deleteBuiltInModel(id: string): Promise<void> {
  const { invoke } = await import('@tauri-apps/api/core');
  await invoke('local_llm_delete', { id });
}
/** Subscribe to download progress. Returns an unsubscribe function. */
export async function onDownloadProgress(cb: (p: DownloadProgress) => void): Promise<() => void> {
  if (!isDesktop()) return () => {};
  const { listen } = await import('@tauri-apps/api/event');
  return listen<DownloadProgress>('local-llm-download', (e) => cb(e.payload));
}

export function formatBytes(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`;
  return `${Math.round(n / 1e6)} MB`;
}
/** One line describing where the model will run. Pure. */
export function describeHardware(h: Hardware | null | undefined): string {
  if (!h) return 'Available in the desktop app.';
  if (!h.engine) return 'This build does not include the built-in engine.';
  if (h.gpu) {
    const vram = h.vramMb ? `, ${(h.vramMb / 1024).toFixed(0)} GB` : '';
    return `Runs on your GPU (${h.device ?? h.backend.toUpperCase()}${vram}).`;
  }
  return 'No compatible GPU found, so it runs on your CPU.';
}
