# Quickstart Validation: Groww Algo Trading and Explainable Flow Gates

Live execution is disabled by default. Use transport stubs and Paper mode for local validation.

## Prerequisites

- Node.js 20+ and npm.
- Python 3.11+.
- This repository's installed dependencies.
- Optional server-side Groww variables from `.env.groww.example`; do not place them in browser variables.

## Run checks

```powershell
npx vitest run
$env:PYTHONPATH="quant\src"
python -m unittest discover -s quant\tests -v
npm run build
```

## Required scenarios

1. **First failed gate**: Run `tests/unit/algo-flow-gate.test.ts`; confirm low news impact stops at
   `NEWS` and all-pass input reaches `EXECUTION`.
2. **Paper isolation**: Run `tests/security/paper-live-isolation.test.ts`; confirm the simulator
   produces a fill and no Groww transport is constructed or called.
3. **Missing credential**: Instantiate `createGrowwTransport({})`, call a broker operation, and
   confirm a structured configuration error blocks live entry.
4. **Groww mapping**: Run `tests/contract/groww-adapter.test.ts` with a transport stub; confirm
   reference IDs and OCO quantity constraints.
5. **Unknown order**: Simulate a transport timeout and verify the execution service stores `UNKNOWN`
   and queries status by reference before retrying.
6. **Partial fill**: Simulate a partial provider response and confirm protection quantity equals the
   filled position quantity.
7. **Reconciliation**: Run `tests/integration/reconciliation.test.ts`; unexpected positions must block automation.
8. **Live activation**: Run `tests/security/live-activation.test.ts`; both live flags and compliance
   approval are required.
9. **News outcomes**: Store one event and evaluate all six horizons without modifying its original prediction.
10. **Release review**: Confirm current Groww API permissions, exchange requirements, SEBI obligations,
    consent, disclosure, incident response, and credential handling before enabling any live flag.

## Expected outcome

- All automated tests pass.
- Paper path has zero Groww calls.
- Every blocked flow includes a stage and reason.
- Live flags remain false unless an authorized release review explicitly changes them.