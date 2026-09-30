import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'

// The kernel needs `new Function` (embind) and dies under the page CSP with an
// EvalError — but only on the deployed site, since `vite dev` sends no headers.
// Nothing else would catch this rule going missing before a visitor did.
it('_headers lets the geometry worker, and only it, evaluate strings', () => {
  const text = readFileSync(new URL('../../public/_headers', import.meta.url), 'utf8')
  const rules = new Map<string, string[]>()
  let cur = ''
  for (const line of text.split('\n')) {
    if (!line.trim() || line.startsWith('#')) continue
    if (!/^\s/.test(line)) rules.set((cur = line.trim()), [])
    else rules.get(cur)!.push(line.trim())
  }
  const csp = (rule: string) => rules.get(rule)?.find((l) => l.startsWith('Content-Security-Policy:')) ?? ''
  expect(csp('/*')).toMatch(/script-src 'self' 'wasm-unsafe-eval';/)
  expect(csp('/*')).not.toMatch(/'unsafe-eval'/)
  expect(rules.get('/assets/worker-*')).toContain('! Content-Security-Policy')
  expect(csp('/assets/worker-*')).toMatch(/script-src[^;]*'unsafe-eval'[^;]*'wasm-unsafe-eval'/)
})

it('the built worker is named as the _headers rule expects', () => {
  // vite names a `new Worker(new URL('../worker.ts', …))` chunk worker-<hash>.js
  const client = readFileSync(new URL('./client.ts', import.meta.url), 'utf8')
  expect(client).toMatch(/new URL\('\.\.\/worker\.ts', import\.meta\.url\)/)
})
