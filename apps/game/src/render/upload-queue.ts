export interface UploadQueueOptions {
  readonly budgetMs?: number;
  readonly maxJobsPerFrame?: number;
  readonly requestFrame?: (callback: () => void) => number;
  readonly cancelFrame?: (id: number) => void;
  readonly now?: () => number;
}

interface UploadJob {
  readonly action: () => void;
  readonly signal?: AbortSignal;
  readonly resolve: () => void;
  readonly reject: (reason: unknown) => void;
  onAbort?: () => void;
}

const cancelled = () => new DOMException('GPU upload was cancelled', 'AbortError');

/** Spread synchronous GPU uploads across frames; an individual upload cannot be interrupted. */
export class UploadQueue {
  private readonly budgetMs: number;
  private readonly maxJobsPerFrame: number;
  private readonly requestFrame: (callback: () => void) => number;
  private readonly cancelFrame: (id: number) => void;
  private readonly now: () => number;
  private readonly jobs: UploadJob[] = [];
  private scheduledFrame: number | null = null;
  private frameGeneration = 0;
  private draining = false;
  private disposed = false;

  constructor(options: UploadQueueOptions = {}) {
    this.budgetMs = options.budgetMs ?? 2;
    this.maxJobsPerFrame = options.maxJobsPerFrame ?? 2;
    if (!Number.isFinite(this.budgetMs) || this.budgetMs <= 0) throw new Error('Upload frame budget must be positive');
    if (!Number.isSafeInteger(this.maxJobsPerFrame) || this.maxJobsPerFrame <= 0) throw new Error('Upload jobs per frame must be a positive integer');
    this.requestFrame = options.requestFrame ?? (callback => requestAnimationFrame(callback));
    this.cancelFrame = options.cancelFrame ?? (id => cancelAnimationFrame(id));
    this.now = options.now ?? (() => performance.now());
  }

  enqueue(action: () => void, signal?: AbortSignal): Promise<void> {
    if (this.disposed || signal?.aborted) return Promise.reject(cancelled());
    return new Promise<void>((resolve, reject) => {
      const job: UploadJob = { action, signal, resolve, reject };
      if (signal) {
        job.onAbort = () => {
          const index = this.jobs.indexOf(job);
          if (index === -1) return;
          this.jobs.splice(index, 1);
          this.detach(job);
          reject(cancelled());
          if (!this.jobs.length) this.cancelScheduledFrame();
        };
        signal.addEventListener('abort', job.onAbort, { once: true });
      }
      this.jobs.push(job);
      this.schedule();
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancelScheduledFrame();
    for (const job of this.jobs.splice(0)) {
      this.detach(job);
      job.reject(cancelled());
    }
  }

  private detach(job: UploadJob): void {
    if (job.onAbort) job.signal!.removeEventListener('abort', job.onAbort);
  }

  private cancelScheduledFrame(): void {
    if (this.scheduledFrame === null) return;
    this.cancelFrame(this.scheduledFrame);
    this.scheduledFrame = null;
    this.frameGeneration++;
  }

  private schedule(): void {
    if (this.disposed || this.draining || this.scheduledFrame !== null || !this.jobs.length) return;
    const generation = ++this.frameGeneration;
    this.scheduledFrame = this.requestFrame(() => this.drain(generation));
  }

  private drain(generation: number): void {
    if (this.disposed || generation !== this.frameGeneration) return;
    this.scheduledFrame = null;
    this.draining = true;
    const started = this.now();
    let executed = 0;
    try {
      while (!this.disposed && this.jobs.length && executed < this.maxJobsPerFrame
        && (executed === 0 || this.now() - started < this.budgetMs)) {
        const job = this.jobs.shift()!;
        this.detach(job);
        if (job.signal?.aborted) { job.reject(cancelled()); continue; }
        executed++;
        try { job.action(); job.resolve(); }
        catch (error) { job.reject(error); }
      }
    } finally {
      this.draining = false;
      this.schedule();
    }
  }
}
