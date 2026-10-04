# Attributions

roomkit-web is built on other people's work. This file lists what that work is, who did
it, and what it is doing here.

It is generated — the master lists live in the `stoatworks-backend` repo and are
pushed out by `scripts/sync-attributions.py`. Edit it there, not here.

## Code we derived from other people's work

Someone else solved this first, and this project would not exist in its current form without their work.

### roomkit Python generator — Stoatworks roomkit

Copyright: Stoatworks Labs

roomkit-web is a port of a Python/cadquery generator: src/lib/acoustics.ts is a line-for-line port of roomkit's helmholtz.py and diffuser.py (2bd5aed), and src/lib/geometry.ts ports its common.py and the build() halves of both onto replicad in place of cadquery. src/lib/fixtures/python-reference.json holds that code's numbers and the tests pin the port to them; built part volumes were also checked against the cadquery STLs, identical to 0.000%.

## Third-party code this project uses

Libraries, SDKs and frameworks the project is built on or bundles.

### React

<https://react.dev>  
Licence: MIT  
Copyright: Meta Platforms, Inc. and affiliates

An npm dependency.

The UI layer for the browser tools and the Electron and Tauri front ends.

### The npm ecosystem

<https://www.npmjs.com>  
Licence: predominantly MIT  
Copyright: the individual package authors

npm dependencies, resolved and pinned in the lockfile.

Build tooling, test runners and the libraries the front ends are assembled from. The exact set and versions for any build are in that repo's lockfile, which is the authoritative list.

The full transitive dependency set for any build is pinned in this repo's lockfile,
which is the authoritative list. What is named above is the layers a reader would
want to know about, not every package that has ever been resolved.

## Work we checked ourselves against

No code was taken from these — but they were how we knew we had it right, and that is worth saying out loud.

### Room EQ Wizard (REW)

<https://www.roomeqwizard.com/>

Traps can be tuned to the peaks in a REW measurement exported as text (File > Export > Export measurement as text). Peaks are picked against a one-octave running median; the frequencies are exact and the dB figure is only good for ranking them.

## Standards and published specifications

What the implementation is measured against.

- **Lumped Helmholtz resonator with end corrections** — The trap model: f = c/2π · √(S / (V · L_eff)), with L_eff = L + 0.85r for the flanged outer end and 0.61r for the unflanged inner end. A textbook model; no design has been printed and acoustically measured yet.
- **Schroeder's quadratic-residue diffuser** — Well depths d = s · λ0 / 2N for s = n² mod N (1D) or (x² + y²) mod N (2D), N prime, effective from about the design frequency up to where a well is half a wavelength wide.

## Getting this wrong

If your work is here and the description is inaccurate, the licence is wrong, or you would rather not be listed — open an issue and it will be fixed.
