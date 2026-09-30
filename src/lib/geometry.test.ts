import opencascade from 'replicad-opencascadejs'
import { setOC } from 'replicad'
import { fileURLToPath } from 'node:url'
import { unzipSync, strFromU8 } from 'fflate'
import { beforeAll, describe, expect, it } from 'vitest'
import { solve, type Vec3 } from './acoustics'
import { box, buildHelmholtz, buildQrd, buildSkyline, verifyAndExport, type SkylineParams, type QrdParams } from './geometry'
import { to3mf } from './mesh'

// The real OpenCascade WASM, in node. These are the same checks the page runs
// before it offers a download; here they must all pass for the default designs.

const BED: Vec3 = [300, 300, 300]

beforeAll(async () => {
  const wasm = fileURLToPath(import.meta.resolve('replicad-opencascadejs/wasm'))
  setOC(await opencascade({ locateFile: () => wasm }))
})

const failures = (lines: string[]) => lines.filter((l) => l.startsWith('FAIL'))

describe('Helmholtz module', () => {
  it('80 Hz: three parts pass and the built cavity tunes to target', async () => {
    const des = solve(80, [280, 280], 200, 4, 0.12)!
    const b = await buildHelmholtz(des, BED, { step: true })
    for (const p of b.parts) {
      expect(failures(p.lines), p.name).toEqual([])
      expect(p.ok, p.name).toBe(true)
      expect(p.mesh!.watertight).toBe(true)
      // mesh volume within tessellation error of the B-rep's
      expect(p.stl!.byteLength).toBe(84 + 50 * (p.mesh!.indices.length / 3))
      expect(new TextDecoder().decode(p.step!.slice(0, 13))).toBe('ISO-10303-21;')
    }
    expect(b.builtErr).toBeLessThan(0.005)
    expect(b.builtCavityL).toBeCloseTo(des.cavityVolume(des.tubeLen) / 1e6, 2)
    expect(b.ok).toBe(true)
  })

  it('42 Hz (deep box, narrower neck) also passes', async () => {
    const des = solve(42, [280, 280], 200, 4, 0.12)!
    const b = await buildHelmholtz(des, BED, { step: false })
    expect(b.parts.map((p) => failures(p.lines))).toEqual([[], [], []])
    expect(b.ok).toBe(true)
  })

  it('3MF packages all three parts', async () => {
    const des = solve(118, [280, 280], 200, 4, 0.12)!
    const b = await buildHelmholtz(des, BED, { step: false })
    const zip = unzipSync(to3mf(b.parts.map((p) => ({ name: p.name, mesh: p.mesh! }))))
    expect(Object.keys(zip).sort()).toEqual(['3D/3dmodel.model', '[Content_Types].xml', '_rels/.rels'])
    const model = strFromU8(zip['3D/3dmodel.model'])
    expect(model.match(/<object /g)!.length).toBe(3)
    expect(model.match(/<item /g)!.length).toBe(3)
  })

  it('a bed smaller than the module refuses to export', async () => {
    const des = solve(80, [280, 280], 200, 4, 0.12)!
    const b = await buildHelmholtz(des, [250, 250, 250], { step: false })
    expect(b.ok).toBe(false)
    expect(b.parts[0].lines.some((l) => l.includes('does not fit the bed'))).toBe(true)
    expect(b.parts[0].stl).toBeUndefined()
  })
})

const common = { f0: null, depth: null, base: 4, wall: 1.6, cap: 1.6, minHollow: 12 }

describe('diffusers', () => {
  for (const mode of ['open-back', 'solid'] as const) {
    it(`skyline 7x7 f0 800 Hz ${mode}`, async () => {
      const a: SkylineParams = { ...common, n: 7, f0: 800, mode, cell: 40 }
      const b = await buildSkyline(a, BED, { step: false })
      expect(failures(b.part.lines)).toEqual([])
      expect(b.part.ok).toBe(true)
      expect(b.summary.join('\n')).toMatch(/saddle corners bridged/)
    })
    it(`QRD 7 wells f0 500 Hz ${mode}`, async () => {
      const a: QrdParams = { ...common, n: 7, f0: 500, mode, well: 36, fin: 2.4, length: 280 }
      const b = await buildQrd(a, BED, { step: false })
      expect(failures(b.part.lines)).toEqual([])
      expect(b.part.ok).toBe(true)
    })
  }

  it('negative control: an unbridged saddle corner is caught', async () => {
    // Two boxes meeting only along a vertical edge: the defect the saddle posts fix.
    const s = box(0, 0, 0, 10, 10, 10).fuse(box(10, 10, 0, 20, 20, 10))
    const p = await verifyAndExport(s, 'saddle', BED, 2000, [], { step: false })
    expect(p.ok).toBe(false)
    expect(p.stl).toBeUndefined()
  })

  it('skyline 11x11 by depth (the README example)', async () => {
    const a: SkylineParams = { ...common, n: 11, depth: 150, mode: 'open-back', cell: 25 }
    const b = await buildSkyline(a, BED, { step: false })
    expect(failures(b.part.lines)).toEqual([])
  })
})
