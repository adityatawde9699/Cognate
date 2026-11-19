import { describe, expect, it } from 'vitest';
import { describeHardware, formatBytes } from './localLlm';
import { aiEndpoint, isLocalProvider } from './privateAi';

const hw = (over: Partial<Parameters<typeof describeHardware>[0] & object> = {}) =>
  ({ backend: 'cpu', device: null, vramMb: null, engine: true, gpu: false, ...over });

describe('built-in model hardware summary', () => {
  it('says CPU when no GPU is usable', () => {
    expect(describeHardware(hw())).toBe('No compatible GPU found, so it runs on your CPU.');
  });
  it('names the GPU and its memory when one is usable', () => {
    expect(describeHardware(hw({ backend: 'cuda', device: 'NVIDIA GeForce RTX 5050 Laptop GPU', vramMb: 7707, gpu: true })))
      .toBe('Runs on your GPU (NVIDIA GeForce RTX 5050 Laptop GPU, 8 GB).');
  });
  it('handles browser builds and builds without the engine', () => {
    expect(describeHardware(null)).toMatch(/desktop app/);
    expect(describeHardware(hw({ engine: false }))).toMatch(/does not include/);
  });
  it('formats download sizes', () => {
    expect(formatBytes(491_400_032)).toBe('491 MB');
    expect(formatBytes(2_019_377_696)).toBe('2.0 GB');
  });
});

describe('embedded provider', () => {
  it('is local and has no endpoint, so it never triggers remote-send consent', () => {
    expect(isLocalProvider('embedded', '')).toBe(true);
    expect(aiEndpoint('embedded', '')).toBe('');
  });
  it('ignores a stale base URL', () => {
    expect(isLocalProvider('embedded', 'https://example.com')).toBe(true);
  });
});
