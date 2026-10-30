import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import type {Response} from 'playwright';

const MAX_RESPONSES = 2048;
const MAX_BODY_BYTES = 32 * 1024 * 1024;
const MAX_TOTAL_BODY_BYTES = 128 * 1024 * 1024;
const canonicalUrl = (value: string) => {const url = new URL(value); url.hash = ''; return url.href;};

/** Hash original responses as soon as they finish, before Chromium can evict their
 * bodies during world loading. Retain only promises/hashes; never refetch identity. */
export function createLoadedResponseCapture(limits: {maxResponses?: number; maxBodyBytes?: number; maxTotalBodyBytes?: number; onError?: (error: Error) => void} = {}) {
  const maxResponses = limits.maxResponses ?? MAX_RESPONSES, maxBodyBytes = limits.maxBodyBytes ?? MAX_BODY_BYTES;
  const maxTotalBodyBytes = limits.maxTotalBodyBytes ?? MAX_TOTAL_BODY_BYTES;
  assert.ok(Number.isSafeInteger(maxResponses) && maxResponses > 0 && maxResponses <= MAX_RESPONSES);
  assert.ok(Number.isSafeInteger(maxBodyBytes) && maxBodyBytes > 0 && maxBodyBytes <= MAX_BODY_BYTES);
  assert.ok(Number.isSafeInteger(maxTotalBodyBytes) && maxTotalBodyBytes > 0 && maxTotalBodyBytes <= MAX_TOTAL_BODY_BYTES);
  const responses = new Map<string, Promise<string>[]>();
  let candidates = 0, totalBodyBytes = 0, failure: Error | null = null;
  const assertHealthy = () => {if (failure) throw failure;};
  const fail = (error: unknown) => {
    if (failure) return;
    failure = error instanceof Error ? error : new Error(String(error));
    limits.onError?.(failure);
  };
  async function capture(response: Response) {
    const length = response.headers()['content-length'];
    if (length !== undefined) assert.ok(/^\d+$/.test(length) && Number(length) <= maxBodyBytes, 'Loaded identity response exceeds body byte limit');
    assert.equal(await response.finished(), null, 'Original identity response did not complete');
    assertHealthy();
    // Playwright supplies completed decoded bytes. Read immediately rather than at
    // readiness: a large world's asset traffic can evict an earlier script body.
    const body = await response.body();
    assert.ok(body.length <= maxBodyBytes, 'Loaded identity decoded body exceeds byte limit');
    totalBodyBytes += body.length;
    assert.ok(totalBodyBytes <= maxTotalBodyBytes, 'Loaded identity cumulative body byte limit exceeded');
    assertHealthy();
    return createHash('sha256').update(body).digest('hex');
  }
  return {
    observe(response: Response) {
      if (failure) return;
      try {
        const url = new URL(response.url());
        if (response.request().resourceType() !== 'script' && !url.pathname.endsWith('/manifest.json')) return;
        assert.ok(++candidates <= maxResponses, `Loaded identity response limit ${maxResponses} exceeded`);
        if (response.status() !== 200) return;
        const key = canonicalUrl(url.href), entries = responses.get(key) ?? [], hash = capture(response);
        // Observe rejection immediately even if identity is never requested. This
        // prevents unhandled promises and makes background capture failures fatal.
        void hash.catch(fail);
        entries.push(hash); responses.set(key, entries);
      } catch (error) {fail(error);}
    },
    error: () => failure,
    async sha256(value: string): Promise<string> {
      assertHealthy();
      const key = canonicalUrl(value), entries = responses.get(key) ?? [];
      assert.equal(entries.length, 1, `Exactly one original HTTP200 response required: ${key}`);
      const result = await entries[0]!;
      assertHealthy();
      assert.equal(responses.get(key)?.length, 1, `Original identity response became ambiguous: ${key}`);
      return result;
    },
  };
}
