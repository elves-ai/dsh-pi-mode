import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const run = promisify(execFile)
const project = fileURLToPath(new URL('..', import.meta.url))
const development = JSON.parse(await readFile(join(project, '.dsh-dev.json'), 'utf8'))
const cli = join(development.root, 'apps/cli/lib/bin.js')
const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-pi-smoke-')))
const env = { ...process.env, DSH_TELEMETRY_DISABLED: '1', DSH_AGENTS_HOME: join(root, 'agents') }
for (const key of ['NODE_OPTIONS', 'NODE_PATH', 'TSX_TSCONFIG_PATH', 'DSH_PROFILE', 'DSH_PROFILE_DIR']) delete env[key]
try {
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  const packed = await run(npm, ['pack', '--ignore-scripts', '--json', '--pack-destination', root], { cwd: project, env })
  const tarball = join(root, JSON.parse(packed.stdout)[0].filename)
  for (const [layout, target] of [['packed', tarball], ['linked', project]]) {
    const home = join(root, layout, 'home')
    const workspace = join(root, layout, 'workspace')
    await mkdir(workspace, { recursive: true })
    await writeFile(join(workspace, 'needle.txt'), 'Independent Pi distribution fixture.\n')
    const options = {
      cwd: workspace, env: { ...env, DSH_HOME: home }, timeout: 120000, maxBuffer: 8 * 1024 * 1024,
    }
    const installed = await run(process.execPath, [cli, 'plugin', '--profile', 'headless', 'add', target], options)
    process.stdout.write(installed.stdout)
    const probe = join(home, 'profiles/headless/pi-smoke-probe.mjs')
    await writeFile(probe, await readFile(new URL('./smoke-probe.mjs', import.meta.url), 'utf8'))
    const overlay = join(root, layout, 'smoke.patch.json')
    await writeFile(overlay, JSON.stringify([
      { id: 'headless-startup', disabled: true },
      { id: 'headless-runner', disabled: true },
      { id: 'sandbox-policy', inject: [], config: { mode: 'workspace-write', workspaceRoot: workspace } },
      { id: 'llm-deepseek', disabled: true },
      { insert: [
        { id: 'agent-preset-registry', name: '@deepseek-ai/dsh-agent-preset-registry', config: { default: 'pi-mode' } },
        { id: 'pi-smoke-probe', name: probe },
      ] },
    ], null, 2) + '\n')
    const launched = await run(process.execPath, [cli, '--profile', 'headless', '--patch', overlay], options)
    const record = launched.stdout.split('\n').find(line => line.startsWith('PI_MODE_DISTRIBUTION_SMOKE '))
    assert(record, `${layout}: missing capability evidence\n${launched.stdout}\n${launched.stderr}`)
    console.info(`${layout}: ${record}`)
    const removed = await run(process.execPath, [cli, 'plugin', '--profile', 'headless', 'remove', '@elves-ai/dsh-pi-mode'], options)
    process.stdout.write(removed.stdout)
    const manifest = JSON.parse(await readFile(join(home, 'profiles/headless/package.json'), 'utf8'))
    assert(!manifest.dsh.profile.bundles.includes('@elves-ai/dsh-pi-mode'))
    assert(!manifest.dependencies?.['@elves-ai/dsh-pi-mode'])
    console.info(`${layout}: package installation, four model requests, question answer, discovery, execution, and removal passed`)
  }
} finally {
  const expectedParent = await realpath(tmpdir())
  assert.equal(dirname(root), expectedParent)
  assert(basename(root).startsWith('dsh-pi-smoke-') && resolve(root) === root)
  await rm(root, { recursive: true, force: true })
}
