import { describe, test, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const readme = readFileSync(resolve(root, 'README.md'), 'utf-8');
const contributing = readFileSync(resolve(root, 'CONTRIBUTING.md'), 'utf-8');

describe('README honesty', () => {
  test('does not claim relay cannot read data even if compromised', () => {
    expect(readme).not.toContain('cannot read your data, even if compromised');
    expect(readme).not.toContain("can't read it");
  });

  test('does not use stale version 0.1.0 in examples', () => {
    expect(readme).not.toContain('Cognate_0.1.0');
  });

  test('states that passphrase determines security', () => {
    expect(readme).toContain('passphrase');
    expect(readme).toMatch(/passphrase.*strength|passphrase.*security|passphrase.*secret/i);
  });

  test('performance section cites Node measurements not claims', () => {
    expect(readme).toContain('measured in Node');
    expect(readme).toContain('startup is unmeasured');
  });

  test('does not contain unreferenced Python scripts', () => {
    const files = readdirSync(root);
    expect(files).not.toContain('apply_css_upgrades.py');
    expect(files).not.toContain('refactor_settings.py');
  });
});

describe('CONTRIBUTING.md DCO', () => {
  test('requires DCO sign-off', () => {
    expect(contributing).toContain('Developer Certificate of Origin');
    expect(contributing).toMatch(/git commit -s/);
  });
});
