import { readFileSync, appendFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const json = path => JSON.parse(readFileSync(path, 'utf8'));
const version = json('package.json').version;
const lock = json('package-lock.json');
assert.equal(lock.version, version, 'npm lock version mismatch');
assert.equal(lock.packages[''].version, version, 'npm root package version mismatch');
assert.equal(json('src-tauri/tauri.conf.json').version, version, 'Tauri version mismatch');
const cargo = readFileSync('src-tauri/Cargo.toml', 'utf8');
assert.equal(cargo.match(/^version = "([^"]+)"/m)?.[1], version, 'Cargo version mismatch');
const cargoLock = readFileSync('src-tauri/Cargo.lock', 'utf8');
assert.equal(cargoLock.match(/name = "cognate"\nversion = "([^"]+)"/)?.[1], version, 'Cargo lock version mismatch');
if (process.env.GITHUB_REF_TYPE === 'tag') {
  assert.equal(process.env.GITHUB_REF_NAME, `v${version}`, 'Release tag version mismatch');
}
const notes = readFileSync(`releases/${version}.md`, 'utf8');
assert.ok(notes.includes(`Cognate v${version}`), 'Release notes version mismatch');
if (process.env.GITHUB_OUTPUT) {
  const delimiter = 'COGNATE_RELEASE_NOTES_END';
  assert.ok(!notes.includes(delimiter));
  appendFileSync(process.env.GITHUB_OUTPUT, `prerelease=${version.includes('-')}\nnotes<<${delimiter}\n${notes}\n${delimiter}\n`);
}
console.log(`Release metadata verified: v${version}`);
