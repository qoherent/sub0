import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename } from 'node:fs/promises';
import { join, resolve } from 'node:path';

export type BrokerReceipt = {
  brokerId: string;
  incarnation: string;
  pid: number;
  processStart?: string;
  state: 'active' | 'closed';
};

/** Persist one broker incarnation so recovery can distinguish a dead owner from its live settle window. */
export async function writeBrokerReceipt(directory: string, brokerId: string, state: BrokerReceipt['state'], incarnation: string = randomUUID()): Promise<BrokerReceipt> {
  const dir = resolve(directory);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const processStart = await readProcessStart(process.pid);
  if (processStart === null) throw new Error('broker_process_identity_unavailable');
  const receipt: BrokerReceipt = { brokerId, incarnation, pid: process.pid, ...(processStart !== undefined ? { processStart } : {}), state };
  const path = receiptPath(dir, brokerId, incarnation);
  const temporary = `${path}.${randomUUID()}.tmp`;
  const file = await open(temporary, 'wx', 0o600);
  try { await file.writeFile(JSON.stringify(receipt), 'utf8'); await file.sync(); } finally { await file.close(); }
  await rename(temporary, path);
  return receipt;
}

/** undefined means the receipt is missing or cannot be trusted and must fail closed. */
export async function isBrokerIncarnationLive(directory: string, brokerId: string, incarnation: string): Promise<boolean | undefined> {
  let receipt: BrokerReceipt;
  try { receipt = JSON.parse(await readFile(receiptPath(resolve(directory), brokerId, incarnation), 'utf8')) as BrokerReceipt; }
  catch { return undefined; }
  if (receipt.brokerId !== brokerId || receipt.incarnation !== incarnation || !Number.isSafeInteger(receipt.pid) || receipt.pid <= 1 || !['active', 'closed'].includes(receipt.state)) return undefined;
  if (receipt.state === 'closed') return false;
  if (!receipt.processStart) return undefined;
  const currentStart = await readProcessStart(receipt.pid);
  if (currentStart === undefined) return undefined;
  if (currentStart === null || currentStart !== receipt.processStart) return false;
  return true;
}

function receiptPath(directory: string, brokerId: string, incarnation: string): string {
  // Broker ids and incarnations are kept out of path components.
  return join(directory, `${createHash('sha256').update(`${brokerId}\0${incarnation}`).digest('hex')}.json`);
}

/** null means the process is gone, undefined means liveness could not be proven. */
async function readProcessStart(pid: number): Promise<string | null | undefined> {
  if (process.platform !== 'linux') return undefined;
  let stat: string;
  try { stat = await readFile(`/proc/${pid}/stat`, 'utf8'); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ESRCH') return null;
    return undefined;
  }
  const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
  const state = fields[0];
  if (state === 'Z' || state === 'X') return null;
  const start = fields[19];
  return start && /^\d+$/.test(start) ? start : undefined;
}
