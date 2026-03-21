/**
 * Daemon IPC utilities — used by both daemon.ts and server.ts.
 *
 * Communication is file-based: the daemon writes JSON envelopes to per-topic
 * directories, plugin instances watch their directory via fs.watch + polling.
 */

import {
  readFileSync, writeFileSync, mkdirSync, readdirSync, renameSync, unlinkSync,
  existsSync, openSync, closeSync, constants,
} from 'fs'
import { join } from 'path'
import { spawn } from 'child_process'
import { DAEMON_DIR } from './gate.js'
import type { InboxEnvelope, TopicMeta } from './types.js'

const PID_FILE = join(DAEMON_DIR, 'pid')
const SEQ_FILE = join(DAEMON_DIR, 'seq')
const SPAWN_LOCK = join(DAEMON_DIR, 'spawn.lock')
const TOPICS_DIR = join(DAEMON_DIR, 'topics')

export { TOPICS_DIR }

/** Check if the daemon process is alive. */
export function isAlive(): boolean {
  try {
    const pid = Number(readFileSync(PID_FILE, 'utf8').trim())
    if (!pid || isNaN(pid)) return false
    process.kill(pid, 0) // signal 0 = existence check
    return true
  } catch {
    return false
  }
}

/** Get the daemon's PID, or null if not running. */
export function getDaemonPid(): number | null {
  try {
    const pid = Number(readFileSync(PID_FILE, 'utf8').trim())
    if (!pid || isNaN(pid)) return null
    process.kill(pid, 0)
    return pid
  } catch {
    return null
  }
}

/** Write PID file atomically (daemon-only). */
export function writePidFile(pid: number): void {
  mkdirSync(DAEMON_DIR, { recursive: true, mode: 0o700 })
  const tmp = PID_FILE + '.tmp'
  writeFileSync(tmp, String(pid), { mode: 0o600 })
  renameSync(tmp, PID_FILE)
}

/** Remove PID file (daemon-only, on shutdown). */
export function removePidFile(): void {
  try { unlinkSync(PID_FILE) } catch {}
}

/** Atomic increment of the global sequence counter (daemon-only). */
export function nextSeq(): number {
  mkdirSync(DAEMON_DIR, { recursive: true, mode: 0o700 })
  let current = 0
  try {
    current = Number(readFileSync(SEQ_FILE, 'utf8').trim()) || 0
  } catch {}
  const next = current + 1
  const tmp = SEQ_FILE + '.tmp'
  writeFileSync(tmp, String(next), { mode: 0o600 })
  renameSync(tmp, SEQ_FILE)
  return next
}

/** Ensure the per-topic directory exists and return its path. */
export function topicDir(topicId: number | null): string {
  const dir = join(TOPICS_DIR, topicId != null ? String(topicId) : 'general')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  return dir
}

/** Write an envelope atomically to the topic's inbox directory. */
export function writeEnvelope(topicId: number | null, envelope: InboxEnvelope): void {
  const dir = topicDir(topicId)
  const padded = String(envelope.seq).padStart(10, '0')
  const filename = `${padded}-${envelope.messageId}.json`
  const tmp = join(dir, filename + '.tmp')
  const final = join(dir, filename)
  writeFileSync(tmp, JSON.stringify(envelope) + '\n', { mode: 0o600 })
  renameSync(tmp, final)
}

/**
 * Atomically claim and read an envelope. Returns null if already consumed.
 * Uses rename to .consumed as an atomic claim before reading.
 */
export function readAndConsumeEnvelope(filePath: string): InboxEnvelope | null {
  const consumed = filePath + '.consumed'
  try {
    renameSync(filePath, consumed)
  } catch {
    return null // another consumer claimed it
  }
  try {
    const data = JSON.parse(readFileSync(consumed, 'utf8')) as InboxEnvelope
    unlinkSync(consumed)
    return data
  } catch (err) {
    // If parse fails, remove the broken file
    try { unlinkSync(consumed) } catch {}
    return null
  }
}

/** List pending envelope filenames in a topic directory, sorted by seq. */
export function listPendingEnvelopes(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter(f => f.endsWith('.json') && !f.endsWith('.tmp'))
      .sort() // lexicographic sort on zero-padded seq prefix
  } catch {
    return []
  }
}

/** Write topic metadata for teardown/cleanup. */
export function writeTopicMeta(threadId: number, meta: TopicMeta): void {
  const dir = topicDir(threadId)
  const file = join(dir, 'meta.json')
  const tmp = file + '.tmp'
  writeFileSync(tmp, JSON.stringify(meta, null, 2) + '\n', { mode: 0o600 })
  renameSync(tmp, file)
}

/** Read topic metadata. Returns null if not found. */
export function readTopicMeta(threadId: number): TopicMeta | null {
  try {
    const file = join(topicDir(threadId), 'meta.json')
    return JSON.parse(readFileSync(file, 'utf8')) as TopicMeta
  } catch {
    return null
  }
}

/** Find topic metadata by topic name (for teardown). */
export function findTopicByName(name: string): TopicMeta | null {
  try {
    const dirs = readdirSync(TOPICS_DIR)
    for (const d of dirs) {
      if (d === '_unrouted' || d === 'general') continue
      try {
        const metaFile = join(TOPICS_DIR, d, 'meta.json')
        const meta = JSON.parse(readFileSync(metaFile, 'utf8')) as TopicMeta
        if (meta.topicName === name) return meta
      } catch {}
    }
  } catch {}
  return null
}

/**
 * Ensure the daemon is running. Spawns it detached if not alive.
 * Uses a spawn-lock to prevent double-spawn races.
 */
export async function ensureDaemon(): Promise<void> {
  if (isAlive()) return

  // Acquire spawn lock (O_CREAT | O_EXCL = atomic create-or-fail)
  let lockFd: number
  try {
    lockFd = openSync(SPAWN_LOCK, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY)
    closeSync(lockFd)
  } catch {
    // Another process is spawning — wait for pid file
    await waitForDaemon(5000)
    return
  }

  try {
    // Clean stale pid file
    try { unlinkSync(PID_FILE) } catch {}

    // Spawn daemon detached. It inherits env (including TELEGRAM_BOT_TOKEN).
    // Use the plugin root (parent of lib/) as cwd so imports resolve correctly.
    const pluginRoot = join(import.meta.dir, '..')
    const daemonScript = join(pluginRoot, 'daemon.ts')
    const logFile = join(DAEMON_DIR, 'log')
    const { openSync: openFile } = await import('fs')
    const logFd = openFile(logFile, 'a')
    const child = spawn('bun', ['run', daemonScript], {
      detached: true,
      stdio: ['ignore', logFd, logFd],
      cwd: pluginRoot,
      env: process.env,
    })
    child.unref()
    closeSync(logFd)

    await waitForDaemon(5000)
  } finally {
    try { unlinkSync(SPAWN_LOCK) } catch {}
  }
}

/** Poll for daemon pid file to appear, up to timeoutMs. */
async function waitForDaemon(timeoutMs: number): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (isAlive()) return
    await new Promise(r => setTimeout(r, 100))
  }
  process.stderr.write('telegram channel: daemon did not start within timeout\n')
}
