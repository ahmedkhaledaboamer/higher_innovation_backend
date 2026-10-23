import { describe, expect, it, vi } from 'vitest';
import { ensureSrvResolvable, PUBLIC_DNS_SERVERS } from '../src/database/srvDns.js';

/** Development-only fallback to public DNS when the local resolver refuses SRV queries. Offline: the resolver is faked. */
const SRV = 'mongodb+srv://u:p@cluster0.abcde.example.net/academy_crm_dev?retryWrites=true';
const failing = (code: string) => ({ resolveSrv: vi.fn(async () => Promise.reject(Object.assign(new Error(`querySrv ${code}`), { code }))) });

describe('ensureSrvResolvable', () => {
  it('switches to public resolvers when the local DNS refuses the SRV lookup in development', async () => {
    for (const code of ['EREFUSED', 'ECONNREFUSED', 'ETIMEOUT', 'ESERVFAIL']) {
      const resolver = failing(code);
      const apply = vi.fn();
      await expect(ensureSrvResolvable(SRV, true, resolver, apply), code).resolves.toBe(true);
      expect(resolver.resolveSrv).toHaveBeenCalledWith('_mongodb._tcp.cluster0.abcde.example.net');
      expect(apply).toHaveBeenCalledWith(PUBLIC_DNS_SERVERS);
    }
  });

  it('changes nothing when the lookup works or the name does not exist', async () => {
    const apply = vi.fn();
    await expect(ensureSrvResolvable(SRV, true, { resolveSrv: vi.fn(async () => [{ name: 'x', port: 27017 }]) }, apply)).resolves.toBe(false);
    await expect(ensureSrvResolvable(SRV, true, failing('ENOTFOUND'), apply)).resolves.toBe(false);
    await expect(ensureSrvResolvable(SRV, true, failing('ENODATA'), apply)).resolves.toBe(false);
    expect(apply).not.toHaveBeenCalled();
  });

  it('never applies outside development or for non-SRV connection strings', async () => {
    const resolver = failing('EREFUSED');
    const apply = vi.fn();
    await expect(ensureSrvResolvable(SRV, false, resolver, apply)).resolves.toBe(false);
    await expect(ensureSrvResolvable('mongodb://127.0.0.1:27017/academy_crm_dev', true, resolver, apply)).resolves.toBe(false);
    await expect(ensureSrvResolvable('not a uri', true, resolver, apply)).resolves.toBe(false);
    expect(resolver.resolveSrv).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();
  });

  it('is applied by connectDatabase only in development', async () => {
    const source = await import('node:fs').then((fs) => fs.readFileSync(new URL('../src/database/mongoose.ts', import.meta.url), 'utf8'));
    const body = source.slice(source.indexOf('export async function connectDatabase'));
    expect(body).toMatch(/const development = env\.NODE_ENV === 'development' && \(env\.DEPLOY_ENV === undefined \|\| env\.DEPLOY_ENV === 'development'\);/);
    expect(body.indexOf('assertDatabaseTarget(uri)')).toBeLessThan(body.indexOf('ensureSrvResolvable(uri, development)'));
    expect(body.indexOf('ensureSrvResolvable(uri, development)')).toBeLessThan(body.indexOf('verifyOnProbe(uri'));
  });
});
