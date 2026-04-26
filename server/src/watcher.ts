import { watch, type FSWatcher } from 'fs'
import { readFileSync, existsSync } from 'fs'

/**
 * Watches a file for content changes (truncate-write produces IN_MODIFY).
 * Atomic-rename produces IN_DELETE_SELF on the watched inode; we don't care
 * here because the broker mirror is always truncate-written by the host
 * refresh script — that's the whole point of the mirror.
 *
 * Coalesces rapid bursts of events into one callback per debounce window.
 */
export interface WatcherOpts {
  path: string
  debounceMs: number
  onChange: (contentB64: string) => void
  log: (msg: string, meta?: Record<string, unknown>) => void
}

export function startWatcher(opts: WatcherOpts): { stop: () => void } {
  let timer: NodeJS.Timeout | null = null
  let lastContentB64: string | null = null

  const fire = () => {
    timer = null
    if (!existsSync(opts.path)) {
      opts.log('watched file missing', { path: opts.path })
      return
    }
    try {
      const buf = readFileSync(opts.path)
      const b64 = buf.toString('base64')
      if (b64 === lastContentB64) return  // no real change
      lastContentB64 = b64
      opts.onChange(b64)
    } catch (err) {
      opts.log('read failed in watcher', {
        path: opts.path,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  let watcher: FSWatcher
  try {
    watcher = watch(opts.path, { persistent: true }, () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(fire, opts.debounceMs)
    })
  } catch (err) {
    opts.log('watcher failed to start', {
      path: opts.path,
      error: err instanceof Error ? err.message : String(err),
    })
    throw err
  }

  // Fire once on startup so we have a known baseline.
  fire()

  return {
    stop: () => {
      if (timer) clearTimeout(timer)
      watcher.close()
    },
  }
}

export function readCredentialsB64(path: string): string | null {
  if (!existsSync(path)) return null
  try {
    return readFileSync(path).toString('base64')
  } catch {
    return null
  }
}
