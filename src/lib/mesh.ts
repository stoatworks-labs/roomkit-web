// Mesh post-processing shared by every exporter: weld OCC's per-face triangulation
// into one indexed mesh, prove it closed, and write STL / 3MF from THAT mesh, so
// the file a visitor downloads is exactly the one the watertight check passed.

import { strToU8, zipSync } from 'fflate'

export interface Mesh {
  positions: Float64Array // xyz per vertex, welded
  indices: Uint32Array // 3 per triangle
  watertight: boolean
  openEdges: number // used by one triangle
  overEdges: number // used by more than two, or twice in the same direction
  area: number // mm2
  volume: number // mm3 (signed-tetrahedron sum; positive for outward normals)
}

/**
 * OCC meshes each B-rep face separately, so vertices on shared edges are duplicated.
 * Weld on a 1e-4 mm grid (OCC's own tolerance is 1e-7 m, far finer than a nozzle),
 * drop triangles that collapse, then count edge uses.
 */
export function weld(vertices: ArrayLike<number>, triangles: ArrayLike<number>, grid = 1e-4): Mesh {
  const key = new Map<string, number>()
  const remap = new Uint32Array(vertices.length / 3)
  const pos: number[] = []
  for (let i = 0; i < vertices.length / 3; i++) {
    const x = vertices[3 * i]
    const y = vertices[3 * i + 1]
    const z = vertices[3 * i + 2]
    const k = `${Math.round(x / grid)},${Math.round(y / grid)},${Math.round(z / grid)}`
    let j = key.get(k)
    if (j === undefined) {
      j = pos.length / 3
      key.set(k, j)
      pos.push(x, y, z)
    }
    remap[i] = j
  }
  const idx: number[] = []
  for (let t = 0; t < triangles.length; t += 3) {
    const a = remap[triangles[t]]
    const b = remap[triangles[t + 1]]
    const c = remap[triangles[t + 2]]
    if (a === b || b === c || a === c) continue
    idx.push(a, b, c)
  }

  // Closed and consistently oriented: every directed edge a->b appears once and its
  // twin b->a appears once. (An undirected count alone passes a flipped face.)
  const directed = new Map<number, number>()
  const nV = pos.length / 3
  const dkey = (a: number, b: number) => a * nV + b
  for (let t = 0; t < idx.length; t += 3) {
    for (let e = 0; e < 3; e++) {
      const a = idx[t + e]
      const b = idx[t + ((e + 1) % 3)]
      directed.set(dkey(a, b), (directed.get(dkey(a, b)) ?? 0) + 1)
    }
  }
  let openEdges = 0
  let overEdges = 0
  for (const [k, n] of directed) {
    const a = Math.floor(k / nV)
    const b = k % nV
    if (n > 1) overEdges++
    if (!directed.has(dkey(b, a))) openEdges++
  }

  let area = 0
  let volume = 0
  for (let t = 0; t < idx.length; t += 3) {
    const [ax, ay, az] = [pos[3 * idx[t]], pos[3 * idx[t] + 1], pos[3 * idx[t] + 2]]
    const [bx, by, bz] = [pos[3 * idx[t + 1]], pos[3 * idx[t + 1] + 1], pos[3 * idx[t + 1] + 2]]
    const [cx, cy, cz] = [pos[3 * idx[t + 2]], pos[3 * idx[t + 2] + 1], pos[3 * idx[t + 2] + 2]]
    const ux = bx - ax, uy = by - ay, uz = bz - az
    const vx = cx - ax, vy = cy - ay, vz = cz - az
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx
    area += Math.hypot(nx, ny, nz) / 2
    volume += (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6
  }

  return {
    positions: Float64Array.from(pos),
    indices: Uint32Array.from(idx),
    watertight: openEdges === 0 && overEdges === 0 && idx.length > 0,
    openEdges,
    overEdges,
    area,
    volume,
  }
}

export function toBinaryStl(m: Mesh, name: string): Uint8Array {
  const nTri = m.indices.length / 3
  const buf = new ArrayBuffer(84 + 50 * nTri)
  const dv = new DataView(buf)
  const header = `roomkit ${name}`.slice(0, 79)
  for (let i = 0; i < header.length; i++) dv.setUint8(i, header.charCodeAt(i) & 0x7f)
  dv.setUint32(80, nTri, true)
  let o = 84
  const p = m.positions
  for (let t = 0; t < nTri; t++) {
    const ia = 3 * m.indices[3 * t], ib = 3 * m.indices[3 * t + 1], ic = 3 * m.indices[3 * t + 2]
    const ux = p[ib] - p[ia], uy = p[ib + 1] - p[ia + 1], uz = p[ib + 2] - p[ia + 2]
    const vx = p[ic] - p[ia], vy = p[ic + 1] - p[ia + 1], vz = p[ic + 2] - p[ia + 2]
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx
    const l = Math.hypot(nx, ny, nz) || 1
    nx /= l; ny /= l; nz /= l
    for (const v of [nx, ny, nz]) { dv.setFloat32(o, v, true); o += 4 }
    for (const i of [ia, ib, ic]) {
      dv.setFloat32(o, p[i], true)
      dv.setFloat32(o + 4, p[i + 1], true)
      dv.setFloat32(o + 8, p[i + 2], true)
      o += 12
    }
    dv.setUint16(o, 0, true)
    o += 2
  }
  return new Uint8Array(buf)
}

const esc = (s: string) => s.replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c]!)

/**
 * A 3MF core-spec package: one object per part, each placed on the plate in a row
 * with `gap` mm between them, so a multi-part set (tray + lid + neck) opens in
 * Bambu Studio / PrusaSlicer / Cura as one plate. Objects are dropped to z=0.
 */
export function to3mf(parts: { name: string; mesh: { positions: ArrayLike<number>; indices: ArrayLike<number> } }[], gap = 10): Uint8Array {
  const objects: string[] = []
  const items: string[] = []
  let xCursor = 0
  parts.forEach((part, i) => {
    const p = part.mesh.positions
    let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity
    for (let k = 0; k < p.length; k += 3) {
      minX = Math.min(minX, p[k]); maxX = Math.max(maxX, p[k])
      minY = Math.min(minY, p[k + 1]); minZ = Math.min(minZ, p[k + 2])
    }
    const verts: string[] = []
    for (let k = 0; k < p.length; k += 3) {
      verts.push(`<vertex x="${fmt(p[k] - minX)}" y="${fmt(p[k + 1] - minY)}" z="${fmt(p[k + 2] - minZ)}"/>`)
    }
    const tris: string[] = []
    const ix = part.mesh.indices
    for (let t = 0; t < ix.length; t += 3) tris.push(`<triangle v1="${ix[t]}" v2="${ix[t + 1]}" v3="${ix[t + 2]}"/>`)
    const id = i + 1
    objects.push(
      `<object id="${id}" name="${esc(part.name)}" type="model"><mesh><vertices>${verts.join('')}</vertices><triangles>${tris.join('')}</triangles></mesh></object>`,
    )
    items.push(`<item objectid="${id}" transform="1 0 0 0 1 0 0 0 1 ${fmt(xCursor)} 0 0"/>`)
    xCursor += maxX - minX + gap
  })
  const model =
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">' +
    '<metadata name="Application">roomkit</metadata>' +
    `<resources>${objects.join('')}</resources><build>${items.join('')}</build></model>`
  const contentTypes =
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>' +
    '</Types>'
  const rels =
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>' +
    '</Relationships>'
  return zipSync({
    '[Content_Types].xml': strToU8(contentTypes),
    '_rels/.rels': strToU8(rels),
    '3D/3dmodel.model': strToU8(model),
  })
}

const fmt = (x: number) => {
  const s = x.toFixed(5)
  return s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s
}
