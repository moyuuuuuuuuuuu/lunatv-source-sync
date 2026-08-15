import type Database from 'better-sqlite3';
import { checkSource, type CheckOptions, type CheckResult } from './check.js';
import { getHealthSettings, listCheckableSources, recordCheckResult, setNextCheckAt } from './repository.js';

export interface BatchResult { checked: number; healthy: number; unhealthy: number; skipped: boolean; }
export interface BatchOptions extends CheckOptions { concurrency?: number; sourceIds?: readonly number[]; }

let running = new WeakMap<Database.Database, Promise<BatchResult>>();

export function runHealthBatch(db: Database.Database, options: BatchOptions = {}): Promise<BatchResult> {
  const active = running.get(db);
  if (active) return Promise.resolve({ checked: 0, healthy: 0, unhealthy: 0, skipped: true });
  const job = (async () => {
    const settings = getHealthSettings(db);
    const selected = options.sourceIds ? new Set(options.sourceIds) : null;
    const sources = listCheckableSources(db, Boolean(selected)).filter((source) => !selected || selected.has(source.id));
    const results: CheckResult[] = [];
    let index = 0;
    const worker = async () => {
      while (index < sources.length) {
        const source = sources[index++];
        const result = await checkSource(source, settings, options);
        recordCheckResult(db, source.id, result);
        results.push(result);
      }
    };
    const concurrency = Math.max(1, Math.min(20, Math.trunc(options.concurrency ?? 5)));
    await Promise.all(Array.from({ length: Math.min(concurrency, sources.length) }, worker));
    return { checked: results.length, healthy: results.filter((r) => r.status === 'healthy').length, unhealthy: results.filter((r) => r.status === 'unhealthy').length, skipped: false };
  })();
  running.set(db, job);
  return job.finally(() => running.delete(db));
}

export interface SchedulerHandle {
  stop(): void;
  reschedule(): void;
  runNow(): Promise<BatchResult>;
  checkSources(sourceIds: readonly number[]): Promise<BatchResult>;
}

export interface SchedulerOptions extends BatchOptions {
  now?: () => Date;
  setTimer?: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
}

export function startScheduler(db: Database.Database, options: SchedulerOptions = {}): SchedulerHandle {
  const now = options.now ?? (() => new Date());
  const setTimer = options.setTimer ?? setTimeout;
  const clearTimer = options.clearTimer ?? clearTimeout;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  const schedule = () => {
    if (timer) clearTimer(timer);
    if (stopped) return;
    const settings = getHealthSettings(db);
    const current = now();
    let next = settings.nextCheckAt ? new Date(settings.nextCheckAt) : new Date(Number.NaN);
    if (!Number.isFinite(next.getTime())) next = new Date(current.getTime() + settings.checkIntervalHours * 3_600_000);
    else if (next <= current) next = current;
    setNextCheckAt(db, next);
    timer = setTimer(() => { void runAndReschedule(); }, Math.max(0, next.getTime() - current.getTime()));
  };
  const runAndReschedule = async () => {
    const result = await runHealthBatch(db, options);
    const next = new Date(now().getTime() + getHealthSettings(db).checkIntervalHours * 3_600_000);
    setNextCheckAt(db, next);
    schedule();
    return result;
  };
  schedule();
  return {
    stop() { stopped = true; if (timer) clearTimer(timer); timer = undefined; },
    reschedule() { setNextCheckAt(db, null); schedule(); },
    runNow: runAndReschedule,
    checkSources(sourceIds) { return runHealthBatch(db, { ...options, sourceIds }); },
  };
}

export function resetHealthBatchStateForTests(): void { running = new WeakMap(); }
