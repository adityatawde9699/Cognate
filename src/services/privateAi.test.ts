import { describe, it, expect } from 'vitest';
import { privateAiPreset, isLocalProvider, OLLAMA_BASE, DEFAULT_LOCAL_MODEL } from './privateAi';

describe('privateAi', () => {
  it('the preset points at a local Ollama model', () => {
    const p = privateAiPreset();
    expect(p).toEqual({ provider: 'ollama', baseUrl: OLLAMA_BASE, model: DEFAULT_LOCAL_MODEL });
    expect(privateAiPreset('mistral').model).toBe('mistral');
  });

  it('recognizes on-device providers and loopback base URLs', () => {
    expect(isLocalProvider('ollama', '')).toBe(true);
    expect(isLocalProvider('llamacpp', '')).toBe(true);
    expect(isLocalProvider('custom', 'http://localhost:8080/v1')).toBe(true);
    expect(isLocalProvider('custom', 'http://127.0.0.1:1234/v1')).toBe(true);
  });

  it('flags cloud providers as not private', () => {
    expect(isLocalProvider('anthropic', '')).toBe(false);
    expect(isLocalProvider('openai', 'https://api.openai.com/v1')).toBe(false);
  });
});
