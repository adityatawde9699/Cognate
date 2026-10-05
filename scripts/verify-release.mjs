import { readFileSync, appendFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const json = path => JSON.parse(readFileSync(path, 'utf8'));
const version = json('package.json').version;
const lock = json('package-lock.json');
assert.equal(lock.version, version, 'npm lock version mismatch');
assert.equal(lock.packages[''].version, version, 'npm root package version mismatch');
const tauri = json('src-tauri/tauri.conf.json');
assert.equal(tauri.version, version, 'Tauri version mismatch');
const wix = tauri.bundle?.windows?.wix?.version;
if (version.includes('-') && !/^\d+$/.test(version.split('-')[1])) {
  assert.ok(wix, 'Named prereleases require a numeric MSI version override');
}
if (wix) {
  assert.match(wix, /^\d+\.\d+\.\d+(?:\.\d+)?$/, 'MSI version must be numeric');
  assert.equal(wix.split('.').slice(0, 3).join('.'), version.split('-')[0].split('+')[0], 'MSI base version mismatch');
}
const cargo = readFileSync('src-tauri/Cargo.toml', 'utf8');
assert.equal(cargo.match(/^version = "([^"]+)"/m)?.[1], version, 'Cargo version mismatch');
const cargoLock = readFileSync('src-tauri/Cargo.lock', 'utf8');
assert.equal(cargoLock.match(/name = "cognate"\r?\nversion = "([^"]+)"/)?.[1], version, 'Cargo lock version mismatch');
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
