/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   src/services/history.ts — Inverse-op Undo / Redo stack
   ──────────────────────────────────────────────────────
   Every mutation that flows through `taskService` records an
   `HistoryEntry` describing how to invert (`undo`) and re-apply
   (`redo`) itself. This is deliberately the same shape an op-log
   takes — Act 2's CRDT sync spine grows directly out of this seam.

   Invariants:
   • A fresh mutation clears the redo stack (linear history).
   • While an undo/redo is applying, recording is suppressed so the
     inverse work doesn't spawn new history entries (`isApplying`).
   • Stacks are bounded so a long session can't grow unbounded.
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

import { useStore } from '../store';

export interface HistoryEntry {
  /** Human-readable label, surfaced in the undo/redo toast. */
  label: string;
  /** Revert the mutation. */
  undo: () => Promise<void> | void;
  /** Re-apply the mutation. */
  redo: () => Promise<void> | void;
}

const LIMIT = 100;

let undoStack: HistoryEntry[] = [];
let redoStack: HistoryEntry[] = [];
let applying = false;

/** Push the current undo/redo availability into the store for the UI. */
function sync() {
  useStore.getState().setHistoryState(undoStack.length > 0, redoStack.length > 0);
}

/** True while an undo/redo is mid-flight — used to suppress re-recording. */
export function isApplyingHistory(): boolean {
  return applying;
}

/**
 * Record a reversible mutation. No-ops while applying history so that the
 * inverse work performed by undo/redo never lands back on the stack.
 */
export function record(entry: HistoryEntry): void {
  if (applying) return;
  undoStack.push(entry);
  if (undoStack.length > LIMIT) undoStack.shift();
  // A new action invalidates any redo branch.
  redoStack = [];
  sync();
}

/** Undo the most recent mutation. Returns its label (or null if nothing to undo). */
export async function undo(): Promise<string | null> {
  const entry = undoStack.pop();
  if (!entry) return null;
  applying = true;
  try {
    await entry.undo();
    redoStack.push(entry);
  } catch (e) {
    // Failed to invert — put it back so state and stack stay consistent.
    undoStack.push(entry);
    console.error('[history] undo failed:', e);
    throw e;
  } finally {
    applying = false;
    sync();
  }
  return entry.label;
}

/** Redo the most recently undone mutation. Returns its label (or null). */
export async function redo(): Promise<string | null> {
  const entry = redoStack.pop();
  if (!entry) return null;
  applying = true;
  try {
    await entry.redo();
    undoStack.push(entry);
  } catch (e) {
    redoStack.push(entry);
    console.error('[history] redo failed:', e);
    throw e;
  } finally {
    applying = false;
    sync();
  }
  return entry.label;
}

export function canUndo(): boolean {
  return undoStack.length > 0;
}

export function canRedo(): boolean {
  return redoStack.length > 0;
}

/** Wipe both stacks (e.g. on a destructive reload). Exported for tests. */
export function clearHistory(): void {
  undoStack = [];
  redoStack = [];
  applying = false;
  sync();
}
