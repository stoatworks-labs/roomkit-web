// Geometry, verification and export. A port of roomkit's common.py plus the build()
// halves of helmholtz.py and diffuser.py, on replicad (OpenCascade in WASM) in place
// of cadquery. Every part is checked from the BUILT solid before it is offered for
// download: OCC booleans can drop a body and still produce a plausible mesh.
//
// replicad semantics this file leans on: booleans leave their inputs alive,
// transforms (translate, mirror) delete `this` — so clone() any part still needed.

import { makeBox, makeCylinder, measureVolume, getOC, type Shape3D } from 'replicad'
import {
  Design,
  FLANGE_EXTRA,
  FLANGE_T,
  FIT,
  LIP_GAP,
  LIP_H,
  LIP_W,
  TUBE_WALL,
  designDepths,
  freqForWavelength,
  fmtHz,
  helmholtzF,
  type Vec3,
} from './acoustics'
import { toBinaryStl, weld, type Mesh } from './mesh'

export const PLA_DENSITY = 1.24 // g/cm3

/** (label, x, y, z0, z1, expect material) */
export type Probe = [string, number, number, number, number, boolean]

export interface Part {
  name: string // file stem, e.g. helmholtz-80Hz-tray
  ok: boolean
  lines: string[]
  mesh?: Mesh // welded, watertight
  stl?: Uint8Array
  step?: Uint8Array
  grams?: number
  size?: Vec3
}

export const box = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): Shape3D =>
  makeBox([x0, y0, z0], [x1, y1, z1])

const cyl = (r: number, h: number, x = 0, y = 0, z = 0): Shape3D => makeCylinder(r, h, [x, y, z])

function union(parts: Shape3D[]): Shape3D {
  // Pairwise tree rather than a left fold: each boolean then sees two small shapes,
  // which is several times faster in WASM for the 49-pillar skyline.
  let layer = parts
  while (layer.length > 1) {
    const next: Shape3D[] = []
    for (let i = 0; i < layer.length; i += 2) {
      next.push(i + 1 < layer.length ? layer[i].fuse(layer[i + 1]) : layer[i])
    }
    layer = next
  }
  return layer[0]
}

function probe(solid: Shape3D, x: number, y: number, z0: number, z1: number, r = 0.5): number {
  const common = solid.intersect(cyl(r, z1 - z0, x, y, z0))
  return common.solids.length ? measureVolume(common) : 0
}

function isValid(solid: Shape3D): boolean {
  const oc = getOC()
  const an = new oc.BRepCheck_Analyzer(solid.wrapped, true, false, false)
  const ok = an.IsValid()
  an.delete()
  return ok
}

export interface ExportOptions {
  step: boolean
}

/** Validate a built part; produce STL (+STEP) only if every check passes. */
export async function verifyAndExport(
  solid: Shape3D,
  name: string,
  bed: Vec3,
  expectedVolume: number | null,
  probes: Probe[],
  opts: ExportOptions,
): Promise<Part> {
  const lines: string[] = []
  let ok = true

  if (!isValid(solid)) {
    ok = false
    lines.push('FAIL solid is not valid (OCC)')
  }
  const nSolids = solid.solids.length
  if (nSolids !== 1) {
    ok = false
    lines.push(`FAIL expected 1 solid, built ${nSolids}`)
  }

  const [[x0, y0, z0], [x1, y1, z1]] = solid.boundingBox.bounds
  const size: Vec3 = [x1 - x0, y1 - y0, z1 - z0]
  lines.push(`size ${size.map((s) => s.toFixed(1)).join(' x ')} mm (bed ${bed.map((b) => b.toFixed(0)).join('x')})`)
  if (size[0] > bed[0] + 1e-6 || size[1] > bed[1] + 1e-6 || size[2] > bed[2] + 1e-6) {
    ok = false
    lines.push('FAIL does not fit the bed')
  }
  if (z0 < -1e-6) {
    ok = false
    lines.push(`FAIL part reaches below z=0 (${z0.toFixed(2)}) and would print on that point`)
  }

  const vol = measureVolume(solid)
  if (expectedVolume != null) {
    const err = Math.abs(vol - expectedVolume) / expectedVolume
    lines.push(`volume ${(vol / 1000).toFixed(1)} cm³ (analytic ${(expectedVolume / 1000).toFixed(1)}, err ${(err * 100).toFixed(3)}%)`)
    if (err > 1e-4) {
      ok = false
      lines.push('FAIL built volume disagrees with the analytic volume: a boolean dropped or added material')
    }
  } else lines.push(`volume ${(vol / 1000).toFixed(1)} cm³`)

  for (const [label, x, y, pz0, pz1, want] of probes) {
    const v = probe(solid, x, y, pz0, pz1)
    if (v > 1e-3 !== want) {
      ok = false
      lines.push(`FAIL probe ${label}: expected ${want ? 'material' : 'air'}, got ${v.toFixed(3)} mm³`)
    }
  }
  if (probes.length && ok) lines.push(`${probes.length} probes agree`)
  if (!ok) return { name, ok, lines, size }

  const raw = solid.mesh({ tolerance: 0.05, angularTolerance: 0.1 })
  const mesh = weld(raw.vertices, raw.triangles)
  if (!mesh.watertight) {
    return { name, ok: false, lines: [...lines, `FAIL exported mesh is not watertight (${mesh.openEdges} open, ${mesh.overEdges} non-manifold edges)`], size }
  }
  const grams = filamentGrams(mesh)
  lines.push(`filament ~${grams.toFixed(0)} g PLA (4 walls/top/bottom, 15% infill estimate)`)
  const part: Part = { name, ok: true, lines, mesh, stl: toBinaryStl(mesh, name), grams, size }
  if (opts.step) part.step = new Uint8Array(await solid.blobSTEP().arrayBuffer())
  return part
}

/** Rough slicer-style estimate: a shell of `shellMm` over the surface, infill inside. */
export function filamentGrams(mesh: Mesh, shellMm = 1.7, infill = 0.15): number {
  const shell = Math.min(mesh.area * shellMm, mesh.volume)
  const inner = Math.max(mesh.volume - shell, 0)
  return ((shell + inner * infill) / 1000) * PLA_DENSITY
}

// --------------------------------------------------------------------------- Helmholtz

export interface HelmholtzBuild {
  parts: Part[]
  builtCavityL: number
  builtF: number
  builtErr: number // fraction off target
  ok: boolean
}

export async function buildHelmholtz(des: Design, bed: Vec3, opts: ExportOptions): Promise<HelmholtzBuild> {
  const [w, d, h] = des.outer
  const t = des.wall
  const r = des.r
  const ro = r + TUBE_WALL
  const cx = w / 2
  const cy = d / 2
  const stem = `helmholtz-${des.fTarget.toFixed(0)}Hz`

  const trayH = h - t
  const tray = box(0, 0, 0, w, d, trayH).cut(box(t, t, t, w - t, d - t, trayH + 1))
  const trayVol = w * d * trayH - (w - 2 * t) * (d - 2 * t) * (trayH - t)

  // lid printed face-down: plate at z 0..t, lip rising from it (goes inside the tray)
  const lx0 = t + LIP_GAP
  const ly0 = t + LIP_GAP
  const lx1 = w - t - LIP_GAP
  const ly1 = d - t - LIP_GAP
  const lip = box(lx0, ly0, t, lx1, ly1, t + LIP_H).cut(box(lx0 + LIP_W, ly0 + LIP_W, t - 1, lx1 - LIP_W, ly1 - LIP_W, t + LIP_H + 1))
  const holeR = ro + FIT
  const lid = box(0, 0, 0, w, d, t).fuse(lip).cut(cyl(holeR, t + 2, cx, cy, -1))
  const lipArea = (lx1 - lx0) * (ly1 - ly0) - (lx1 - lx0 - 2 * LIP_W) * (ly1 - ly0 - 2 * LIP_W)
  const lidVol = w * d * t + lipArea * LIP_H - Math.PI * holeR ** 2 * t

  // neck printed flange-down: flange z 0..FLANGE_T, tube above it
  const fr = ro + FLANGE_EXTRA
  const L = des.printLen
  const neck = cyl(fr, FLANGE_T)
    .fuse(cyl(ro, L, 0, 0, FLANGE_T - 0.5))
    .cut(cyl(r, FLANGE_T + L + 2, 0, 0, -1))
  const neckVol = Math.PI * (fr ** 2 - r ** 2) * FLANGE_T + Math.PI * (ro ** 2 - r ** 2) * (L - 0.5)

  const specs: [string, Shape3D, number, Probe[]][] = [
    ['tray', tray, trayVol, [
      ['floor', w / 2, d / 2, 0.1, t - 0.1, true],
      ['cavity', w / 2, d / 2, t + 0.1, trayH - 0.1, false],
      ['side wall', t / 2, d / 2, 0.1, trayH - 0.1, true],
    ]],
    ['lid', lid, lidVol, [
      ['neck hole', cx, cy, 0.1, t - 0.1, false],
      ['plate', t + 10, t + 10, 0.1, t - 0.1, true],
      ['lip', lx0 + LIP_W / 2, cy, t + 0.1, t + LIP_H - 0.1, true],
    ]],
    ['neck', neck, neckVol, [
      ['bore', 0, 0, 0.1, FLANGE_T + L - 0.6, false],
      ['flange', ro + FLANGE_EXTRA / 2, 0, 0.1, FLANGE_T - 0.1, true],
      ['tube wall', r + TUBE_WALL / 2, 0, FLANGE_T + 0.1, FLANGE_T + L - 0.6, true],
    ]],
  ]
  const parts: Part[] = []
  for (const [name, solid, vol, probes] of specs) {
    parts.push(await verifyAndExport(solid, `${stem}-${name}`, bed, vol, probes, opts))
  }

  // Air in the assembled cavity, measured from the BUILT solids at the solved length.
  const lidA = lid.clone().mirror('XY', [0, 0, 0]).translate(0, 0, h) // plate top at z=h, lip hanging down
  let neckA = neck.clone().mirror('XY', [0, 0, 0]).translate(w / 2, d / 2, h + FLANGE_T)
  // cut the neck back to its solved (not printed) length
  neckA = neckA.intersect(box(0, 0, h + FLANGE_T - (FLANGE_T + des.tubeLen), w, d, h + FLANGE_T + 1))
  const cavity = box(t, t, t, w - t, d - t, h - t)
  let v = measureVolume(cavity)
  for (const s of [lidA, neckA]) {
    const c = cavity.intersect(s)
    if (c.solids.length) v -= measureVolume(c)
  }
  v -= Math.PI * des.r ** 2 * (des.tubeLen - t) // the bore inside the cavity is neck, not cavity
  const builtF = helmholtzF(des.r, des.airPath(des.tubeLen), v)
  const builtErr = Math.abs(builtF - des.fTarget) / des.fTarget

  return { parts, builtCavityL: v / 1e6, builtF, builtErr, ok: parts.every((p) => p.ok) && builtErr <= 0.005 }
}

// --------------------------------------------------------------------------- diffusers

export type DiffuserMode = 'open-back' | 'solid'

export interface DiffuserCommon {
  n: number
  f0: number | null // design frequency, or
  depth: number | null // max well depth in mm (one of the two)
  base: number
  mode: DiffuserMode
  wall: number
  cap: number
  minHollow: number
}

export interface SkylineParams extends DiffuserCommon {
  cell: number
}

export interface QrdParams extends DiffuserCommon {
  well: number
  fin: number
  length: number
}

export interface DiffuserBuild {
  part: Part
  f0: number
  fMax: number
  summary: string[]
  heights: number[][] // skyline: [y][x]; qrd: [[...depths]]
}

export async function buildSkyline(a: SkylineParams, bed: Vec3, opts: ExportOptions): Promise<DiffuserBuild> {
  const { n, cell, base, wall, cap } = a
  const seq: number[] = []
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) seq.push((x * x + y * y) % n)
  const { depths, f0 } = designDepths(seq, n, a.f0, a.depth)
  const h = (x: number, y: number) => depths[y * n + x]
  const side = n * cell
  const fMax = freqForWavelength(2 * cell)

  const parts: Shape3D[] = [box(0, 0, 0, side, side, base)]
  let expected = side * side * base
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const hh = h(x, y)
      if (hh > 1e-6) {
        parts.push(box(x * cell, y * cell, base, (x + 1) * cell, (y + 1) * cell, base + hh))
        expected += cell * cell * hh
      }
    }
  }

  // Saddle corners: where two diagonal pillars both stand taller than the other
  // two, they touch along a bare vertical line — a non-manifold edge. Bridge each
  // with a small post, smaller than wall/2 so it never breaks into a hollow.
  const post = Math.min(1.0, wall / 2 - 0.2)
  let nPosts = 0
  for (let x = 1; x < n; x++) {
    for (let y = 1; y < n; y++) {
      const a_ = h(x - 1, y - 1)
      const b_ = h(x, y)
      const c_ = h(x, y - 1)
      const d_ = h(x - 1, y)
      for (const [hi1, hi2, lo1, lo2] of [[a_, b_, c_, d_], [c_, d_, a_, b_]]) {
        if (Math.min(hi1, hi2) > Math.max(lo1, lo2) + 1e-6) {
          const ptop = Math.min(hi1, hi2)
          const cx = x * cell
          const cy = y * cell
          parts.push(box(cx - post, cy - post, base, cx + post, cy + post, base + ptop))
          expected += post * post * (ptop - lo1 + (ptop - lo2))
          nPosts++
        }
      }
    }
  }
  let solid = union(parts)

  const hollow = new Set<string>()
  if (a.mode === 'open-back') {
    const cutters: Shape3D[] = []
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const hh = h(x, y)
        if (hh < a.minHollow) continue
        const x0 = x * cell + (x === 0 ? wall : wall / 2)
        const x1 = (x + 1) * cell - (x === n - 1 ? wall : wall / 2)
        const y0 = y * cell + (y === 0 ? wall : wall / 2)
        const y1 = (y + 1) * cell - (y === n - 1 ? wall : wall / 2)
        const top = base + hh - cap
        cutters.push(box(x0, y0, -1, x1, y1, top))
        expected -= (x1 - x0) * (y1 - y0) * top
        hollow.add(`${x},${y}`)
      }
    }
    if (cutters.length) solid = solid.cut(union(cutters)) // cutters never touch: walls separate them
  }

  // Probes: the tallest pillar has material just under its top and air above it;
  // a zero-height cell (the origin, s=0) has air just above the base.
  let tx = 0
  let ty = 0
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (h(x, y) > h(tx, ty)) [tx, ty] = [x, y]
  const ht = h(tx, ty)
  const pcx = (tx + 0.5) * cell
  const pcy = (ty + 0.5) * cell
  const probes: Probe[] = [
    ['tallest pillar top', pcx, pcy, base + ht - cap * 0.9, base + ht - 0.05, true],
    ['above tallest pillar', pcx, pcy, base + ht + 0.1, base + ht + 2, false],
    ['zero cell above base', 0.5 * cell, 0.5 * cell, base + 0.1, base + 5, false],
    hollow.has(`${tx},${ty}`)
      ? ['tallest pillar hollow', pcx, pcy, 0.1, base + ht - cap - 0.1, false]
      : ['tallest pillar solid', pcx, pcy, 0.1, base + ht - 0.1, true],
  ]

  const name = `skyline-n${n}-c${cell}-f${f0.toFixed(0)}-${a.mode}`
  const summary = [
    `skyline N=${n}, ${n}×${n} cells of ${cell} mm, tile ${side} mm square`,
    `design f0 ${fmtHz(f0)}, upper limit ~${fmtHz(fMax)} (cell = half a wavelength)`,
  ]
  if (nPosts) summary.push(`${nPosts} saddle corners bridged with ${round(2 * post, 2)} mm posts`)
  if (a.mode === 'open-back') summary.push(`${hollow.size} of ${n * n} pillars hollow (≥ ${a.minHollow} mm), walls ${wall}, caps ${cap}`)
  const heights = Array.from({ length: n }, (_, y) => Array.from({ length: n }, (_, x) => h(x, y)))
  const part = await verifyAndExport(solid, name, bed, expected, probes, opts)
  return { part, f0, fMax, summary, heights }
}

export async function buildQrd(a: QrdParams, bed: Vec3, opts: ExportOptions): Promise<DiffuserBuild> {
  const { n, well: w, fin, base, wall, cap, length } = a
  const seq = Array.from({ length: n }, (_, k) => (k * k) % n)
  const { depths, f0 } = designDepths(seq, n, a.f0, a.depth)
  const dMax = Math.max(...depths)
  const top = base + dMax
  const width = n * (w + fin) + fin
  const fMax = freqForWavelength(2 * w)

  const parts: Shape3D[] = []
  let expected = 0
  for (let k = 0; k <= n; k++) {
    const x0 = k * (w + fin)
    parts.push(box(x0, 0, 0, x0 + fin, length, top))
    expected += fin * length * top
  }
  const floors: [number, number][] = []
  depths.forEach((dd, k) => {
    const x0 = fin + k * (w + fin)
    const fz = top - dd
    floors.push([x0, fz])
    parts.push(box(x0, 0, 0, x0 + w, length, fz))
    expected += w * length * fz
  })
  let solid = union(parts)

  const hollow = new Set<number>()
  if (a.mode === 'open-back') {
    const cutters: Shape3D[] = []
    floors.forEach(([x0, fz], k) => {
      if (fz - base < a.minHollow) return
      const ztop = fz - cap
      cutters.push(box(x0, wall, -1, x0 + w, length - wall, ztop))
      expected -= w * (length - 2 * wall) * ztop
      hollow.add(k)
    })
    if (cutters.length) solid = solid.cut(union(cutters))
  }

  let kd = 0
  let ks = 0
  depths.forEach((dd, k) => {
    if (dd > depths[kd]) kd = k
    if (dd < depths[ks]) ks = k
  })
  const xd = floors[kd][0] + w / 2
  const xs = floors[ks][0] + w / 2
  const ym = length / 2
  const probes: Probe[] = [
    ['fin full height', fin / 2, ym, top - 1, top - 0.05, true],
    ['deepest well open', xd, ym, base + 0.1, top - 0.1, false],
    ['above front plane', xs, ym, top + 0.1, top + 2, false],
    ['shallowest floor', xs, ym, floors[ks][1] - cap * 0.9, floors[ks][1] - 0.05, true],
  ]
  if (hollow.has(ks)) probes.push(['shallowest floor hollow', xs, ym, 0.1, floors[ks][1] - cap - 0.1, false])

  const name = `qrd-n${n}-w${w}-f${f0.toFixed(0)}-L${length}-${a.mode}`
  const summary = [
    `QRD N=${n}, wells ${w} mm + fins ${fin} mm, period ${round(width, 1)} mm, length ${length} mm`,
    `design f0 ${fmtHz(f0)}, upper limit ~${fmtHz(fMax)}`,
    `sequence [${seq.join(', ')}]`,
  ]
  if (a.mode === 'open-back') summary.push(`${hollow.size} of ${n} well floors hollow (≥ ${a.minHollow} mm)`)
  const part = await verifyAndExport(solid, name, bed, expected, probes, opts)
  return { part, f0, fMax, summary, heights: [depths] }
}

const round = (x: number, dp: number) => Math.round(x * 10 ** dp) / 10 ** dp
