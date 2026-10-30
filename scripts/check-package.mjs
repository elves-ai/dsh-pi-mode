import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
assert.equal(manifest.name, '@elves-ai/dsh-pi-mode')
assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml')
assert.equal(manifest.engines.dsh, '0.2.2-alpha.2')
for (const hook of ['preinstall', 'install', 'postinstall', 'prepare', 'prepublish', 'prepack', 'postpack']) {
  assert(!(hook in manifest.scripts), `Distribution must not require a ${hook} script`)
}
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const [pack] = JSON.parse(execFileSync(npm, ['pack', '--dry-run', '--json', '--ignore-scripts'], {
  cwd: root, encoding: 'utf8',
}))
const files = new Set(pack.files.map(file => file.path))
for (const path of [
  'package.json', 'cordis.patch.yml', 'dist/index.js', 'dist/index.d.ts', 'dist/config.js',
  'dist/search.js', 'dist/executor.js', 'dist/projection.js', 'locale/en.json', 'locale/zh.json',
  'icon.svg', 'README.md', 'README.zh.md', 'LICENSE', 'NOTICE',
]) assert(files.has(path), `Missing packed file: ${path}`)
for (const path of files) {
  assert(!path.startsWith('node_modules/') && !path.startsWith('tests/') && !path.startsWith('scripts/'), path)
  assert(!path.startsWith('.') && !path.endsWith('.tgz'), path)
}
for (const [name, range] of Object.entries(manifest.peerDependencies)) {
  assert.equal(manifest.peerDependenciesMeta[name]?.optional, true, `${name} must be supplied by DSH`)
  assert(!range.startsWith('workspace:') && !range.startsWith('file:'), `${name} has a local range`)
}
for (const path of files) {
  if (!path.startsWith('dist/') || !path.endsWith('.js')) continue
  const text = await readFile(new URL(`../${path}`, import.meta.url), 'utf8')
  assert(!text.includes('/Users/') && !text.includes('workspace:'), `${path} contains local installation data`)
  for (const match of text.matchAll(/from ['"](@deepseek-ai\/[^/'"]+)(?:\/[^'"]*)?['"]/g)) {
    assert(match[1] in manifest.peerDependencies, `Undeclared Host import: ${match[1]}`)
  }
}
console.info(`Package closure verified: ${files.size} files; ready-to-run JavaScript, no install scripts.`)
