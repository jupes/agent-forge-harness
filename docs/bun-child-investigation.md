# ieqd: Windows Bun child execution investigation

## Question and method

The original observation was roughly one `bun -e` child in 150 exiting zero
without running under parallel Windows load. This probe does not treat zero
as sufficient evidence: every child synchronously writes its unique token to
a fresh marker file, stdout and stderr. The eval and file modes use the exact
same payload, exported as `PAYLOAD` in `scripts/bun-child-probe.ts`.

The parent awaits exit and drains **both** streams before reading the file.
Missing all three witnesses with exit zero has its own classification;
partial/wrong witnesses, nonzero exit, timeout and probe errors are separate.
An empty script test confirms that the detector identifies silent success.
Each invocation uses a fresh OS temporary directory and removes its own files.
Tokens contain the supplied seed, mode and sequential index; there is no RNG.
The child imports only `node:fs` and cannot resolve a checkout or touch a ledger.

The default is 300 children per mode at concurrency one, with a hard concurrency
maximum of 16. Each child gets 10 seconds. A matrix stops scheduling after 180
seconds and waits for already-started children. Requested and attempted counts
are separate; unstarted work is never counted as successful. This timeout
assumes the OS honors process termination; descendants are absent in the payload.

## Environment and reproduction

Measured October 17, 2026 on Windows 11 Pro x64, build `10.0.26300`, AMD Ryzen 7
9800X3D, 16 logical CPUs. The lead had two full test/browser workloads running
concurrently; their overlap varied over time and is not a controlled load.
The checkout started at `5883e29`. Paths contain spaces.
Installed Bun: `1.3.10+30e609e08`; official portable comparison:
`1.4.3+c6da4a4d3`. Global Bun and repository pins were unchanged.

From PowerShell at the checkout, run each invocation separately:

```powershell
$old = (Get-Command bun).Source
$new = (Resolve-Path '.tmp/work/runtime/bun-v1.4.3/bun-windows-x64/bun.exe').Path
```

| Runtime / parallel | Command (runs eval, then file) |
| --- | --- |
| 1.3.10 / 1 | `& $old run scripts/bun-child-probe.ts $old 300 1 ieqd1310c1` |
| 1.3.10 / 8 | `& $old run scripts/bun-child-probe.ts $old 600 8 ieqd1310c8` |
| 1.4.3 / 1 | `& $new run scripts/bun-child-probe.ts $new 300 1 ieqd143c1` |
| 1.4.3 / 8 | `& $new run scripts/bun-child-probe.ts $new 600 8 ieqd143c8` |
| 1.3.10 / 16 | `& $old run scripts/bun-child-probe.ts $old 600 16 ieqd1310c16` |

The newer executable is an optional separately downloaded official release;
provide its absolute path when stored elsewhere. No download happens in the
probe. The parent and target runtime match in each measured invocation.
Successful diagnostic execution emits `{ ok: true, data, error: null }` with
configuration, full payload, per-mode counts and every anomalous witness.
Here `ok` means the probe ran: callers must still inspect attempted counts,
classification counts and failures. Input/setup failure emits `ok: false`.

## Measurements

| Bun | Parallel | Mode | Requested | Started | Complete | Elapsed seconds |
| --- | ---: | --- | ---: | ---: | ---: | ---: |
| 1.3.10 | 1 | eval | 300 | 300 | 300 | 97.177 |
| 1.3.10 | 1 | file | 300 | 300 | 300 | 144.557 |
| 1.3.10 | 8 | eval | 600 | 600 | 600 | 52.230 |
| 1.3.10 | 8 | file | 600 | 600 | 600 | 58.951 |
| 1.4.3 | 1 | eval | 300 | 300 | 300 | 69.312 |
| 1.4.3 | 1 | file | 300 | 300 | 300 | 102.422 |
| 1.4.3 | 8 | eval | 600 | 600 | 600 | 18.362 |
| 1.4.3 | 8 | file | 600 | 600 | 600 | 30.907 |
| 1.3.10 | 16 | eval | 600 | 600 | 600 | 21.601 |
| 1.3.10 | 16 | file | 600 | 600 | 600 | 29.262 |

All 4,800 requested children started and completed with exact file/stdout/stderr
witnesses and exit zero. Every row had **zero** exit-zero-without-witness cases,
witness mismatches, nonzero exits, timeouts and probe errors; every failure
array was empty. Baseline totals: 1,500 eval and 1,500 file children; newer Bun:
900 eval and 900 file children. No scheduling budget truncated a row.

This is finite **non-reproduction**, not a fix or a dismissal of the original
observation. The original rate may depend on payload, host or transient load;
this minimal payload does not exercise the original imported lock workload.
Background load changed between rows, so elapsed times do not establish a
runtime speed comparison. No probability estimate assumes independent trials.

The baseline concurrency-one and concurrency-eight runs preceded final cleanup
ordering (success JSON now prints after cleanup); the first also preceded
switching `Promise.all` to `allSettled` to await peer streams on a pipe error.
Neither observed pipe errors or cleanup errors. Portable comparisons and the
concurrency-sixteen run exercise the final implementation.

## Upstream search and limits

Read-only GitHub searches of `oven-sh/bun` on October 17 used `Windows subprocess
exit 0`, `eval silent`, `spawn silent`, and `exits without`. The first three
returned no issues. No matching minimal startup/eval issue was found in the
last query's first 15 results. This is a limited search, not proof of absence.
Additional searches for `Windows "exit code 0"` and `"bun -e" "nothing"`
returned no issues.
[Issue 31224](https://github.com/oven-sh/bun/issues/31224) describes a Windows
worker pipe shutdown crash with nontrivial asynchronous writes and explicit
exit; it does not establish the cause of the reported missing marker.

This run does not change production child handling or claim a Bun fix.
The conditional exit-code-only test audit and upstream bug submission require
a confirmed reproduction. No upstream issue was posted.
