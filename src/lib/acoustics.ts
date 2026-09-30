// The acoustics half of roomkit: pure maths, no geometry. A line-for-line port of
// ~/hardware/audio/roomkit's helmholtz.py and diffuser.py (2bd5aed); the tests pin
// these numbers to that Python's output, so change one only alongside the other.

export const C_AIR = 343.0 // m/s at ~20 degC

export const TUBE_WALL = 2.0 // neck tube wall, mm
export const FLANGE_T = 2.5 // neck flange thickness, mm
export const FLANGE_EXTRA = 8.0 // flange radius beyond the tube OD, mm
export const FIT = 0.15 // radial clearance, neck tube in lid hole, mm
export const LIP_H = 4.0 // lid alignment lip height, mm
export const LIP_W = 2.0 // lid lip width, mm
export const LIP_GAP = 0.3 // lip to tray inner wall clearance, mm
export const MIN_PROTRUDE = 5.0 // tube must stand at least this far into the cavity, mm
export const RADII = [30.0, 25.0, 20.0, 15.0, 12.5, 10.0, 8.0] // neck bore radii tried, largest first

export type Vec3 = [number, number, number]

export const wavelengthMm = (f: number) => (C_AIR / f) * 1000
export const freqForWavelength = (lamMm: number) => C_AIR / (lamMm / 1000)

export function fmtHz(f: number): string {
  return f >= 1000 ? `${(f / 1000).toFixed(2)} kHz` : `${f.toFixed(0)} Hz`
}

// --------------------------------------------------------------------------- Helmholtz

/** f = c/2pi * sqrt(S / (V * L_eff)), L_eff = L + 0.85r (flanged) + 0.61r (unflanged). */
export function helmholtzF(rMm: number, lMm: number, vMm3: number): number {
  const s = Math.PI * (rMm / 1000) ** 2
  const leff = (lMm + 1.46 * rMm) / 1000
  const v = vMm3 / 1e9
  return (C_AIR / (2 * Math.PI)) * Math.sqrt(s / (v * leff))
}

export class Design {
  tubeLen = 0 // solved tube length below the flange, mm
  printLen = 0 // as printed, with the trim margin

  constructor(
    readonly fTarget: number,
    readonly outer: Vec3, // W, D, H of the assembled box, mm
    readonly wall: number,
    readonly r: number, // bore radius, mm
  ) {}

  get interior(): Vec3 {
    const [w, d, h] = this.outer
    const t = this.wall
    return [w - 2 * t, d - 2 * t, h - 2 * t]
  }

  airPath(tubeLen: number): number {
    return FLANGE_T + tubeLen
  }

  cavityVolume(tubeLen: number): number {
    const [iw, idp, ih] = this.interior
    let v = iw * idp * ih
    // lid lip ring inside the cavity
    const lw = iw - 2 * LIP_GAP
    const ld = idp - 2 * LIP_GAP
    v -= (lw * ld - (lw - 2 * LIP_W) * (ld - 2 * LIP_W)) * LIP_H
    // tube wall + bore inside the cavity (the bore is neck, not cavity)
    const inside = tubeLen - this.wall
    v -= Math.PI * (this.r + TUBE_WALL) ** 2 * inside
    return v
  }

  fAt(tubeLen: number): number {
    return helmholtzF(this.r, this.airPath(tubeLen), this.cavityVolume(tubeLen))
  }

  /** Trim table: printed length down to 80% of solved (or the minimum protrusion), 7 steps. */
  trimTable(): { len: number; f: number }[] {
    const lo = Math.max(this.wall + MIN_PROTRUDE, this.tubeLen * 0.8)
    const hi = this.printLen
    return Array.from({ length: 7 }, (_, i) => {
      const len = hi + ((lo - hi) * i) / 6
      return { len, f: this.fAt(len) }
    })
  }
}

/**
 * Widest neck that can reach f within maxH, in the shallowest box that does it.
 * A wide neck in a big box couples to the room far better (lower Q, more
 * absorption area) than a pinhole in a flat box tuned to the same frequency.
 */
export function solve(f: number, footprint: [number, number], maxH: number, wall: number, margin: number): Design | null {
  const [w, d] = footprint
  for (const r of RADII) {
    for (let h = 40; h <= maxH + 0.1; h += 5) {
      if (2 * (r + TUBE_WALL + FLANGE_EXTRA) > Math.min(w, d) - 2 * wall) continue
      const des = new Design(f, [w, d, h], wall, r)
      const ih = des.interior[2]
      const lo = wall + MIN_PROTRUDE
      const hi = wall + ih - 1.5 * r // leave >= 1.5 r of air under the tube end
      if (hi <= lo) continue
      if (des.fAt(lo) < f || des.fAt(hi) > f) continue // f not bracketed at this size
      let a = lo
      let b = hi
      for (let i = 0; i < 80; i++) {
        const m = (a + b) / 2
        if (des.fAt(m) > f) a = m
        else b = m
      }
      des.tubeLen = (a + b) / 2
      des.printLen = des.tubeLen * (1 + margin)
      if (des.printLen > hi) continue // no room under the tube for the trim margin: go deeper
      return des
    }
  }
  return null
}

// --------------------------------------------------------------------------- targets

/** Parse a REW "Export measurement as text" file: freq, SPL[, phase] rows; * # ; comments. */
export function parseRew(text: string): { fr: number[]; spl: number[] } {
  const fr: number[] = []
  const spl: number[] = []
  for (const line of text.split(/\r?\n/)) {
    const s = line.trim()
    if (!s || '*#;'.includes(s[0]) || !(/[0-9]/.test(s[0]) || s[0] === '.')) continue
    const cols = s.replace(/[,\t]/g, ' ').split(/\s+/)
    const f = Number(cols[0])
    const p = Number(cols[1])
    if (cols.length < 2 || !Number.isFinite(f) || !Number.isFinite(p)) continue
    fr.push(f)
    spl.push(p)
  }
  if (fr.length < 10) {
    throw new Error(`found ${fr.length} data rows; expected a REW text export (freq SPL phase)`)
  }
  return { fr, spl }
}

function interp(x: number, xs: number[], ys: number[]): number {
  // numpy.interp: xs ascending, clamps at the ends
  if (x <= xs[0]) return ys[0]
  const n = xs.length
  if (x >= xs[n - 1]) return ys[n - 1]
  let lo = 0
  let hi = n - 1
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (xs[mid] <= x) lo = mid
    else hi = mid
  }
  const t = (x - xs[lo]) / (xs[hi] - xs[lo])
  return ys[lo] + t * (ys[hi] - ys[lo])
}

function median(a: number[]): number {
  const s = [...a].sort((x, y) => x - y)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

export interface Peak {
  f: number
  db: number // dB above the 1-octave running median (ranks peaks; reads low in absolute terms)
}

/** Peaks between fmin and fmax that stand `prominence` dB over a 1-octave running median. */
export function rewPeaks(frIn: number[], splIn: number[], fmin: number, fmax: number, prominence: number): Peak[] {
  const pairs = frIn.map((f, i) => [f, splIn[i]] as const).filter(([f]) => f > 0)
  const fr = pairs.map((p) => p[0])
  const spl = pairs.map((p) => p[1])
  const start = Math.log(Math.max(fmin / 2, Math.min(...fr)))
  const stop = Math.log(Math.min(fmax * 2, Math.max(...fr)))
  const step = Math.log(2) / 96
  const grid: number[] = []
  // np.arange(start, stop, step): count = ceil((stop - start) / step)
  const count = Math.ceil((stop - start) / step)
  for (let i = 0; i < count; i++) grid.push(Math.exp(start + i * step))
  const g = grid.map((x) => interp(x, fr, spl))
  // Baseline: running MEDIAN over one octave. A mean over a window as narrow as
  // the modes themselves (1/3 oct) swallows them; a median ignores the peak.
  const half = 48
  const padded = [...Array(half).fill(g[0]), ...g, ...Array(half).fill(g[g.length - 1])]
  const smooth = g.map((_, i) => median(padded.slice(i, i + 2 * half + 1)))
  const peaks: Peak[] = []
  for (let i = 1; i < g.length - 1; i++) {
    const resid = g[i] - smooth[i]
    if (g[i] >= g[i - 1] && g[i] > g[i + 1] && grid[i] >= fmin && grid[i] <= fmax && resid >= prominence) {
      peaks.push({ f: grid[i], db: resid })
    }
  }
  const merged: Peak[] = [] // merge within 1/6 octave, keep the stronger
  for (const p of peaks.sort((a, b) => a.f - b.f)) {
    const last = merged[merged.length - 1]
    if (last && p.f / last.f < 2 ** (1 / 6)) {
      if (p.db > last.db) merged[merged.length - 1] = p
    } else merged.push(p)
  }
  return merged
}

export interface Mode {
  f: number
  label: string
}

/** Axial modes only (the strongest family); tangential and oblique are not listed. */
export function axialModes(dimsM: Vec3, fmax: number): Mode[] {
  const out: Mode[] = []
  ;(['L', 'W', 'H'] as const).forEach((name, i) => {
    const l = dimsM[i]
    if (!(l > 0)) return
    for (let n = 1; ; n++) {
      const f = (n * C_AIR) / (2 * l)
      if (f > fmax) break
      out.push({ f, label: `${name} axial n=${n}` })
    }
  })
  // Python sorts (f, label) tuples: coincident modes fall back to label order.
  return out.sort((a, b) => a.f - b.f || (a.label < b.label ? -1 : a.label > b.label ? 1 : 0))
}

// --------------------------------------------------------------------------- diffusers

export function isPrime(n: number): boolean {
  if (!Number.isInteger(n) || n < 2) return false
  for (let k = 2; k * k <= n; k++) if (n % k === 0) return false
  return true
}

/** Per-element depths (mm) for d = s * lambda0 / 2N, and the design frequency actually used. */
export function designDepths(seq: number[], n: number, f0: number | null, depth: number | null): { depths: number[]; f0: number } {
  const sMax = Math.max(...seq)
  let lam0: number
  let fUsed: number
  if (depth != null) {
    lam0 = (depth * 2 * n) / sMax
    fUsed = freqForWavelength(lam0)
  } else {
    fUsed = f0!
    lam0 = wavelengthMm(fUsed)
  }
  return { depths: seq.map((s) => (s * lam0) / (2 * n)), f0: fUsed }
}
