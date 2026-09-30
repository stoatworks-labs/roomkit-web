import { zipSync } from 'fflate'
import { to3mf } from './mesh'
import type { PartOut } from '../worker'

export function save(name: string, data: Uint8Array | string, type: string) {
  const blob = new Blob([data as BlobPart], { type })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

export const MIME = {
  stl: 'model/stl',
  step: 'model/step',
  '3mf': 'model/3mf',
  zip: 'application/zip',
  txt: 'text/plain',
}

export const PLATE_GAP = 10 // mm between parts on a shared 3MF plate (to3mf's default)

export function make3mf(parts: PartOut[]): Uint8Array {
  return to3mf(parts.filter((p) => p.positions && p.indices).map((p) => ({ name: p.name, mesh: { positions: p.positions!, indices: p.indices! } })), PLATE_GAP)
}

/** Would the parts laid out in a row (as to3mf places them) fit on one bed? */
export function fitsOnePlate(parts: PartOut[], bed: [number, number, number]): boolean {
  if (parts.length < 2 || parts.some((p) => !p.size)) return false
  const row = parts.reduce((s, p) => s + p.size![0], 0) + PLATE_GAP * (parts.length - 1)
  return row <= bed[0] && parts.every((p) => p.size![1] <= bed[1])
}

/** Everything for one design in one archive: STL + STEP + 3MF per part, a shared plate if it fits, and the notes. */
export function makeZip(stem: string, parts: PartOut[], notes: string, bed: [number, number, number]): Uint8Array {
  const files: Record<string, Uint8Array> = {}
  for (const p of parts) {
    if (p.stl) files[`${stem}/${p.name}.stl`] = p.stl
    if (p.step) files[`${stem}/${p.name}.step`] = p.step
    if (p.positions) files[`${stem}/${p.name}.3mf`] = make3mf([p])
  }
  if (fitsOnePlate(parts, bed)) files[`${stem}/${stem}-plate.3mf`] = make3mf(parts)
  files[`${stem}/README.txt`] = new TextEncoder().encode(notes)
  return zipSync(files, { level: 6 })
}
