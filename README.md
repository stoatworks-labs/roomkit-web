# roomkit

> **AI-assisted project.** This codebase was created with [Claude](https://claude.com/claude-code)
> (Anthropic), directed and reviewed by a human author. None of the designs it makes has been
> printed and acoustically measured yet: the geometry is checked, the acoustics are textbook models.

Design 3D-printable room treatment in the browser and download files ready for the slicer:

- **Helmholtz bass traps** tuned to a frequency you type, to the peaks in a
  [REW](https://www.roomeqwizard.com/) measurement, or to your room's axial modes. Each trap is
  three prints (tray, lid, push-in neck). The neck is printed long, with a trim table for
  tuning it after you measure.
- **Quadratic-residue diffusers**: 2D "skyline" tiles and 1D QRD wells, solid or open-backed
  so you can fill them with plaster or sand.

Live at **https://roomkit.stoatworks-labs.com**. Everything runs in your browser: the CAD
kernel is [OpenCascade](https://dev.opencascade.org/) compiled to WebAssembly (via
[replicad](https://replicad.xyz/)), so nothing you enter or upload leaves the page.

Downloads are **3MF** (opens straight into Bambu Studio, PrusaSlicer, Cura), **STL**, and
optionally **STEP** for editing in CAD.

## What it checks before offering a download

Each part is verified from the **built** solid, not from its parameters:

- OpenCascade validity, and that the part is exactly one solid;
- it fits your printer bed, and nothing sits below z = 0;
- its built volume equals the analytic volume (catches a boolean that silently drops
  material);
- material/air probes at known points (the neck bore is open, the floor is solid, …);
- the exported mesh is closed and consistently oriented (every edge shared by exactly two
  triangles, in opposite directions).

For a trap, the tool also reassembles the built tray, lid and neck, measures the air left
in the cavity, and fails the design if that tunes more than 0.5% off target. A part that
fails any check isn't offered for download.

## The acoustics

- **Traps**: f = c/2π · √(S / (V · L<sub>eff</sub>)), L<sub>eff</sub> = L + 0.85r (flanged
  outer end) + 0.61r (unflanged inner end). The solver prefers the widest neck that reaches
  the frequency within the depth you allow. A wide neck in a big box couples to the room far
  better than a pinhole in a flat box tuned to the same note.
- **REW peaks** stand a set number of dB above a one-octave running *median* (a mean
  swallows the modes). The frequencies are exact. The dB figure reads low and is only good
  for ranking the peaks.
- **Diffusers**: depth d = s · λ<sub>0</sub> / 2N for s = n² mod N (1D) or (x² + y²) mod N
  (2D), N prime. They work from about the design frequency up to where a well is half a
  wavelength wide.
- **No printed porous absorbers, on purpose.** FDM pores (0.4–2 mm) are 10–100× wider than
  the air's viscous boundary layer (~0.07 mm at 1 kHz), so a printed lattice is mostly
  transparent. Use mineral wool for broadband absorption.

This is a port of a Python/cadquery generator. `src/lib/fixtures/python-reference.json`
holds that code's numbers and the tests pin the port to them. Built part volumes were also
checked against the cadquery STLs (identical to 0.000%).

## Building a trap

1. Print with 4+ perimeters and solid top/bottom. The box must be airtight and stiff.
2. Seal the inside with paint or thin epoxy. Silicone or glue the lid on.
3. Push the neck through the lid from outside.
4. Optionally, add mineral wool inside, clear of the neck. It widens the absorbed band and
   pulls the tuning a little lower, which the trim margin allows for.
5. Measure, then trim the inner end of the tube using the trim table.
6. Place it where the mode's pressure peaks: corners for most modes, the wall–floor junction
   for height modes.

## Development

```bash
npm install
npm run dev
npm test        # maths vs the Python reference, plus real OpenCascade builds in node
npm run build
```

Deployed by `.github/workflows/deploy.yml` on every push to `main`: a static-assets
Cloudflare Worker on a zone route (see `wrangler.toml`).

`public/_headers` lets the geometry worker, and only it, evaluate strings: OpenCascade's
embind glue needs `new Function`. Without that rule the live site fails while `vite dev`
works. `src/lib/headers.test.ts` guards it.

<!-- attributions:start -->
This project is built on other people's work — see [ATTRIBUTIONS.md](ATTRIBUTIONS.md).
<!-- attributions:end -->

## Licence

MIT (see `LICENSE`). The OpenCascade WebAssembly build (`replicad-opencascadejs`) is
LGPL-2.1 and is shipped unmodified as a separate file.
