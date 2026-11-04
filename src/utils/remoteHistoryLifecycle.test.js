// @vitest-environment node
import { afterEach, expect, test } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, unlinkSync, symlinkSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync, spawn } from 'node:child_process'
import { once } from 'node:events'
const script = readFileSync('src-tauri/assets/remote-history-lifecycle.sh', 'utf8')
  .replace('# RACKTOP_LEGACY_SNAPSHOT', readFileSync('src-tauri/assets/remote-history-legacy.sh', 'utf8'))
const roots = []
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })))
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'racktop-lifecycle-')); roots.push(root)
  const bin = join(root, 'bin'); mkdirSync(bin)
  // Real kernel locks on inherited file descriptions; macOS lacks flock CLI.
  if (process.platform === 'darwin') writeFileSync(join(bin, 'flock'), ['#!/usr/bin/python3', 'import fcntl, sys', 'fcntl.flock(int(sys.argv[-1]), fcntl.LOCK_EX)', ''].join(String.fromCharCode(10)), { mode: 0o700 })
  const env = { ...process.env, HOME: root, PATH: bin + ':' + process.env.PATH, RACKTOP_HISTORY_ENDPOINT: 'endpoint', RACKTOP_HISTORY_CLIENT: 'aa' }
  const run = (action, client = 'aa') => spawnSync('sh', ['-c', script], { env: { ...env, RACKTOP_HISTORY_ACTION: action, RACKTOP_HISTORY_CLIENT: client }, encoding: 'utf8', timeout: 15000 })
  return { root, env, run, data: join(root, '.racktop-managed/remote-history-store/endpoint'), legacy: join(root, '.racktop/remote-history/endpoint') }
}
test.skipIf(process.platform === 'win32')('offline and disabled clients retain data until last explicit removal', () => {
  const f = fixture()
  expect(f.run('register').status).toBe(0)
  expect(f.run('register', 'bb').status).toBe(0)
  writeFileSync(join(f.data, '.history-v1.tsv'), 'history')
  expect(f.run('disable', 'bb').status).toBe(0)
  expect(existsSync(join(f.data, 'instances/bb'))).toBe(true)
  expect(f.run('remove').status).toBe(0)
  expect(readFileSync(join(f.legacy, '.history-v1.tsv'), 'utf8')).toBe('history')
  expect(f.run('remove', 'bb').status).toBe(0)
  expect(existsSync(f.data)).toBe(false)
  expect(existsSync(f.legacy)).toBe(false)
  expect(f.run('remove', 'bb').status).toBe(0)
})
test.skipIf(process.platform === 'win32')('registration and last deletion serialize under the same kernel lock', async () => {
  const f = fixture(); expect(f.run('register').status).toBe(0)
  writeFileSync(join(f.data, '.history-v1.tsv'), 'shared')
  const child = spawn('sh', ['-c', script + String.fromCharCode(10) + 'echo ready; sleep 1'], { env: { ...f.env, RACKTOP_HISTORY_ACTION: 'register', RACKTOP_HISTORY_CLIENT: 'bb' } })
  const done = once(child, 'close')
  await once(child.stdout, 'data')
  expect(f.run('remove').status).toBe(0)
  await done
  expect(readFileSync(join(f.data, '.history-v1.tsv'), 'utf8')).toBe('shared')
  expect(existsSync(join(f.data, 'instances/bb'))).toBe(true)
})
test.skipIf(process.platform === 'win32')('legacy history survives removal of compatibility link and all new clients', () => {
  const f = fixture(); mkdirSync(f.legacy, { recursive: true })
  writeFileSync(join(f.legacy, '.history-v1.tsv'), 'old history')
  expect(f.run('register').status).toBe(0)
  unlinkSync(f.legacy)
  expect(readFileSync(join(f.data, '.history-v1.tsv'), 'utf8')).toBe('old history')
  expect(f.run('register').status).toBe(0)
  expect(readFileSync(join(f.legacy, '.history-v1.tsv'), 'utf8')).toBe('old history')
  expect(f.run('remove').status).toBe(0)
  expect(existsSync(f.data)).toBe(true)
})
test.skipIf(process.platform === 'win32')('a recreated old directory preserves both writers without blocking new lifecycle', () => {
  const f = fixture(); expect(f.run('register').status).toBe(0)
  writeFileSync(join(f.data, '.history-v1.tsv'), 'new')
  unlinkSync(f.legacy); mkdirSync(f.legacy); writeFileSync(join(f.legacy, '.history-v1.tsv'), 'old')
  expect(f.run('register', 'bb').status).toBe(0)
  expect(f.run('remove').status).toBe(0)
  expect(readFileSync(join(f.data, '.history-v1.tsv'), 'utf8')).toBe('new')
  expect(readFileSync(join(f.legacy, '.history-v1.tsv'), 'utf8')).toBe('old')
  expect(existsSync(join(f.data, 'instances/aa'))).toBe(false)
  expect(existsSync(join(f.data, 'instances/bb'))).toBe(true)
  expect(readFileSync(join(f.data, 'legacy-endpoint/.history-v1.tsv'), 'utf8')).toBe('old\n')
})

test.skipIf(process.platform === 'win32')('published old whole-directory removal cannot delete the managed store', () => {
  const f = fixture(); expect(f.run('register').status).toBe(0)
  expect(f.run('register', 'bb').status).toBe(0)
  writeFileSync(join(f.data, '.history-v1.tsv'), 'shared history')
  expect(spawnSync('sh', ['-c', 'rm -rf -- "$HOME/.racktop"'], { env: f.env }).status).toBe(0)
  expect(readFileSync(join(f.data, '.history-v1.tsv'), 'utf8')).toBe('shared history')
  expect(existsSync(join(f.data, 'instances/bb'))).toBe(true)
  expect(f.run('remove').status).toBe(0)
  expect(readFileSync(join(f.data, '.history-v1.tsv'), 'utf8')).toBe('shared history')
  expect(f.run('remove', 'bb').status).toBe(0)
  expect(existsSync(f.data)).toBe(false)
})

test.skipIf(process.platform === 'win32')('root history is archived outside old cleanup scope before removing an association', () => {
  const f = fixture(); mkdirSync(join(f.root, '.racktop'))
  writeFileSync(join(f.root, '.racktop/.history-v1.tsv'), 'root history')
  writeFileSync(join(f.root, '.racktop/.usage-v1.tsv'), 'root usage')
  expect(f.run('register').status).toBe(0)
  rmSync(join(f.root, '.racktop'), { recursive: true })
  expect(f.run('remove').status).toBe(0)
  expect(readFileSync(join(f.data, 'legacy-root/.history-v1.tsv'), 'utf8')).toBe('root history\n')
  expect(readFileSync(join(f.data, 'legacy-root/.usage-v1.tsv'), 'utf8')).toBe('root usage\n')
})

test.skipIf(process.platform === 'win32')('previous development layout retains client IDs and compatibility paths during migration', () => {
  const f = fixture(); const old = join(f.root, '.racktop/remote-history-store/endpoint')
  mkdirSync(join(old, 'instances/aa'), { recursive: true })
  writeFileSync(join(old, '.history-v1.tsv'), 'before upgrade')
  mkdirSync(join(f.root, '.racktop/remote-history'), { recursive: true })
  symlinkSync(old, f.legacy)
  expect(f.run('register', 'bb').status).toBe(0)
  expect(realpathSync(old)).toBe(realpathSync(f.data))
  expect(realpathSync(f.legacy)).toBe(realpathSync(f.data))
  expect(existsSync(join(f.data, 'instances/aa'))).toBe(true)
  expect(existsSync(join(f.data, 'instances/bb'))).toBe(true)
  expect(readFileSync(join(f.data, '.history-v1.tsv'), 'utf8')).toBe('before upgrade')
  expect(f.run('register', 'cc').status).toBe(0)
})

test.skipIf(process.platform === 'win32')('coexisting previous stores are archived without replacing either live writer', () => {
  const f = fixture(); expect(f.run('register').status).toBe(0)
  const old = join(f.root, '.racktop/remote-history-store/endpoint')
  mkdirSync(old, { recursive: true })
  writeFileSync(join(old, '.history-v1.tsv'), 'previous history')
  expect(f.run('register', 'bb').status).toBe(0)
  expect(readFileSync(join(old, '.history-v1.tsv'), 'utf8')).toBe('previous history')
  expect(readFileSync(join(f.data, 'legacy-store/.history-v1.tsv'), 'utf8')).toBe('previous history\n')
  expect(f.run('remove').status).toBe(0)
  expect(existsSync(join(f.data, 'instances/bb'))).toBe(true)
})

test.skipIf(process.platform === 'win32')('snapshots wait for the v1.25.6 directory lock before reading an appended row', async () => {
  const f = fixture()
  const writer = spawn('sh', ['-c', `
    mkdir -p "$HOME/.racktop/.collect.lock"
    trap 'rmdir "$HOME/.racktop/.collect.lock"' EXIT
    printf 'v1|3600|10|' > "$HOME/.racktop/.history-v1.tsv"
    echo ready
    sleep 0.5
    printf '20|0|GPU-a,25,40\\n' >> "$HOME/.racktop/.history-v1.tsv"
    printf 'v1|3600|GPU-a|alice|60|100|60\\n' > "$HOME/.racktop/.usage-v1.tsv"
  `], { env: f.env })
  const done = once(writer, 'close')
  await once(writer.stdout, 'data')
  const result = f.run('register')
  expect(result.status, result.stderr).toBe(0)
  await done
  expect(readFileSync(join(f.data, 'legacy-root/.history-v1.tsv'), 'utf8')).toBe('v1|3600|10|20|0|GPU-a,25,40\n')
  expect(readFileSync(join(f.data, 'legacy-root/.usage-v1.tsv'), 'utf8')).toBe('v1|3600|GPU-a|alice|60|100|60\n')
  expect(existsSync(join(f.root, '.racktop/.collect.lock'))).toBe(false)
})

test.skipIf(process.platform === 'win32')('snapshots also wait for later releases usage file lock and release their own directory lock', async () => {
  const f = fixture()
  const writer = spawn('sh', ['-c', `
    mkdir -p "$HOME/.racktop"
    exec 9>"$HOME/.racktop/.usage.lock"
    flock -w 10 9
    printf 'v1|3600|10|' > "$HOME/.racktop/.history-v1.tsv"
    echo ready
    sleep 0.5
    printf '20|0|GPU-a,25,40\\n' >> "$HOME/.racktop/.history-v1.tsv"
  `], { env: f.env })
  const done = once(writer, 'close')
  await once(writer.stdout, 'data')
  const result = f.run('register')
  expect(result.status, result.stderr).toBe(0)
  await done
  expect(readFileSync(join(f.data, 'legacy-root/.history-v1.tsv'), 'utf8')).toBe('v1|3600|10|20|0|GPU-a,25,40\n')
  expect(existsSync(join(f.root, '.racktop/.collect.lock'))).toBe(false)
})
