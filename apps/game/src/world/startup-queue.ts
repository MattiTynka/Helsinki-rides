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
