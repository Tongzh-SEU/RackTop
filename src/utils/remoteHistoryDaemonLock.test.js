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
  writeFileSync(join(bin, 'ps'), '#!/bin/sh\nprintf "%s\\n" "${RACKTOP_TEST_PS_OUTPUT:-}"\n', { mode: 0o700 })
  const env = { ...process.env, HOME: root, PATH: bin + ':' + process.env.PATH, RACKTOP_HISTORY_ENDPOINT: 'endpoint-a', RACKTOP_HISTORY_CLIENT: 'aa', RACKTOP_DAEMON_LOCK_DIR: lockDir }
  const acquire = `racktop_acquire_daemon_lock '${lockDir}'`
  const reportBusy = `if racktop_acquire_daemon_lock; then exit 10; else lock_status=$?; if [ "$lock_status" -eq 1 ]; then racktop_report_busy_daemon_status "$1" "" ""; else exit "$lock_status"; fi; fi`
  return { root, env, acquire, reportBusy }
}

test.skipIf(process.platform === 'win32')('a held lock reports startup when daemon is absent and ready only when it exists', async () => {
  const f = fixture()
  const holder = spawn('sh', ['-c', `${lockScript}\n${f.acquire}\necho lock-held\nsleep 1`], { env: f.env })
  const done = once(holder, 'close')
  const [ready] = await once(holder.stdout, 'data')
  expect(String(ready)).toContain('lock-held')

  const contender = spawnSync('sh', ['-c', `${lockScript}\n${f.reportBusy}`, 'sh', join(f.root, '.daemon.sh')], {
    env: { ...f.env, RACKTOP_DAEMON_START_WAIT_SECONDS: '1' },
    encoding: 'utf8',
  })
  expect(contender.status, `${contender.stdout}\n${contender.stderr}`).toBe(0)
  expect(contender.stdout).toContain('__RACKTOP_REMOTE_HISTORY_STARTING__')
  expect(contender.stdout).not.toContain('__RACKTOP_REMOTE_HISTORY_READY__')
  await done
})

test.skipIf(process.platform === 'win32')('a held lock reuses an already running daemon', async () => {
  const f = fixture()
  const daemon = join(f.root, '.daemon.sh')
  writeFileSync(daemon, '#!/bin/sh\nsleep 3\n', { mode: 0o700 })
  const existing = spawn('sh', [daemon], { env: f.env })
  try {
    const holder = spawn('sh', ['-c', `${lockScript}\n${f.acquire}\necho lock-held\nsleep 1`], { env: f.env })
    const done = once(holder, 'close')
    const [ready] = await once(holder.stdout, 'data')
    expect(String(ready)).toContain('lock-held')

    const contender = spawnSync('sh', ['-c', `${lockScript}\n${f.reportBusy}`, 'sh', daemon], {
      env: { ...f.env, RACKTOP_DAEMON_START_WAIT_SECONDS: '1', RACKTOP_TEST_PS_OUTPUT: `123 sh ${daemon}` },
      encoding: 'utf8',
    })
    expect(contender.status, `${contender.stdout}\n${contender.stderr}`).toBe(0)
    expect(contender.stdout).toContain('__RACKTOP_REMOTE_HISTORY_READY__')
    expect(contender.stdout).not.toContain('__RACKTOP_REMOTE_HISTORY_STARTING__')
    await done
  } finally {
    existing.kill()
    await once(existing, 'close')
  }
})
