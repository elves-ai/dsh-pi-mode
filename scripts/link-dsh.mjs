import { globSync } from 'node:fs'
import { lstat, mkdir, readFile, realpath, symlink, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const project = fileURLToPath(new URL('..', import.meta.url))
const input = process.argv[2] ?? process.env.DSH_SOURCE
if (!input) throw new Error('Usage: npm run dev:link -- /path/to/built/deepseek-harness')
const root = await realpath(resolve(input))
const cli = JSON.parse(await readFile(join(root, 'apps/cli/package.json'), 'utf8'))
const manifest = JSON.parse(await readFile(join(project, 'package.json'), 'utf8'))
if (cli.name !== '@deepseek-ai/dsh' || cli.version !== manifest.engines.dsh) {
  throw new Error(`Expected a built DSH ${manifest.engines.dsh} checkout; found ${cli.name}@${cli.version}`)
}
await lstat(join(root, 'apps/cli/lib/bin.js'))
let linked = 0
for (const relative of globSync([
  'packages/*/*/package.json', 'vendor/*/package.json', 'apps/*/package.json', 'native/system/package.json',
], { cwd: root })) {
  const path = join(root, relative)
  const pkg = JSON.parse(await readFile(path, 'utf8'))
  if (typeof pkg.name !== 'string' || !pkg.name.startsWith('@deepseek-ai/')) continue
  const source = dirname(path)
  const target = join(project, 'node_modules', pkg.name)
  await mkdir(dirname(target), { recursive: true })
  try {
    await lstat(target)
    if (await realpath(target) !== await realpath(source)) {
      throw new Error(`${target} already exists and does not point to this DSH checkout; use a clean dependency install`)
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    await symlink(source, target, process.platform === 'win32' ? 'junction' : 'dir')
  }
  linked++
}
// Projection schemas must use the Host's Zod version, including for typechecking.
const hostRequire = createRequire(join(root, 'packages/session/session-projection/package.json'))
const hostZod = dirname(hostRequire.resolve('zod/package.json'))
const zodTarget = join(project, 'node_modules/zod')
try {
  await lstat(zodTarget)
  if (await realpath(zodTarget) !== await realpath(hostZod)) {
    throw new Error(`${zodTarget} must be absent or linked to the Host; run npm ci --omit=peer --ignore-scripts first`)
  }
} catch (error) {
  if (error.code !== 'ENOENT') throw error
  await symlink(hostZod, zodTarget, process.platform === 'win32' ? 'junction' : 'dir')
}
await writeFile(join(project, '.dsh-dev.json'), JSON.stringify({ root, version: cli.version }, null, 2) + '\n')
console.info(`Linked ${linked} Host packages from DSH ${cli.version}; no profile files were changed.`)
