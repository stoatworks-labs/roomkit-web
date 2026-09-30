/// <reference lib="webworker" />
// OpenCascade lives here, off the main thread: the WASM is ~22 MB and a skyline
// takes a few seconds of booleans, neither of which should freeze the page.

import opencascade from 'replicad-opencascadejs'
import wasmUrl from 'replicad-opencascadejs/wasm?url'
import { setOC } from 'replicad'
import { Design, type Vec3 } from './lib/acoustics'
import { buildHelmholtz, buildQrd, buildSkyline, type Part, type QrdParams, type SkylineParams } from './lib/geometry'

export type Job =
  | { id: number; kind: 'helmholtz'; design: { fTarget: number; outer: Vec3; wall: number; r: number; tubeLen: number; printLen: number }; bed: Vec3; step: boolean }
  | { id: number; kind: 'skyline'; params: SkylineParams; bed: Vec3; step: boolean }
  | { id: number; kind: 'qrd'; params: QrdParams; bed: Vec3; step: boolean }

export interface PartOut {
  name: string
  ok: boolean
  lines: string[]
  grams?: number
  size?: Vec3
  stl?: Uint8Array
  step?: Uint8Array
  positions?: Float32Array // preview + 3MF
  indices?: Uint32Array
}

export type Reply =
  | { id: number; type: 'ready'; ms: number }
  | { id: number; type: 'done'; kind: 'helmholtz'; parts: PartOut[]; builtCavityL: number; builtF: number; builtErr: number; ok: boolean; ms: number }
  | { id: number; type: 'done'; kind: 'skyline' | 'qrd'; parts: PartOut[]; f0: number; fMax: number; summary: string[]; heights: number[][]; ok: boolean; ms: number }
  | { id: number; type: 'error'; message: string }

const ctx = self as unknown as DedicatedWorkerGlobalScope

const t0 = performance.now()
const ready = opencascade({ locateFile: () => wasmUrl }).then((oc) => {
  setOC(oc)
  ctx.postMessage({ id: 0, type: 'ready', ms: performance.now() - t0 } satisfies Reply)
})

function out(p: Part): PartOut {
  return {
    name: p.name,
    ok: p.ok,
    lines: p.lines,
    grams: p.grams,
    size: p.size,
    stl: p.stl,
    step: p.step,
    positions: p.mesh ? Float32Array.from(p.mesh.positions) : undefined,
    indices: p.mesh?.indices,
  }
}

function transfers(parts: PartOut[]): Transferable[] {
  const t: Transferable[] = []
  for (const p of parts) for (const b of [p.stl, p.step, p.positions, p.indices]) if (b) t.push(b.buffer as ArrayBuffer)
  return t
}

ctx.onmessage = async (e: MessageEvent<Job>) => {
  const job = e.data
  try {
    await ready
    const start = performance.now()
    const opts = { step: job.step }
    if (job.kind === 'helmholtz') {
      const j = job.design
      const des = new Design(j.fTarget, j.outer, j.wall, j.r)
      des.tubeLen = j.tubeLen
      des.printLen = j.printLen
      const b = await buildHelmholtz(des, job.bed, opts)
      const parts = b.parts.map(out)
      const reply: Reply = { id: job.id, type: 'done', kind: 'helmholtz', parts, builtCavityL: b.builtCavityL, builtF: b.builtF, builtErr: b.builtErr, ok: b.ok, ms: performance.now() - start }
      ctx.postMessage(reply, transfers(parts))
    } else {
      const b = job.kind === 'skyline' ? await buildSkyline(job.params, job.bed, opts) : await buildQrd(job.params, job.bed, opts)
      const parts = [out(b.part)]
      const reply: Reply = { id: job.id, type: 'done', kind: job.kind, parts, f0: b.f0, fMax: b.fMax, summary: b.summary, heights: b.heights, ok: b.part.ok, ms: performance.now() - start }
      ctx.postMessage(reply, transfers(parts))
    }
  } catch (err) {
    ctx.postMessage({ id: job.id, type: 'error', message: err instanceof Error ? err.message : String(err) } satisfies Reply)
  }
}
