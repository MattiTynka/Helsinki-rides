/** Bound the combined startup request queue; callers store results at their original manifest index. */
export async function runStartupJobs(jobs: readonly (() => Promise<void>)[]): Promise<void> {
  let next = 0;
  let failed = false;
  await Promise.all(Array.from({ length: Math.min(6, jobs.length) }, async () => {
    while (!failed) {
      const job = jobs[next++];
      if (!job) return;
      try { await job(); }
      catch (error) { failed = true; throw error; }
    }
  }));
}

/** Bounded request slots; after `close` (a failed startup), queued requests do not start. */
export function requestSlots(count: number): (<T>(job: () => Promise<T>) => Promise<T>) & { close(): void } {
  let active = 0, closed = false;
  const waiting: (() => void)[] = [];
  const run = <T>(job: () => Promise<T>): Promise<T> => new Promise<T>((resolve, reject) => {
    const begin = (): void => {
      if (closed) { reject(new Error('startup cancelled')); return; }
      active++;
      job().then(resolve, reject).finally(() => { active--; waiting.shift()?.(); });
    };
    if (active < count) begin(); else waiting.push(begin);
  });
  return Object.assign(run, { close: () => { closed = true; for (const begin of waiting.splice(0)) begin(); } });
}
