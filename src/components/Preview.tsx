import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'

export interface PreviewPart {
  name: string
  positions: Float32Array
  indices: Uint32Array
}

// Parts are laid out in a row with a gap, exactly as the 3MF places them on the
// plate, so what you see here is what the slicer opens. Z-up, like the printer.
export function Preview({ parts, gap = 10 }: { parts: PreviewPart[]; gap?: number }) {
  const host = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = host.current
    if (!el || !parts.length) return
    const css = getComputedStyle(document.documentElement)
    const color = (v: string, fallback: string) => new THREE.Color(css.getPropertyValue(v).trim() || fallback)

    const renderer = new THREE.WebGLRenderer({ antialias: true })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    el.appendChild(renderer.domElement)
    const scene = new THREE.Scene()
    scene.background = color('--surface', '#fcfcfb')
    THREE.Object3D.DEFAULT_UP.set(0, 0, 1)
    const camera = new THREE.PerspectiveCamera(35, 1, 1, 20000)
    camera.up.set(0, 0, 1)

    const group = new THREE.Group()
    let x = 0
    const accent = color('--accent', '#2a78d6')
    for (const p of parts) {
      const g = new THREE.BufferGeometry()
      g.setAttribute('position', new THREE.BufferAttribute(p.positions, 3))
      g.setIndex(new THREE.BufferAttribute(p.indices, 1))
      g.computeBoundingBox()
      const bb = g.boundingBox!
      g.translate(x - bb.min.x, -bb.min.y, -bb.min.z)
      // Welded mesh shares corner vertices across faces; flat shading keeps edges crisp.
      const flat = g.toNonIndexed()
      flat.computeVertexNormals()
      const mesh = new THREE.Mesh(flat, new THREE.MeshStandardMaterial({ color: accent, roughness: 0.6, metalness: 0.05, flatShading: true }))
      group.add(mesh)
      const edges = new THREE.LineSegments(new THREE.EdgesGeometry(g, 30), new THREE.LineBasicMaterial({ color: color('--text', '#0b0b0b'), transparent: true, opacity: 0.25 }))
      group.add(edges)
      x += bb.max.x - bb.min.x + gap
    }
    scene.add(group)
    const box = new THREE.Box3().setFromObject(group)
    const size = box.getSize(new THREE.Vector3())
    const centre = box.getCenter(new THREE.Vector3())
    const grid = new THREE.GridHelper(Math.max(size.x, size.y) * 1.4, 14, color('--plane', '#8a8984'), color('--grid', '#ecebe7'))
    grid.rotateX(Math.PI / 2)
    grid.position.set(centre.x, centre.y, -0.1)
    scene.add(grid)

    scene.add(new THREE.HemisphereLight(0xffffff, 0x444444, 1.6))
    const sun = new THREE.DirectionalLight(0xffffff, 1.6)
    sun.position.set(-1, -2, 3)
    scene.add(sun)

    const radius = size.length() / 2
    const dist = radius / Math.sin((camera.fov * Math.PI) / 360) * 1.05
    camera.position.copy(centre).add(new THREE.Vector3(0.55, -1, 0.75).normalize().multiplyScalar(dist))
    camera.near = dist / 100
    camera.far = dist * 10
    const controls = new OrbitControls(camera, renderer.domElement)
    controls.target.copy(centre)
    controls.enableDamping = true

    let raf = 0
    const resize = () => {
      const w = el.clientWidth
      const h = el.clientHeight
      renderer.setSize(w, h, false)
      camera.aspect = w / Math.max(h, 1)
      camera.updateProjectionMatrix()
    }
    const ro = new ResizeObserver(resize)
    ro.observe(el)
    resize()
    const tick = () => {
      controls.update()
      renderer.render(scene, camera)
      raf = requestAnimationFrame(tick)
    }
    tick()

    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
      controls.dispose()
      scene.traverse((o) => {
        const m = o as THREE.Mesh
        m.geometry?.dispose()
        const mat = m.material as THREE.Material | undefined
        mat?.dispose()
      })
      renderer.dispose()
      el.removeChild(renderer.domElement)
    }
  }, [parts, gap])

  return <div className="preview3d" ref={host} aria-label="3D preview of the printed parts; drag to orbit, scroll to zoom" role="img" />
}
