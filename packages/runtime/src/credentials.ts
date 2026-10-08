import { SubzeroError } from '@subzero/core';

export type CredentialReference = { env: string; origins: string[] };
export type CredentialMap = Record<string, CredentialReference>;

/** Resolves only explicitly named credentials and only for their configured URL origins. */
export class CredentialResolver {
  private readonly refs: Readonly<Record<string, CredentialReference>>;
  constructor(refs: CredentialMap) {
    const safe: Record<string, CredentialReference> = Object.create(null);
    for (const [name, ref] of Object.entries(refs)) {
      if (!name || !/^[A-Za-z0-9_.-]+$/.test(name) || !ref || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(ref.env) || !Array.isArray(ref.origins) || ref.origins.length === 0) throw new TypeError(`Invalid credential reference configuration: ${name}`);
      const origins = ref.origins.map(normalizeOrigin);
      safe[name] = Object.freeze({ env: ref.env, origins: Object.freeze(origins) as unknown as string[] });
    }
    this.refs = Object.freeze(safe);
  }

  configuredRefs(): string[] { return Object.keys(this.refs).sort(); }

  resolve(refName: string, url: string, env: NodeJS.ProcessEnv = process.env): { key: string } {
    const ref = Object.hasOwn(this.refs, refName) ? this.refs[refName] : undefined;
    if (!ref) throw new SubzeroError('credentials_required', `Unknown credential reference: ${refName}`);
    let origin: string;
    let target: URL;
    try {
      target = new URL(url);
      if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password) throw new Error();
      origin = target.origin;
    } catch { throw new Error('Credential target must be a valid HTTP(S) URL.'); }
    if (!ref.origins.includes(origin)) throw new Error(`Credential reference is not allowed for origin ${origin}.`);
    const key = env[ref.env];
    if (typeof key !== 'string' || key.length === 0) throw new SubzeroError('credentials_required', `Credential is not configured for reference: ${refName}`);
    if (urlContainsSecret(url, target, key)) throw new Error('Credential must not appear in the target URL.');
    return { key };
  }
}

function urlContainsSecret(rawUrl: string, target: URL, secret: string): boolean {
  const parts = [rawUrl, target.pathname, target.search, target.hash, ...target.searchParams.values()];
  return parts.some(part => {
    let candidate = part;
    for (let depth = 0; depth < 6; depth++) {
      if (candidate.includes(secret)) return true;
      let decoded: string;
      try { decoded = decodeURIComponent(candidate); }
      catch { return false; }
      if (decoded === candidate) return false;
      candidate = decoded;
    }
    return candidate.includes(secret);
  });
}

function normalizeOrigin(value: string): string {
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new TypeError('Credential origins must be HTTP(S) origins.'); }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== value.replace(/\/$/, '') || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) throw new TypeError('Credential origins must contain only an HTTP(S) origin.');
  return parsed.origin;
}
