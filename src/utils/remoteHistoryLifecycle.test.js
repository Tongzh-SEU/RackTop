// @vitest-environment node
import { afterEach, expect, test } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync, spawn } from 'node:child_process'
import { once } from 'node:events'
const script = readFileSync('src-tauri/assets/remote-history-lifecycle.sh', 'utf8')
const roots = []
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })))
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'racktop-lifecycle-')); roots.push(root)
  const bin = join(root, 'bin'); mkdirSync(bin)
  // Real kernel locks on inherited file descriptions; macOS lacks flock CLI.
  if (process.platform === 'darwin') writeFileSync(join(bin, 'flock'), ['#!/usr/bin/python3', 'import fcntl, sys', 'fcntl.flock(int(sys.argv[-1]), fcntl.LOCK_EX)', ''].join(String.fromCharCode(10)), { mode: 0o700 })
  const env = { ...process.env, HOME: root, PATH: bin + ':' + process.env.PATH, RACKTOP_HISTORY_ENDPOINT: 'endpoint', RACKTOP_HISTORY_CLIENT: 'aa' }
  const run = (action, client = 'aa') => spawnSync('sh', ['-c', script], { env: { ...env, RACKTOP_HISTORY_ACTION: action, RACKTOP_HISTORY_CLIENT: client }, encoding: 'utf8', timeout: 15000 })
  return { root, env, run, data: join(root, '.racktop/remote-history-store/endpoint'), legacy: join(root, '.racktop/remote-history/endpoint') }
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
test.skipIf(process.platform === 'win32')('a recreated old directory preserves both copies and rejects deletion', () => {
  const f = fixture(); expect(f.run('register').status).toBe(0)
  writeFileSync(join(f.data, '.history-v1.tsv'), 'new')
  unlinkSync(f.legacy); mkdirSync(f.legacy); writeFileSync(join(f.legacy, '.history-v1.tsv'), 'old')
  expect(f.run('remove').status).toBe(42)
  expect(readFileSync(join(f.data, '.history-v1.tsv'), 'utf8')).toBe('new')
  expect(readFileSync(join(f.legacy, '.history-v1.tsv'), 'utf8')).toBe('old')
  expect(existsSync(join(f.data, 'instances/aa'))).toBe(true)
})
