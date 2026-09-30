import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { axialModes, fmtHz, isPrime, parseRew, rewPeaks, solve, MIN_PROTRUDE, type Design, type Peak, type Vec3 } from './lib/acoustics'
import { run, warmUp } from './lib/client'
import { MIME, fitsOnePlate, make3mf, makeZip, save } from './lib/download'
import type { PartOut } from './worker'
import { Preview } from './components/Preview'

type Tab = 'traps' | 'diffusers'

export function App() {
  const [tab, setTab] = useState<Tab>(() => (location.hash === '#diffusers' ? 'diffusers' : 'traps'))
  const [engine, setEngine] = useState<number | null>(null)
  const [bed, setBed] = useState<Vec3>([300, 300, 300])
  const [step, setStep] = useState(true)

  useEffect(() => warmUp(setEngine), [])
  useEffect(() => {
    const onHash = () => setTab(location.hash === '#diffusers' ? 'diffusers' : 'traps')
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])
  useEffect(() => {
    history.replaceState(null, '', tab === 'diffusers' ? '#diffusers' : location.pathname + location.search)
  }, [tab])

  return (
    <div className="app">
      <header className="top">
        <div className="brand">
          <h1>roomkit</h1>
          <span className="preview">preview</span>
          <span className="tag">Printable bass traps and diffusers, tuned to your room</span>
        </div>
        <div className="top-actions">
          <span className="small muted engine" title="OpenCascade geometry kernel, running in your browser">
            {engine == null ? 'Loading CAD kernel…' : 'CAD kernel ready'}
          </span>
          <button className="btn ghost" data-stoatworks-about type="button">About</button>
        </div>
      </header>

      <nav className="tabs" role="tablist">
        <button role="tab" aria-selected={tab === 'traps'} className={tab === 'traps' ? 'on' : ''} onClick={() => setTab('traps')}>
          Helmholtz bass traps
        </button>
        <button role="tab" aria-selected={tab === 'diffusers'} className={tab === 'diffusers' ? 'on' : ''} onClick={() => setTab('diffusers')}>
          QRD diffusers
        </button>
      </nav>

      <div className="printer-bar">
        <span className="label">Printer bed</span>
        <Vec3Input value={bed} onChange={setBed} labels={['W', 'D', 'H']} unit="mm" min={50} />
        <label className="check">
          <input type="checkbox" checked={step} onChange={(e) => setStep(e.target.checked)} />
          <span>Also export STEP (for editing in CAD)</span>
        </label>
      </div>

      {tab === 'traps' ? <Traps bed={bed} step={step} /> : <Diffusers bed={bed} step={step} />}

      <footer className="foot small muted">
        Geometry is built and checked in your browser with OpenCascade; nothing you enter or upload leaves this page.
        The acoustics are textbook models (lumped Helmholtz with end corrections; Schroeder QRD). None of these designs has
        been printed and measured yet — measure yours before you trust it.
      </footer>
    </div>
  )
}

// --------------------------------------------------------------------------- inputs

function Num(props: { label: string; value: number; onChange: (v: number) => void; step?: number; min?: number; max?: number; unit?: string; hint?: string }) {
  const [text, setText] = useState(String(props.value))
  useEffect(() => setText(String(props.value)), [props.value])
  return (
    <label className="field">
      <span className="label">
        {props.label}
        {props.unit ? <span className="muted"> ({props.unit})</span> : null}
      </span>
      <input
        type="number"
        inputMode="decimal"
        value={text}
        step={props.step ?? 'any'}
        min={props.min}
        max={props.max}
        onChange={(e) => {
          setText(e.target.value)
          const v = Number(e.target.value)
          if (e.target.value !== '' && Number.isFinite(v)) props.onChange(v)
        }}
      />
      {props.hint ? <span className="hint">{props.hint}</span> : null}
    </label>
  )
}

function Vec3Input({ value, onChange, labels, unit, min }: { value: Vec3; onChange: (v: Vec3) => void; labels: string[]; unit: string; min?: number }) {
  return (
    <span className="vec">
      {value.map((v, i) => (
        <label key={i} className="vec-cell">
          <span className="muted small">{labels[i]}</span>
          <input
            type="number"
            inputMode="decimal"
            min={min}
            defaultValue={v}
            aria-label={`${labels[i]} (${unit})`}
            onChange={(e) => {
              const n = Number(e.target.value)
              if (e.target.value !== '' && Number.isFinite(n) && n > 0) {
                const next = [...value] as Vec3
                next[i] = n
                onChange(next)
              }
            }}
          />
        </label>
      ))}
      <span className="muted small">{unit}</span>
    </span>
  )
}

function Section({ title, children, aside }: { title: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <section className="section">
      <div className="section-head">
        <h3>{title}</h3>
        {aside}
      </div>
      {children}
    </section>
  )
}

// --------------------------------------------------------------------------- traps

interface Target {
  f: number
  src: string
}

type BuildState =
  | { state: 'building' }
  | { state: 'error'; message: string }
  | { state: 'done'; sig: string; parts: PartOut[]; builtF: number; builtErr: number; builtCavityL: number; ok: boolean; ms: number }

function parseFreqs(s: string): { freqs: number[]; bad: string[] } {
  const freqs: number[] = []
  const bad: string[] = []
  for (const tok of s.split(/[\s,;]+/).filter(Boolean)) {
    const v = Number(tok.replace(/hz$/i, ''))
    if (Number.isFinite(v) && v >= 10 && v <= 2000) freqs.push(v)
    else bad.push(tok)
  }
  return { freqs, bad }
}

function Traps({ bed, step }: { bed: Vec3; step: boolean }) {
  const [freqText, setFreqText] = useState('42, 71')
  const [rew, setRew] = useState<{ name: string; fr: number[]; spl: number[] } | null>(null)
  const [rewError, setRewError] = useState<string | null>(null)
  const [room, setRoom] = useState<Vec3>([5.2, 4.1, 2.6])
  const [useRoom, setUseRoom] = useState(false)
  const [modesAsTargets, setModesAsTargets] = useState(false)
  const [fmin, setFmin] = useState(30)
  const [fmax, setFmax] = useState(150)
  const [prominence, setProminence] = useState(4)
  const [footW, setFootW] = useState(280)
  const [footD, setFootD] = useState(280)
  const [wall, setWall] = useState(4)
  const [maxDepth, setMaxDepth] = useState(200)
  const [marginPct, setMarginPct] = useState(12)
  const [builds, setBuilds] = useState<Record<string, BuildState>>({})

  const { freqs, bad } = useMemo(() => parseFreqs(freqText), [freqText])
  const peaks: Peak[] = useMemo(() => (rew ? rewPeaks(rew.fr, rew.spl, fmin, fmax, prominence) : []), [rew, fmin, fmax, prominence])
  const modes = useMemo(() => (useRoom ? axialModes(room, fmax) : []), [useRoom, room, fmax])

  const targets: Target[] = useMemo(() => {
    const t: Target[] = freqs.map((f) => ({ f, src: 'given' }))
    if (useRoom && modesAsTargets) for (const m of modes) if (m.f >= fmin) t.push({ f: m.f, src: m.label })
    for (const p of peaks) t.push({ f: p.f, src: `REW +${p.db.toFixed(1)} dB` })
    return t.sort((a, b) => a.f - b.f)
  }, [freqs, useRoom, modesAsTargets, modes, peaks, fmin])

  const footprintFits = footW <= bed[0] && footD <= bed[1]
  const maxH = Math.min(maxDepth, bed[2] + wall)
  const designs = useMemo(
    () => targets.map((t) => ({ t, des: footprintFits ? solve(t.f, [footW, footD], maxH, wall, marginPct / 100) : null })),
    [targets, footW, footD, maxH, wall, marginPct, footprintFits],
  )

  async function loadRew(file: File) {
    try {
      const { fr, spl } = parseRew(await file.text())
      setRew({ name: file.name, fr, spl })
      setRewError(null)
    } catch (e) {
      setRew(null)
      setRewError(`${file.name}: ${(e as Error).message}`)
    }
  }

  async function loadExample() {
    const res = await fetch('examples/synthetic-rew.txt')
    const { fr, spl } = parseRew(await res.text())
    setRew({ name: 'synthetic-rew.txt (example: peaks at 42/71/118/250 Hz)', fr, spl })
    setFmax(300)
    setRewError(null)
  }

  const sigOf = (d: Design) => JSON.stringify([d.outer, d.r, d.printLen.toFixed(4), d.tubeLen.toFixed(4), bed, step])

  async function build(key: string, des: Design) {
    setBuilds((b) => ({ ...b, [key]: { state: 'building' } }))
    try {
      const r = await run({
        kind: 'helmholtz',
        design: { fTarget: des.fTarget, outer: des.outer, wall: des.wall, r: des.r, tubeLen: des.tubeLen, printLen: des.printLen },
        bed,
        step,
      })
      if (r.kind !== 'helmholtz') throw new Error('unexpected reply')
      setBuilds((b) => ({ ...b, [key]: { state: 'done', sig: sigOf(des), parts: r.parts, builtF: r.builtF, builtErr: r.builtErr, builtCavityL: r.builtCavityL, ok: r.ok, ms: r.ms } }))
    } catch (e) {
      setBuilds((b) => ({ ...b, [key]: { state: 'error', message: (e as Error).message } }))
    }
  }

  return (
    <main className="layout">
      <aside className="panel">
        <Section title="Target frequencies">
          <label className="field">
            <span className="label">Frequencies (Hz)</span>
            <input type="text" value={freqText} onChange={(e) => setFreqText(e.target.value)} placeholder="e.g. 42, 71, 88" />
            {bad.length ? <span className="hint warn-ink">Ignored: {bad.join(', ')} (10–2000 Hz)</span> : null}
          </label>
        </Section>

        <Section title="From a REW measurement">
          <p className="small muted">
            In REW: <em>File → Export → Export measurement as text</em>. Peaks that stand {prominence} dB over a one-octave running
            median become targets. The frequencies are exact; the dB figure only ranks them.
          </p>
          <div className="row-gap">
            <label className="btn file">
              Choose .txt…
              <input type="file" accept=".txt,.csv,text/plain" onChange={(e) => e.target.files?.[0] && loadRew(e.target.files[0])} />
            </label>
            <button className="btn ghost" type="button" onClick={loadExample}>Try the example</button>
            {rew ? <button className="btn ghost" type="button" onClick={() => setRew(null)}>Clear</button> : null}
          </div>
          {rew ? <p className="small">{rew.name}: {peaks.length} peak{peaks.length === 1 ? '' : 's'} in range</p> : null}
          {rewError ? <div className="banner error-inline small">{rewError}</div> : null}
        </Section>

        <Section title="From room dimensions">
          <label className="check">
            <input type="checkbox" checked={useRoom} onChange={(e) => setUseRoom(e.target.checked)} />
            <span>List the axial modes of my room</span>
          </label>
          {useRoom ? (
            <>
              <Vec3Input value={room} onChange={setRoom} labels={['L', 'W', 'H']} unit="m" />
              <label className="check">
                <input type="checkbox" checked={modesAsTargets} onChange={(e) => setModesAsTargets(e.target.checked)} />
                <span>Design a trap for every mode ≥ {fmin} Hz</span>
              </label>
            </>
          ) : null}
        </Section>

        <Section title="Search range">
          <div className="field row">
            <Num label="From" unit="Hz" value={fmin} onChange={setFmin} min={10} />
            <Num label="To" unit="Hz" value={fmax} onChange={setFmax} min={20} />
            <Num label="Peak" unit="dB" value={prominence} onChange={setProminence} min={0.5} step={0.5} />
          </div>
        </Section>

        <Section title="Module">
          <div className="field row">
            <Num label="Footprint W" unit="mm" value={footW} onChange={setFootW} min={80} />
            <Num label="D" unit="mm" value={footD} onChange={setFootD} min={80} />
          </div>
          <div className="field row">
            <Num label="Max depth" unit="mm" value={maxDepth} onChange={setMaxDepth} min={50} hint="off the wall" />
            <Num label="Wall" unit="mm" value={wall} onChange={setWall} min={2} step={0.5} />
          </div>
          <Num label="Neck trim margin" unit="%" value={marginPct} onChange={setMarginPct} min={0} max={40} hint="printed this much long, then trimmed to tune" />
          {!footprintFits ? <div className="banner warn small">The footprint is larger than the printer bed.</div> : null}
        </Section>
      </aside>

      <div className="results">
        {useRoom && modes.length ? <ModesTable modes={modes} /> : null}
        {designs.length === 0 ? (
          <div className="empty">
            <h2>No targets yet</h2>
            <p>Type a frequency, load a REW measurement, or tick “Design a trap for every mode”.</p>
          </div>
        ) : (
          designs.map(({ t, des }) => {
            const key = `${t.f.toFixed(3)}|${t.src}`
            return <TrapCard key={key} target={t} des={des} build={builds[key]} sig={des ? sigOf(des) : ''} onBuild={() => des && build(key, des)} footprint={[footW, footD]} maxH={maxH} bed={bed} />
          })
        )}
        <AssemblyNotes />
      </div>
    </main>
  )
}

function ModesTable({ modes }: { modes: { f: number; label: string }[] }) {
  return (
    <div className="card">
      <h3>Axial room modes</h3>
      <p className="small muted">The strongest family. Tangential and oblique modes are not listed.</p>
      <div className="modes">
        {modes.map((m, i) => (
          <span key={i} className="mode">
            <strong>{m.f.toFixed(1)} Hz</strong> <span className="muted">{m.label}</span>
          </span>
        ))}
      </div>
    </div>
  )
}

function trapNotes(des: Design): string {
  const [w, d, h] = des.outer
  const table = des.trimTable().map((r) => `  ${r.len.toFixed(1).padStart(6)} mm  ->  ${r.f.toFixed(1)} Hz`).join('\n')
  return `roomkit Helmholtz bass trap, ${des.fTarget.toFixed(1)} Hz
Generated by https://roomkit.stoatworks-labs.com — an untested design: measure before you rely on it.

Assembled box   ${w} x ${d} x ${h} mm outer, ${(des.cavityVolume(des.tubeLen) / 1e6).toFixed(2)} L of air
Neck            ${(2 * des.r).toFixed(0)} mm bore, tube ${des.tubeLen.toFixed(1)} mm solved, printed ${des.printLen.toFixed(1)} mm
As printed it tunes to ${des.fAt(des.printLen).toFixed(1)} Hz (low on purpose). Trim the INNER end of the tube:
${table}

Parts (print each in the orientation it is exported in):
  tray  open box, open side up
  lid   plate face-down, alignment lip up
  neck  flange down

Print and assemble:
  - 4+ perimeters, solid top/bottom; the box must be airtight and stiff or the tuning and Q go soft.
  - Seal the inside with paint or thin epoxy. Silicone or glue the lid on.
  - Push the neck through the lid from outside (flange on the outside face).
  - Optional: a layer of mineral wool or felt inside, clear of the neck mouth. It widens the band
    the trap absorbs and pulls the tuning slightly lower, which the trim margin allows for.
  - Tune: sine sweep with a mic at the neck mouth (or measure in the room), then trim the tube.
  - Place where the mode's pressure is highest: room corners for most modes; the wall-floor
    junction for height modes.
`
}

function TrapCard({ target, des, build, sig, onBuild, footprint, maxH, bed }: { target: Target; des: Design | null; build?: BuildState; sig: string; onBuild: () => void; footprint: [number, number]; maxH: number; bed: Vec3 }) {
  if (!des) {
    return (
      <div className="card">
        <div className="card-head">
          <h2>{target.f.toFixed(1)} Hz <span className="src">{target.src}</span></h2>
        </div>
        <div className="banner warn">
          No module fits: it needs more volume than {footprint[0]} × {footprint[1]} × {maxH} mm. Use a bigger footprint or depth, two
          modules sharing the load, or a panel absorber.
        </div>
      </div>
    )
  }
  const [w, d, h] = des.outer
  const stale = build?.state === 'done' && build.sig !== sig
  const stem = `helmholtz-${des.fTarget.toFixed(0)}Hz`
  return (
    <div className="card">
      <div className="card-head">
        <h2>
          {target.f.toFixed(1)} Hz <span className="src">{target.src}</span>
        </h2>
        <button className="btn primary" type="button" onClick={onBuild} disabled={build?.state === 'building'}>
          {build?.state === 'building' ? 'Building…' : build?.state === 'done' && !stale ? 'Rebuild' : 'Build printable parts'}
        </button>
      </div>
      <dl className="facts">
        <div><dt>Box (outer)</dt><dd>{w} × {d} × {h} mm</dd></div>
        <div><dt>Air volume</dt><dd>{(des.cavityVolume(des.tubeLen) / 1e6).toFixed(2)} L</dd></div>
        <div><dt>Neck bore</dt><dd>{(2 * des.r).toFixed(0)} mm</dd></div>
        <div><dt>Tube, solved</dt><dd>{des.tubeLen.toFixed(1)} mm <span className="muted">(protrudes {(des.tubeLen - des.wall).toFixed(1)})</span></dd></div>
        <div><dt>Tube, printed</dt><dd>{des.printLen.toFixed(1)} mm → {des.fAt(des.printLen).toFixed(1)} Hz</dd></div>
      </dl>
      <details className="trim">
        <summary>Trim table — cut the inner end of the tube to walk the resonance up</summary>
        <table>
          <thead><tr><th>Tube length</th><th>Tunes to</th></tr></thead>
          <tbody>
            {des.trimTable().map((r, i) => (
              <tr key={i} className={Math.abs(r.len - des.tubeLen) < 0.05 ? 'hit' : ''}>
                <td>{r.len.toFixed(1)} mm</td>
                <td>{r.f.toFixed(1)} Hz</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="small muted">Never shorter than {(des.wall + MIN_PROTRUDE).toFixed(0)} mm: the tube must stand into the cavity.</p>
      </details>

      {build?.state === 'error' ? <div className="banner error-inline">Build failed: {build.message}</div> : null}
      {build?.state === 'done' ? (
        <>
          {stale ? <div className="banner warn small">Settings changed since this build — rebuild before downloading.</div> : null}
          <BuildResult
            parts={build.parts}
            ok={build.ok}
            ms={build.ms}
            stem={stem}
            notes={trapNotes(des)}
            bed={bed}
            extra={
              <p className={`small ${build.builtErr > 0.005 ? 'err-ink' : 'muted'}`}>
                Built-geometry check: the assembled parts hold {build.builtCavityL.toFixed(3)} L of air → {build.builtF.toFixed(2)} Hz at the
                solved length ({(build.builtErr * 100).toFixed(2)}% off target{build.builtErr > 0.005 ? ' — FAIL, over 0.5%' : ''}).
              </p>
            }
            disabled={stale}
          />
        </>
      ) : null}
    </div>
  )
}

function AssemblyNotes() {
  return (
    <details className="card notes">
      <summary><h3>How the traps work, and how to build one</h3></summary>
      <p>
        Each module is a sealed box with one open tube — a Helmholtz resonator. The air in the tube bounces on the spring of the air
        in the box at one frequency, f = c/2π · √(S / (V · L<sub>eff</sub>)), and soaks up room energy there. The solver picks the
        widest neck that reaches your frequency within the depth you allow: a wide neck in a big box couples to the room far better
        than a pinhole in a flat box tuned to the same note.
      </p>
      <p>
        The neck is printed longer than solved, so the module starts out tuned low. Measure it, then trim the inner end of the tube
        using the trim table. Every module downloads as three prints: tray, lid and neck.
      </p>
      <ul>
        <li>Airtight and stiff: 4+ perimeters, seal the inside with paint or thin epoxy, silicone the lid.</li>
        <li>Mineral wool inside, clear of the neck, widens the band and lowers the Q.</li>
        <li>Place traps where the mode's pressure peaks: corners for most modes, the wall-floor junction for height modes.</li>
        <li>No printed porous absorbers here on purpose: FDM pores are 10–100× wider than the air's viscous layer, so a printed lattice is mostly transparent. Use mineral wool for broadband absorption.</li>
      </ul>
    </details>
  )
}

// --------------------------------------------------------------------------- diffusers

type DKind = 'skyline' | 'qrd'
type DState =
  | { state: 'building' }
  | { state: 'error'; message: string }
  | { state: 'done'; sig: string; parts: PartOut[]; f0: number; fMax: number; summary: string[]; heights: number[][]; ok: boolean; ms: number }

function Diffusers({ bed, step }: { bed: Vec3; step: boolean }) {
  const [kind, setKind] = useState<DKind>('skyline')
  const [n, setN] = useState(7)
  const [by, setBy] = useState<'f0' | 'depth'>('f0')
  const [f0Sky, setF0Sky] = useState(800)
  const [f0Qrd, setF0Qrd] = useState(500)
  const [depth, setDepth] = useState(150)
  const [base, setBase] = useState(4)
  const [mode, setMode] = useState<'open-back' | 'solid'>('open-back')
  const [wall, setWall] = useState(1.6)
  const [cap, setCap] = useState(1.6)
  const [minHollow, setMinHollow] = useState(12)
  const [cell, setCell] = useState(40)
  const [well, setWell] = useState(36)
  const [fin, setFin] = useState(2.4)
  const [length, setLength] = useState(280)
  const [result, setResult] = useState<DState | null>(null)

  const f0 = kind === 'skyline' ? f0Sky : f0Qrd
  const common = { n, f0: by === 'f0' ? f0 : null, depth: by === 'depth' ? depth : null, base, mode, wall, cap, minHollow }
  const params = kind === 'skyline' ? { ...common, cell } : { ...common, well, fin, length }
  const sig = JSON.stringify([kind, params, bed, step])

  const prime = isPrime(n)
  const footprint = kind === 'skyline' ? [n * cell, n * cell] : [n * (well + fin) + fin, length]
  const fits = footprint[0] <= bed[0] && footprint[1] <= bed[1]
  const problems: string[] = []
  if (!prime) problems.push(`N must be prime for a quadratic-residue sequence (${n} is not).`)
  if (!fits) problems.push(`The tile is ${footprint.map((x) => x.toFixed(0)).join(' × ')} mm — larger than the bed.`)
  if (mode === 'open-back' && kind === 'skyline' && wall / 2 - 0.2 <= 0) problems.push('Wall must be over 0.4 mm.')

  async function build() {
    setResult({ state: 'building' })
    try {
      const r = kind === 'skyline'
        ? await run({ kind: 'skyline', params: { ...common, cell }, bed, step })
        : await run({ kind: 'qrd', params: { ...common, well, fin, length }, bed, step })
      if (r.kind === 'helmholtz') throw new Error('unexpected reply')
      setResult({ state: 'done', sig, parts: r.parts, f0: r.f0, fMax: r.fMax, summary: r.summary, heights: r.heights, ok: r.ok, ms: r.ms })
    } catch (e) {
      setResult({ state: 'error', message: (e as Error).message })
    }
  }

  const stale = result?.state === 'done' && result.sig !== sig
  return (
    <main className="layout">
      <aside className="panel">
        <Section title="Type">
          <div className="seg" role="radiogroup">
            <button type="button" className={kind === 'skyline' ? 'on' : ''} onClick={() => setKind('skyline')} aria-pressed={kind === 'skyline'}>Skyline (2D)</button>
            <button type="button" className={kind === 'qrd' ? 'on' : ''} onClick={() => setKind('qrd')} aria-pressed={kind === 'qrd'}>QRD wells (1D)</button>
          </div>
          <p className="small muted">
            {kind === 'skyline'
              ? 'N × N square pillars, height ∝ (x² + y²) mod N. Scatters in both directions.'
              : 'N parallel wells, depth ∝ n² mod N, separated by fins. Scatters across the wells only.'}
          </p>
        </Section>
        <Section title="Acoustics">
          <Num label="N (prime)" value={n} onChange={(v) => setN(Math.round(v))} min={3} step={2} hint={prime ? undefined : 'must be prime: 5, 7, 11, 13…'} />
          <div className="seg small-seg">
            <button type="button" className={by === 'f0' ? 'on' : ''} onClick={() => setBy('f0')}>Set design frequency</button>
            <button type="button" className={by === 'depth' ? 'on' : ''} onClick={() => setBy('depth')}>Set max depth</button>
          </div>
          {by === 'f0' ? (
            <Num label="Design frequency f0" unit="Hz" value={f0} onChange={kind === 'skyline' ? setF0Sky : setF0Qrd} min={100} hint="lowest frequency it scatters" />
          ) : (
            <Num label="Deepest well / tallest pillar" unit="mm" value={depth} onChange={setDepth} min={10} />
          )}
        </Section>
        <Section title="Geometry">
          {kind === 'skyline' ? (
            <Num label="Cell (pillar) width" unit="mm" value={cell} onChange={setCell} min={10} />
          ) : (
            <>
              <div className="field row">
                <Num label="Well width" unit="mm" value={well} onChange={setWell} min={10} />
                <Num label="Fin" unit="mm" value={fin} onChange={setFin} min={0.8} step={0.2} />
              </div>
              <Num label="Well length" unit="mm" value={length} onChange={setLength} min={20} hint="tile depth on the bed" />
            </>
          )}
          <Num label="Back plate" unit="mm" value={base} onChange={setBase} min={1} step={0.5} />
        </Section>
        <Section title="Build">
          <div className="seg small-seg">
            <button type="button" className={mode === 'open-back' ? 'on' : ''} onClick={() => setMode('open-back')}>Open back</button>
            <button type="button" className={mode === 'solid' ? 'on' : ''} onClick={() => setMode('solid')}>Solid</button>
          </div>
          <p className="small muted">
            {mode === 'open-back'
              ? 'Tall pillars/floors are thin tubes with a capped top, open through the base. Fill the back with plaster, sand or expanding foam and glue on a backer board: heavier and deader than infill, far less filament.'
              : 'A closed body; the slicer chooses walls and infill. Simple, uses the most filament, and big PLA shells can ring.'}
          </p>
          {mode === 'open-back' ? (
            <div className="field row">
              <Num label="Wall" unit="mm" value={wall} onChange={setWall} min={0.8} step={0.2} />
              <Num label="Cap" unit="mm" value={cap} onChange={setCap} min={0.8} step={0.2} />
              <Num label="Hollow if ≥" unit="mm" value={minHollow} onChange={setMinHollow} min={2} />
            </div>
          ) : null}
        </Section>
      </aside>

      <div className="results">
        <div className="card">
          <div className="card-head">
            <h2>{kind === 'skyline' ? `Skyline ${n}×${n}` : `QRD, ${n} wells`}</h2>
            <button className="btn primary" type="button" onClick={build} disabled={problems.length > 0 || result?.state === 'building'}>
              {result?.state === 'building' ? 'Building…' : 'Build printable tile'}
            </button>
          </div>
          <dl className="facts">
            <div><dt>Tile</dt><dd>{footprint.map((x) => x.toFixed(0)).join(' × ')} mm</dd></div>
            <div><dt>Works from</dt><dd>{by === 'f0' ? fmtHz(f0) : 'set by depth'}</dd></div>
            <div><dt>Up to about</dt><dd>{fmtHz(343000 / (2 * (kind === 'skyline' ? cell : well)))}</dd></div>
          </dl>
          {problems.map((p) => <div key={p} className="banner warn small">{p}</div>)}
          {kind === 'skyline' && n >= 11 ? <p className="small muted">An {n}×{n} skyline is {n * n} pillars: the build takes a little longer.</p> : null}
          {result?.state === 'error' ? <div className="banner error-inline">Build failed: {result.message}</div> : null}
          {result?.state === 'done' ? (
            <>
              {stale ? <div className="banner warn small">Settings changed since this build — rebuild before downloading.</div> : null}
              <ul className="summary small">{result.summary.map((s) => <li key={s}>{s}</li>)}</ul>
              <HeightTable kind={kind} heights={result.heights} />
              <BuildResult
                parts={result.parts}
                ok={result.ok}
                ms={result.ms}
                stem={result.parts[0].name}
                notes={diffuserNotes(result.summary, mode)}
                bed={bed}
                disabled={stale}
              />
            </>
          ) : null}
        </div>
        <details className="card notes">
          <summary><h3>How the diffusers work</h3></summary>
          <p>
            A quadratic-residue diffuser (Schroeder) is a row of wells whose depths follow s(n) = n² mod N for a prime N. Depth is
            d = s · λ<sub>0</sub> / 2N, where λ<sub>0</sub> is the wavelength of the design frequency. Reflections from the different
            depths leave with different phases and spread out instead of bouncing back as one flat echo. It works from about f0 up to
            where a well is half a wavelength wide (≈ c / 2w); below f0 it behaves like a flat panel.
          </p>
          <p>
            Where two diagonal skyline pillars both stand taller than their neighbours they would touch only along a line, which is not
            printable in principle. Each such corner is bridged with a thin post.
          </p>
        </details>
      </div>
    </main>
  )
}

function HeightTable({ kind, heights }: { kind: DKind; heights: number[][] }) {
  return (
    <details className="trim">
      <summary>{kind === 'skyline' ? 'Pillar heights (mm), row y = 0 first' : 'Well depths (mm)'}</summary>
      <div className="heights">
        <table>
          <tbody>
            {heights.map((row, i) => (
              <tr key={i}>{row.map((h, j) => <td key={j}>{h.toFixed(1)}</td>)}</tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  )
}

function diffuserNotes(summary: string[], mode: string): string {
  return `roomkit diffuser tile
Generated by https://roomkit.stoatworks-labs.com — an untested design: measure before you rely on it.

${summary.join('\n')}

Print base-down.${
    mode === 'open-back'
      ? `
Open back: the tall pillars/well floors are hollow tubes open through the base. After printing,
pour plaster, sand or expanding foam into the back and glue on a backer board.`
      : `
Solid: the slicer chooses walls and infill. Big PLA shells can ring; a denser infill helps.`
  }
Expect roughly 1-1.6 kg of PLA per 280 mm tile.
`
}

// --------------------------------------------------------------------------- shared result

function BuildResult({ parts, ok, ms, stem, notes, bed, extra, disabled }: { parts: PartOut[]; ok: boolean; ms: number; stem: string; notes: string; bed: Vec3; extra?: ReactNode; disabled?: boolean }) {
  const preview = useMemo(
    () => parts.filter((p) => p.positions && p.indices).map((p) => ({ name: p.name, positions: p.positions!, indices: p.indices! })),
    [parts],
  )
  const grams = parts.reduce((s, p) => s + (p.grams ?? 0), 0)
  const dis = disabled || !ok
  const plate = fitsOnePlate(parts, bed)
  return (
    <div className="result">
      {preview.length ? <Preview parts={preview} /> : null}
      <div className={`verdict ${ok ? 'ok' : 'bad'}`}>
        {ok
          ? `All checks passed in ${(ms / 1000).toFixed(1)} s · ~${grams.toFixed(0)} g PLA in total`
          : 'A check failed, so this design is not offered for download. The failing check is listed below.'}
      </div>
      {extra}
      <div className="parts">
        {parts.map((p) => (
          <div key={p.name} className="part">
            <div className="part-head">
              <code>{p.name}</code>
              <span className="part-dl">
                <button className="btn small-btn" type="button" disabled={dis || !p.positions} onClick={() => save(`${p.name}.3mf`, make3mf([p]), MIME['3mf'])}>3MF</button>
                <button className="btn small-btn" type="button" disabled={dis || !p.stl} onClick={() => save(`${p.name}.stl`, p.stl!, MIME.stl)}>STL</button>
                {p.step ? <button className="btn small-btn" type="button" disabled={dis} onClick={() => save(`${p.name}.step`, p.step!, MIME.step)}>STEP</button> : null}
              </span>
            </div>
            <ul className="checks">
              {p.lines.map((l, i) => <li key={i} className={l.startsWith('FAIL') ? 'fail' : ''}>{l}</li>)}
            </ul>
          </div>
        ))}
      </div>
      <div className="row-gap">
        <button className="btn primary" type="button" disabled={dis} onClick={() => save(`${stem}.zip`, makeZip(stem, parts, notes, bed), MIME.zip)}>
          Download everything (.zip)
        </button>
        {plate ? (
          <button className="btn" type="button" disabled={dis} onClick={() => save(`${stem}-plate.3mf`, make3mf(parts), MIME['3mf'])}>
            All parts on one 3MF plate
          </button>
        ) : null}
      </div>
      <p className="small muted">
        The zip holds a 3MF, STL{parts.some((p) => p.step) ? ' and STEP' : ''} for each part plus build notes.
        {parts.length > 1 && !plate ? ' These parts are too big to share one plate, so each is its own print.' : ''} Print each part in the
        orientation it downloads in.
      </p>
    </div>
  )
}
