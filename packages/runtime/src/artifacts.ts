import { createHash, randomBytes } from 'node:crypto';
import { mkdir, open } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { ArtifactChunk } from '@subzero/core';

export type ArtifactStoreOptions = { maxChunkBytes?: number; previewBytes?: number };

/** Local append-free artifact storage. IDs are random opaque filenames and writes are create-only. */
export class LocalArtifactStore {
  private readonly root: string;
  private readonly maxChunkBytes: number;
  private readonly previewBytes: number;
  constructor(root: string, options: ArtifactStoreOptions = {}) {
    this.root = resolve(root);
    this.maxChunkBytes = positiveInteger(options.maxChunkBytes, 64 * 1024, 'maxChunkBytes');
    this.previewBytes = positiveInteger(options.previewBytes, 2048, 'previewBytes');
  }

  async write(runId: string, content: string): Promise<{ artifactId: string; preview: string }> {
    if (!runId || typeof content !== 'string') throw new TypeError('runId and string content are required.');
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    for (let attempt = 0; attempt < 3; attempt++) {
      const artifactId = randomBytes(32).toString('hex');
      const path = this.pathFor(artifactId);
      try {
        const runsDir = join(this.root, '.runs');
        await mkdir(runsDir, { recursive: true, mode: 0o700 });
        const runKey = createHash('sha256').update(runId, 'utf8').digest('hex');
        let marker;
        try { marker = await open(join(runsDir, `${runKey}.json`), 'wx', 0o600); }
        catch (error) {
          if ((error as { code?: string }).code === 'EEXIST') throw new Error('Artifact for this run is already immutable.');
          throw error;
        }
        try { await marker.writeFile(JSON.stringify({ artifactId }), 'utf8'); await marker.sync(); }
        finally { await marker.close(); }
        const file = await open(path, 'wx', 0o600);
        try { await file.writeFile(content, { encoding: 'utf8' }); await file.sync(); }
        finally { await file.close(); }
        return { artifactId, preview: utf8Prefix(Buffer.from(content, 'utf8'), this.previewBytes).text };
      } catch (error) {
        if ((error as { code?: string }).code !== 'EEXIST' || attempt === 2) throw error;
      }
    }
    throw new Error('Could not allocate an artifact identifier.');
  }

  async read(artifactId: string, offset: number, length: number): Promise<ArtifactChunk> {
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 1 || length > this.maxChunkBytes) throw new RangeError(`Artifact reads are limited to ${this.maxChunkBytes} bytes.`);
    const file = await open(this.pathFor(artifactId), 'r');
    try {
      const size = (await file.stat()).size;
      if (offset > size) throw new RangeError('Artifact offset is beyond the end of the file.');
      if (offset < size) {
        const probe = Buffer.alloc(1);
        await file.read(probe, 0, 1, offset);
        if (isContinuationByte(probe[0]!)) throw new RangeError('Artifact offset must be a valid UTF-8 byte boundary.');
      }
      const readLength = Math.min(size - offset, length + 3);
      const data = Buffer.alloc(readLength);
      const { bytesRead } = await file.read(data, 0, readLength, offset);
      const chunk = utf8Prefix(data.subarray(0, bytesRead), length);
      if (chunk.bytes.length === 0 && offset < size) throw new RangeError('Read length is too small for the next UTF-8 code point.');
      const nextOffset = offset + chunk.bytes.length;
      return { artifactId, offset, text: chunk.text, nextOffset, eof: nextOffset >= size };
    } finally { await file.close(); }
  }

  private pathFor(id: string): string {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new TypeError('Invalid artifact identifier.');
    const path = resolve(this.root, `${id}.artifact`);
    const fromRoot = relative(this.root, path);
    if (fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) throw new TypeError('Invalid artifact identifier.');
    return path;
  }
}

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  const result = value ?? fallback;
  if (!Number.isInteger(result) || result < 1) throw new RangeError(`${name} must be a positive integer.`);
  return result;
}
function isContinuationByte(byte: number): boolean { return (byte & 0xc0) === 0x80; }
function decodeUtf8(bytes: Buffer): string { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
function utf8Prefix(buffer: Buffer, maxBytes: number): { bytes: Buffer; text: string } {
  let end = Math.min(maxBytes, buffer.length);
  while (end >= 0) {
    try { const bytes = buffer.subarray(0, end); return { bytes, text: decodeUtf8(bytes) }; }
    catch { end--; }
  }
  return { bytes: Buffer.alloc(0), text: '' };
}
