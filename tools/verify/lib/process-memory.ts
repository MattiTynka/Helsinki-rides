// Read only the processes reported by this harness's own Chromium instance.
// This is a diagnostic snapshot, separate from GPU texture/buffer budgets.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Browser } from 'playwright';

const execute = promisify(execFile);
export async function captureOwnedBrowserMemory(browser: Browser) {
  if (process.platform !== 'win32') return { status: 'UNAVAILABLE', reason: 'Windows process counters are not available on this platform' };
  let session;
  try {
    session = await browser.newBrowserCDPSession();
    const info = await session.send('SystemInfo.getProcessInfo') as { processInfo: { id: number; type: string; cpuTime: number }[] };
    if (!Array.isArray(info.processInfo) || !info.processInfo.length || info.processInfo.length > 128 || info.processInfo.some(row => !Number.isSafeInteger(row.id) || row.id <= 0)) throw new Error('Invalid owned Chromium process list');
    const ids = [...new Set(info.processInfo.map(row => row.id))];
    const command = `Get-Process -Id ${ids.join(',')} -ErrorAction SilentlyContinue | Select-Object Id,WorkingSet64,PrivateMemorySize64 | ConvertTo-Json -Compress`;
    const result = await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { windowsHide: true, timeout: 5000, maxBuffer: 131072 });
    const value = JSON.parse(result.stdout.trim());
    const rows = (Array.isArray(value) ? value : [value]) as { Id: number; WorkingSet64: number; PrivateMemorySize64: number }[];
    if (rows.some(row => !ids.includes(row.Id) || !Number.isFinite(row.WorkingSet64) || !Number.isFinite(row.PrivateMemorySize64) || row.WorkingSet64 < 0 || row.PrivateMemorySize64 < 0)) throw new Error('Invalid process memory counters');
    const found = new Set(rows.map(row => row.Id));
    return { status: 'MEASURED', sampledAt: new Date().toISOString(), processes: rows.map(row => ({ id: row.Id, type: info.processInfo.find(p => p.id === row.Id)?.type, workingSetBytes: row.WorkingSet64, privateCommitBytes: row.PrivateMemorySize64 })),
      missingProcessIds: ids.filter(id => !found.has(id)), workingSetBytes: rows.reduce((sum, row) => sum + row.WorkingSet64, 0), privateCommitBytes: rows.reduce((sum, row) => sum + row.PrivateMemorySize64, 0),
      limitation: 'Owned Chromium processes only. Private commit includes JS/native/WASM allocations. Summed working sets can count shared pages more than once; these snapshots are not a continuous peak or GPU-memory measurement.' };
  } catch (error) {
    return { status: 'UNAVAILABLE', reason: error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300) };
  } finally { await session?.detach().catch(() => {}); }
}
