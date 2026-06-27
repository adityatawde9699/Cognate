import { describe, it, expect, beforeEach } from 'vitest';
import { record, undo, redo, canUndo, canRedo, clearHistory, isApplyingHistory } from './history';
import { useStore } from '../store';

/** A trivial reversible op over a numeric cell, for exercising the stack. */
function setCell(cell: { v: number }, from: number, to: number, label = 'set') {
  cell.v = to;
  record({
    label,
    undo: () => { cell.v = from; },
    redo: () => { cell.v = to; },
  });
}

describe('history (inverse-op undo/redo stack)', () => {
  beforeEach(() => clearHistory());

  it('starts empty', () => {
    expect(canUndo()).toBe(false);
    expect(canRedo()).toBe(false);
  });

  it('undoes and redoes a single op', async () => {
    const cell = { v: 0 };
    setCell(cell, 0, 5);
    expect(cell.v).toBe(5);
    expect(canUndo()).toBe(true);

    await undo();
    expect(cell.v).toBe(0);
    expect(canUndo()).toBe(false);
    expect(canRedo()).toBe(true);

    await redo();
    expect(cell.v).toBe(5);
    expect(canRedo()).toBe(false);
  });

  it('unwinds multiple ops in LIFO order', async () => {
    const cell = { v: 0 };
    setCell(cell, 0, 1);
    setCell(cell, 1, 2);
    setCell(cell, 2, 3);
    expect(cell.v).toBe(3);

    await undo(); expect(cell.v).toBe(2);
    await undo(); expect(cell.v).toBe(1);
    await undo(); expect(cell.v).toBe(0);
    expect(canUndo()).toBe(false);
  });

  it('clears the redo branch when a new op is recorded', async () => {
    const cell = { v: 0 };
    setCell(cell, 0, 1);
    setCell(cell, 1, 2);
    await undo();            // back to 1, redo available
    expect(canRedo()).toBe(true);

    setCell(cell, 1, 9);     // new action invalidates redo
    expect(canRedo()).toBe(false);
    expect(cell.v).toBe(9);
  });

  it('returns the op label from undo/redo and null when exhausted', async () => {
    const cell = { v: 0 };
    setCell(cell, 0, 1, 'Add task');
    expect(await undo()).toBe('Add task');
    expect(await undo()).toBeNull();
    expect(await redo()).toBe('Add task');
    expect(await redo()).toBeNull();
  });

  it('mirrors availability into the store', async () => {
    const cell = { v: 0 };
    expect(useStore.getState().canUndo).toBe(false);
    setCell(cell, 0, 1);
    expect(useStore.getState().canUndo).toBe(true);
    expect(useStore.getState().canRedo).toBe(false);
    await undo();
    expect(useStore.getState().canUndo).toBe(false);
    expect(useStore.getState().canRedo).toBe(true);
  });

  it('suppresses re-recording while applying an inverse op', async () => {
    let sawApplying = false;
    record({
      label: 'probe',
      undo: () => {
        sawApplying = isApplyingHistory();
        // Attempting to record mid-undo must be ignored.
        record({ label: 'nested', undo: () => {}, redo: () => {} });
      },
      redo: () => {},
    });
    await undo();
    expect(sawApplying).toBe(true);
    // The nested record was suppressed, so redo replays only the original op.
    expect(canRedo()).toBe(true);
    expect(canUndo()).toBe(false);
  });
});
