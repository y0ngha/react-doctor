import os from "node:os";
import { describe, expect, it } from "vite-plus/test";
import {
  AUTO_MAX_SCAN_CONCURRENCY,
  HARD_MAX_SCAN_CONCURRENCY,
  MIN_SCAN_CONCURRENCY,
} from "../src/constants.js";
import { readCgroupMemoryLimitBytes } from "../src/utils/read-cgroup-memory-limit-bytes.js";
import { resolveAutoScanConcurrency } from "../src/utils/resolve-auto-scan-concurrency.js";

const GIB = 1024 * 1024 * 1024;
const MIB = 1024 * 1024;

describe("resolveAutoScanConcurrency", () => {
  it("is core-bound when memory is plentiful", () => {
    expect(
      resolveAutoScanConcurrency({
        availableCores: 2,
        totalMemoryBytes: 16 * GIB,
        cgroupMemoryLimitBytes: undefined,
      }),
    ).toBe(2);
  });

  it.each([8, 10])("uses four automatic workers for %i cores and 16 GiB", (availableCores) => {
    expect(
      resolveAutoScanConcurrency({
        availableCores,
        totalMemoryBytes: 16 * GIB,
        cgroupMemoryLimitBytes: undefined,
      }),
    ).toBe(4);
  });

  it("caps automatic workers on larger hosts too", () => {
    expect(
      resolveAutoScanConcurrency({
        availableCores: 16,
        totalMemoryBytes: 64 * GIB,
        cgroupMemoryLimitBytes: undefined,
      }),
    ).toBe(AUTO_MAX_SCAN_CONCURRENCY);
  });

  it("is memory-bound on a high-core / memory-starved box", () => {
    expect(
      resolveAutoScanConcurrency({
        availableCores: 64,
        totalMemoryBytes: 2 * GIB,
        cgroupMemoryLimitBytes: undefined,
      }),
    ).toBe(2);
  });

  it("honors a cgroup memory limit below the host total", () => {
    expect(
      resolveAutoScanConcurrency({
        availableCores: 64,
        totalMemoryBytes: 200 * GIB,
        cgroupMemoryLimitBytes: 2 * GIB,
      }),
    ).toBe(2);
  });

  it("never exceeds AUTO_MAX_SCAN_CONCURRENCY", () => {
    expect(
      resolveAutoScanConcurrency({
        availableCores: 128,
        totalMemoryBytes: 256 * GIB,
        cgroupMemoryLimitBytes: undefined,
      }),
    ).toBe(AUTO_MAX_SCAN_CONCURRENCY);
  });

  it("floors to MIN when not even one worker's budget fits", () => {
    expect(
      resolveAutoScanConcurrency({
        availableCores: 64,
        totalMemoryBytes: 256 * MIB,
        cgroupMemoryLimitBytes: undefined,
      }),
    ).toBe(MIN_SCAN_CONCURRENCY);
  });

  it("returns an integer within [MIN, HARD_MAX] on the real system", () => {
    const resolved = resolveAutoScanConcurrency();
    expect(Number.isInteger(resolved)).toBe(true);
    expect(resolved).toBeGreaterThanOrEqual(MIN_SCAN_CONCURRENCY);
    expect(resolved).toBeLessThanOrEqual(HARD_MAX_SCAN_CONCURRENCY);
    expect(resolved).toBeLessThanOrEqual(AUTO_MAX_SCAN_CONCURRENCY);
  });

  it("sources total (not free) memory on the real system", () => {
    // Pins that the default facts use os.totalmem() + os.availableParallelism()
    // + the cgroup limit. If `readSystemFacts` ever regressed to os.freemem()
    // (which reads ~0 of a large total on macOS / cache-heavy Linux, collapsing
    // the scan to one worker), the no-arg call would diverge from this
    // total-memory recomputation and this assertion would fail.
    const fromTotalMemory = resolveAutoScanConcurrency({
      availableCores: os.availableParallelism(),
      totalMemoryBytes: os.totalmem(),
      cgroupMemoryLimitBytes: readCgroupMemoryLimitBytes(),
    });
    expect(resolveAutoScanConcurrency()).toBe(fromTotalMemory);
  });
});
