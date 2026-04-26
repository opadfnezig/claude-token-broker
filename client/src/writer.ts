import { writeFileSync, mkdirSync, existsSync, openSync, closeSync, ftruncateSync, writeSync, fsyncSync } from 'fs'
import { dirname } from 'path'

/**
 * Truncate-write a file in place. CRITICAL for files that other containers
 * RO-mount: it preserves the inode, so their bind mounts stay valid. We do
 * NOT use writeFileSync(path, content) directly because some Node versions
 * may use create-temp-then-rename under the hood; we explicitly open + ftruncate
 * + write to be sure.
 *
 * Mode 0o644 so any uid in the consuming container can read it.
 */
export function writeInPlace(path: string, content: Buffer | string): void {
  const dir = dirname(path)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })

  if (!existsSync(path)) {
    // First write — create the file. After that, we always reuse this inode.
    writeFileSync(path, content, { mode: 0o644 })
    return
  }

  const fd = openSync(path, 'r+')
  try {
    ftruncateSync(fd, 0)
    const buf = Buffer.isBuffer(content) ? content : Buffer.from(content)
    writeSync(fd, buf, 0, buf.length, 0)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}
