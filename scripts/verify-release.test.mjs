import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const script = fileURLToPath(new URL('./verify-release.mjs', import.meta.url));
for (const newline of ['\n', '\r\n']) {
  test(`release metadata accepts ${newline === '\n' ? 'LF' : 'CRLF'} and rejects mismatched tags`, () => {
    const root = mkdtempSync(join(tmpdir(), 'cognate-release-'));
    try {
      mkdirSync(join(root, 'src-tauri'));
      mkdirSync(join(root, 'releases'));
      const version = '3.1.0-rc.4';
      writeFileSync(join(root, 'package.json'), JSON.stringify({ version }));
      writeFileSync(join(root, 'package-lock.json'), JSON.stringify({ version, packages: { '': { version } } }));
      writeFileSync(join(root, 'src-tauri/tauri.conf.json'), JSON.stringify({ version, bundle: { windows: { wix: { version: '3.1.0.4' } } } }));
      writeFileSync(join(root, 'src-tauri/Cargo.toml'), `[package]${newline}version = "${version}"${newline}`);
      writeFileSync(join(root, 'src-tauri/Cargo.lock'), `[[package]]${newline}name = "cognate"${newline}version = "${version}"${newline}`);
      writeFileSync(join(root, `releases/${version}.md`), `# Cognate v${version}${newline}`);
      const env = { ...process.env, GITHUB_REF_TYPE: 'tag', GITHUB_REF_NAME: `v${version}`, GITHUB_OUTPUT: join(root, 'output') };
      delete env.NODE_TEST_CONTEXT;
      const valid = spawnSync(process.execPath, [script], { cwd: root, env, encoding: 'utf8' });
      assert.equal(valid.status, 0, valid.stderr);
      const invalid = spawnSync(process.execPath, [script], { cwd: root, env: { ...env, GITHUB_REF_NAME: 'v0.0.0' }, encoding: 'utf8' });
      assert.notEqual(invalid.status, 0);
      assert.match(invalid.stderr, /Release tag version mismatch/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}
