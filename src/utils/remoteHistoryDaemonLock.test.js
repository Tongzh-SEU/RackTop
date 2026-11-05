// @vitest-environment node
import { afterEach, expect, test } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync, spawn } from 'node:child_process'
import { once } from 'node:events'

const lockScript = readFileSync('src-tauri/assets/remote-history-daemon-lock.sh', 'utf8')
const roots = []
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })))

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'racktop-daemon-lock-'))
  roots.push(root)
  const bin = join(root, 'bin')
  const lockDir = join(root, 'local-locks')
  mkdirSync(bin)
  mkdirSync(lockDir)
  if (process.platform === 'darwin' || spawnSync('flock', ['--version']).status !== 0) {
    writeFileSync(join(bin, 'flock'), [
      '#!/usr/bin/env python3',
      'import fcntl, sys',
      'flags = fcntl.LOCK_EX | (fcntl.LOCK_NB if "-n" in sys.argv else 0)',
      'try: fcntl.flock(int(sys.argv[-1]), flags)',
      'except BlockingIOError: sys.exit(1)',
      '',
    ].join(String.fromCharCode(10)), { mode: 0o700 })
  }
  const env = { ...process.env, HOME: root, PATH: bin + ':' + process.env.PATH, RACKTOP_HISTORY_ENDPOINT: 'endpoint-a', RACKTOP_HISTORY_CLIENT: 'aa' }
  const acquire = `racktop_acquire_daemon_lock '${lockDir}'`
  return { root, env, acquire }
}

test.skipIf(process.platform === 'win32')('a blocked daemon lock prevents another launch without consulting shared home state', async () => {
  const f = fixture()
  const holder = spawn('sh', ['-c', `${lockScript}\n${f.acquire}\necho lock-held\nsleep 1`], { env: f.env })
  const done = once(holder, 'close')
  const [ready] = await once(holder.stdout, 'data')
  expect(String(ready)).toContain('lock-held')

  const contender = spawnSync('sh', ['-c', `${lockScript}\n${f.acquire}`], { env: f.env, encoding: 'utf8' })
  expect(contender.status).toBe(1)
  expect(contender.stdout).toContain('__RACKTOP_REMOTE_HISTORY_LOCK_BUSY__')
  expect(contender.stderr).toBe('')
  await done
})
