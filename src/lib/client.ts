// Main-thread side of the geometry worker: one worker for the page's lifetime,
// jobs matched to replies by id.

import type { Job, Reply } from '../worker'

type Pending = { resolve: (r: Reply) => void; reject: (e: Error) => void }
type JobIn = Job extends infer J ? (J extends { id: number } ? Omit<J, 'id'> : never) : never

let worker: Worker | null = null
let nextId = 1
const pending = new Map<number, Pending>()
const readyListeners = new Set<(ms: number) => void>()
let readyMs: number | null = null

function ensure(): Worker {
  if (worker) return worker
  worker = new Worker(new URL('../worker.ts', import.meta.url), { type: 'module' })
  worker.onmessage = (e: MessageEvent<Reply>) => {
    const r = e.data
    if (r.type === 'ready') {
      readyMs = r.ms
      readyListeners.forEach((f) => f(r.ms))
      return
    }
    const p = pending.get(r.id)
    if (!p) return
    pending.delete(r.id)
    if (r.type === 'error') p.reject(new Error(r.message))
    else p.resolve(r)
  }
  worker.onerror = (e) => {
    const err = new Error(e.message || 'the geometry worker failed to start')
    pending.forEach((p) => p.reject(err))
    pending.clear()
  }
  return worker
}

/** Start loading OpenCascade now, so the first build doesn't pay for it. */
export function warmUp(onReady: (ms: number) => void): () => void {
  ensure()
  if (readyMs != null) onReady(readyMs)
  readyListeners.add(onReady)
  return () => readyListeners.delete(onReady)
}

export function run(job: JobIn): Promise<Extract<Reply, { type: 'done' }>> {
  const w = ensure()
  const id = nextId++
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve: resolve as (r: Reply) => void, reject })
    w.postMessage({ ...job, id })
  })
}
