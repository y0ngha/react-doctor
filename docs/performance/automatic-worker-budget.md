# Automatic lint-worker memory experiment

The automatic lint-worker ceiling changes from 10 to 4. The existing CPU and memory bounds still apply. Explicit `REACT_DOCTOR_PARALLEL=N`, programmatic concurrency, and `--no-parallel` retain their behavior. No rule, diagnostic schema, or score changes.

The target developer machine is an **8-core M1 Pro with 16 GiB RAM**. Unit tests cover that CPU/memory input selecting four workers. Measurements below were taken on an **Apple M5, 10 cores, 32 GiB RAM, macOS arm64, Node 22.19.0**. They are not M1 Pro measurements, and the worker limit is not a CPU or RAM hard limit. The new automatic ceiling applies to all hosts.

## Controlled wall-time comparison

Base source: `84ad0c8d0df7a3ab7d26946367fae3bc39c100d0`.

Both worker counts use the same build on this branch. Explicit 10 workers reproduces the old automatic worker count on this host; explicit 4 reproduces the new count. Three measured scans follow one excluded warmup per series. Runs are sequential. React Doctor caches are disabled; OS filesystem and Node compile caches are not. Corpus dependencies were not installed.

`full` includes project analysis, but the benchmark disables score, supply-chain checks, and telemetry. CPU profiles and memory sampling run separately from wall-time samples.

| Target         | Scanned files | 10 workers, median | 4 workers, median | Wall-time change | Diagnostics |
| -------------- | ------------: | -----------------: | ----------------: | ---------------: | ----------: |
| tldraw-package |           550 |            1.456 s |           1.317 s |            -9.5% |         108 |
| tldraw         |         2,399 |            5.283 s |           4.125 s |           -21.9% |         896 |
| refine         |         7,003 |           14.719 s |          14.759 s |            +0.3% |        1446 |

The diagnostic hashes match across worker counts and repeated samples, with no skipped checks. Refine's +0.3% difference is within the observed run-to-run spread. Earlier scans in this session were slower at both worker counts; those earlier wall times are not used to claim a larger speedup.

## Process-tree memory

For tldraw's full scan, a separate sampler sums RSS for the CLI and its live descendants every approximately 50 ms. Each series has one warmup and three measured runs. The peak RSS sum is taken per run, then the median is reported.

| Configuration                    | Processes at peak | Median peak RSS sum |
| -------------------------------- | ----------------: | ------------------: |
| Explicit 10 workers              |                11 |          2700.8 MiB |
| New automatic default, 4 workers |                 5 |          1404.9 MiB |

This is a **48.0% reduction in sampled aggregate RSS**. Shared pages can be counted more than once, sampling can miss short peaks, and this is not unique physical memory or an allocation limit. The standard harness's `/usr/bin/time` maximum RSS is a different metric and must not be presented as the process-tree total. Every memory run produced the same diagnostics as the wall-time comparison.

A separate tldraw hot-cache comparison passed diagnostic parity: median 518.4 ms before and 477.5 ms after. This small sample does not establish a general cache speedup.

## Reproduce

Use `@antfu/ni` (`ni` and `nr`) and Python 3 for the optional process-tree sampler.

```sh
ni --frozen-lockfile
nr build
nr performance:corpus tldraw-package tldraw refine
nr performance --corpus tldraw-package,tldraw,refine --samples 3 --warmups 1 --workers 10,4 --mode full --cache no-cache --out .performance/controlled-worker-comparison
```

The pinned corpus revisions are in `scripts/performance/corpus.json`. Numeric samples, target fingerprints, hashes, and memory peaks are saved in [automatic-worker-budget-results.json](./automatic-worker-budget-results.json).

To compare versions rather than worker counts, run `nr performance` with identical targets, modes, cache cohorts, and `--workers auto` on the base and this branch, saving each to a different output directory. Pass `--compare <base-results.json> --strict` for the second run. The harness rejects skipped checks and diagnostic drift.

For process-tree memory, save the following script as `.performance/measure-process-tree.py`, then run:

```sh
python3 .performance/measure-process-tree.py --workers 10 --out .performance/memory-control-10
python3 .performance/measure-process-tree.py --workers auto --out .performance/memory-auto-after
```

<details>
<summary>Process-tree sampler (macOS/Linux)</summary>

```python
import argparse
import json
import os
import pathlib
import statistics
import subprocess
import time

parser = argparse.ArgumentParser()
parser.add_argument('--out', required=True)
parser.add_argument('--workers', default='auto')
parser.add_argument('--target', default='.performance/corpus/tldraw')
parser.add_argument('--samples', type=int, default=3)
options = parser.parse_args()
root = pathlib.Path.cwd()
output = root / options.out
output.mkdir(parents=True, exist_ok=True)
environment = os.environ.copy()
for name in ['NODE_OPTIONS', 'REACT_DOCTOR_PARALLEL', 'NODE_DISABLE_COMPILE_CACHE']:
    environment.pop(name, None)
environment.update(CI='1', REACT_DOCTOR_NO_CACHE='1', REACT_DOCTOR_NO_TELEMETRY='1', REACT_DOCTOR_CACHE_DIR=str(output / 'cache'), NODE_COMPILE_CACHE=str(output / 'compile-cache'))
if options.workers != 'auto':
    environment['REACT_DOCTOR_PARALLEL'] = options.workers
runs = []
for run_index in range(options.samples + 1):
    report_path = output / f'run-{run_index}.report.json'
    command = ['node', str(root / 'packages/react-doctor/dist/cli.js'), str(root / options.target), '--yes', '--json', '--json-compact', '--json-out', str(report_path), '--no-score', '--no-supply-chain', '--blocking', 'none']
    samples = []
    started = time.monotonic()
    with open(output / f'run-{run_index}.stdout.log', 'w') as stdout, open(output / f'run-{run_index}.stderr.log', 'w') as stderr:
        process = subprocess.Popen(command, env=environment, stdout=stdout, stderr=stderr)
        while process.poll() is None:
            rows = {}
            for line in subprocess.check_output(['ps', '-axo', 'pid=,ppid=,rss='], text=True).splitlines():
                process_id, parent_id, resident_kib = map(int, line.split())
                rows[process_id] = (parent_id, resident_kib)
            descendants = {process.pid}
            while True:
                expanded = descendants | {process_id for process_id, (parent_id, resident_kib) in rows.items() if parent_id in descendants}
                if expanded == descendants:
                    break
                descendants = expanded
            samples.append({'seconds': time.monotonic() - started, 'rssBytes': sum(rows[process_id][1] * 1024 for process_id in descendants if process_id in rows), 'processCount': len(descendants)})
            time.sleep(0.05)
    if process.returncode != 0:
        raise RuntimeError(f'Scan failed: {process.returncode}')
    report = json.loads(report_path.read_text())
    if not report['ok'] or any(project['skippedChecks'] for project in report['projects']):
        raise RuntimeError('Incomplete scan')
    runs.append({'index': run_index, 'warmup': run_index == 0, 'peak': max(samples, key=lambda sample: sample['rssBytes']), 'samples': samples})
    print(json.dumps({'index': run_index, 'peak': runs[-1]['peak']}), flush=True)
result = {'workers': options.workers, 'target': options.target, 'samplingIntervalMs': 50, 'note': 'Process RSS sum includes shared-page double counting; sampling may miss peaks. Timings are instrumented and excluded from wall-time benchmarks.', 'medianPeakRssBytes': statistics.median(run['peak']['rssBytes'] for run in runs[1:]), 'runs': runs}
(output / 'results.json').write_text(json.dumps(result, indent=2) + '\n')
print('Median peak RSS MiB:', result['medianPeakRssBytes'] / 1024**2)

```

</details>

## Scope and follow-up

This is a conservative default experiment, not evidence that four workers is optimal for every machine or repository. Large CPU-bound scans on other hosts may benefit from an explicit higher count. No Rust port or new runtime dependency is needed for this change.

The existing `scan.workerCount` and scan timing telemetry already record the chosen worker count and outcome; no additional telemetry is introduced. Reconsider the ceiling if representative repeated benchmarks show more than 10% slower wall time without a useful memory reduction. An actual 8-core/16-GiB M1 Pro run, including normal editor/browser workloads, is still needed before claiming M1 Pro performance.

## Validation

- `nr build`: passed.
- `nr lint`: passed with existing warnings outside this change.
- `nr typecheck`: passed.
- `nr format:check`: passed.
- `nr smoke:json-report`: passed.
- Focused concurrency and compatibility tests: 18 passed.
- `nr test --continue -- --maxWorkers=2`: 34,072 passed, 1 failed, 1,118 skipped.

The sole failure is `check-security-scan.test.ts` → `keeps capability inventory optional while reporting database and command risks`: the existing `fixtures/check-security-scan/ported-database-and-command-risks/public/plugin.php` file is absent in this environment. It was already deleted before this work and was also absent in the independent validation checkout. The same test fails on unchanged base source at `84ad0c8d0`. Its absence was not included in this branch. The cause of the file's disappearance was not established; this report does not claim an entirely green suite.

The shared commit uses `[skip ci]` to avoid the inherited `Publish Any Commit` workflow publishing preview packages on push. The checks above ran locally.
