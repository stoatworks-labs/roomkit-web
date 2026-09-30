import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { axialModes, designDepths, parseRew, rewPeaks, solve } from './acoustics'
import ref from './fixtures/python-reference.json'

// Every number here came out of the Python roomkit (see ref.source). The port is
// only trustworthy while it agrees with the code the maths was worked out in.

const close = (a: number, b: number, rel = 1e-9) => expect(Math.abs(a - b)).toBeLessThanOrEqual(rel * Math.max(1, Math.abs(b)))

describe('solve matches helmholtz.py', () => {
  for (const c of ref.solve) {
    it(`${c.f} Hz in ${c.fp.join('x')} x <=${c.maxH} mm`, () => {
      const d = solve(c.f, c.fp as [number, number], c.maxH, c.wall, c.margin)
      if (c.res === null) {
        expect(d).toBeNull()
        return
      }
      expect(d).not.toBeNull()
      expect(d!.outer).toEqual(c.res.outer)
      expect(d!.r).toBe(c.res.r)
      close(d!.tubeLen, c.res.tubeLen)
      close(d!.printLen, c.res.printLen)
      close(d!.fAt(d!.printLen), c.res.fPrinted)
      close(d!.cavityVolume(d!.tubeLen), c.res.cav)
    })
  }
})

describe('REW and room targets', () => {
  it('finds the synthetic peaks where the Python does', () => {
    const { fr, spl } = parseRew(readFileSync(new URL('./fixtures/synthetic-rew.txt', import.meta.url), 'utf8'))
    const pk = rewPeaks(fr, spl, 30, 300, 4)
    expect(pk.length).toBe(ref.peaks.length)
    pk.forEach((p, i) => {
      close(p.f, ref.peaks[i][0], 1e-9)
      close(p.db, ref.peaks[i][1], 1e-9)
    })
  })

  it('rejects a file that is not a REW export', () => {
    expect(() => parseRew('hello\nworld\n')).toThrow(/data rows/)
  })

  it('lists axial modes', () => {
    const m = axialModes([5.2, 4.1, 2.6], 150)
    expect(m.map((x) => x.label)).toEqual(ref.modes.map((x) => x[1]))
    m.forEach((x, i) => close(x.f, ref.modes[i][0] as number))
  })
})

describe('diffuser depths', () => {
  it('QRD from f0', () => {
    const { depths, f0 } = designDepths([0, 1, 4, 2, 2, 4, 1], 7, 500, null)
    depths.forEach((d, i) => close(d, (ref.qrd[0] as number[])[i]))
    close(f0, ref.qrd[1] as number)
  })
  it('skyline from max depth', () => {
    const seq: number[] = []
    for (let y = 0; y < 7; y++) for (let x = 0; x < 7; x++) seq.push((x * x + y * y) % 7)
    const { depths, f0 } = designDepths(seq, 7, null, 150)
    depths.forEach((d, i) => close(d, (ref.sky[0] as number[])[i]))
    close(f0, ref.sky[1] as number)
  })
})
