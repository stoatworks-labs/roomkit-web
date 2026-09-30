import { describe, expect, it } from 'vitest'
import { weld } from './mesh'

// A unit cube as OCC would hand it over: every face meshed on its own, so the
// eight corners arrive duplicated across faces and must be welded back together.
function cubeSoup(): { v: number[]; t: number[] } {
  const faces: number[][][] = [
    [[0, 0, 0], [0, 1, 0], [1, 1, 0], [1, 0, 0]], // z=0, normal -z
    [[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]], // z=1, +z
    [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]], // y=0, -y
    [[0, 1, 0], [0, 1, 1], [1, 1, 1], [1, 1, 0]], // y=1, +y
    [[0, 0, 0], [0, 0, 1], [0, 1, 1], [0, 1, 0]], // x=0, -x
    [[1, 0, 0], [1, 1, 0], [1, 1, 1], [1, 0, 1]], // x=1, +x
  ]
  const v: number[] = []
  const t: number[] = []
  for (const f of faces) {
    const b = v.length / 3
    for (const p of f) v.push(...p)
    t.push(b, b + 1, b + 2, b, b + 2, b + 3)
  }
  return { v, t }
}

describe('weld + watertight', () => {
  it('a closed cube is watertight with volume 1 and area 6', () => {
    const { v, t } = cubeSoup()
    const m = weld(v, t)
    expect(m.positions.length / 3).toBe(8)
    expect(m.watertight).toBe(true)
    expect(m.volume).toBeCloseTo(1, 12)
    expect(m.area).toBeCloseTo(6, 12)
  })

  it('a missing triangle leaves open edges', () => {
    const { v, t } = cubeSoup()
    const m = weld(v, t.slice(3))
    expect(m.watertight).toBe(false)
    expect(m.openEdges).toBe(3)
  })

  it('a flipped triangle is caught even though every edge is still used twice', () => {
    const { v, t } = cubeSoup()
    ;[t[1], t[2]] = [t[2], t[1]]
    expect(weld(v, t).watertight).toBe(false)
  })

  it('two cubes sharing only an edge are non-manifold', () => {
    const a = cubeSoup()
    const b = cubeSoup()
    const n = a.v.length / 3
    const v = [...a.v, ...b.v.map((x, i) => (i % 3 === 2 ? x : x + 1))] // shift by (1,1,0)
    const t = [...a.t, ...b.t.map((i) => i + n)]
    const m = weld(v, t)
    expect(m.watertight).toBe(false)
    expect(m.overEdges).toBeGreaterThan(0)
  })
})
