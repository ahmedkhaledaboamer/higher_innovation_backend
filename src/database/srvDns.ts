import dns from 'node:dns';
import { mongoUriParts } from '../config/mongoUri.js';

/** Public resolvers used when the local DNS refuses SRV queries (development only). */
export const PUBLIC_DNS_SERVERS = ['8.8.8.8', '1.1.1.1'] as const;

/** Resolver answers that mean "this DNS server will not answer", not "the name does not exist". */
const RESOLVER_REFUSALS = new Set(['EREFUSED', 'ECONNREFUSED', 'ETIMEOUT', 'ESERVFAIL']);

interface SrvResolver {
  resolveSrv(hostname: string): Promise<unknown>;
}

function usePublicResolvers(servers: readonly string[]): void {
  dns.setServers([...servers]);
  dns.promises.setServers([...servers]);
}

/**
 * Development convenience. A mongodb+srv:// string needs a DNS SRV lookup, and some home routers
 * refuse SRV queries ("querySrv EREFUSED"); MongoDB Compass copes with that, Node does not. When the
 * local resolver refuses the lookup in development, this process switches to public resolvers.
 * Nothing changes outside development, for non-SRV strings, or when the name simply does not exist.
 * TLS still verifies the cluster's certificate, so a resolver cannot redirect the connection unnoticed.
 *
 * Returns true when the fallback was applied.
 */
export async function ensureSrvResolvable(
  uri: string,
  development: boolean,
  resolver: SrvResolver = dns.promises,
  apply: (servers: readonly string[]) => void = usePublicResolvers,
): Promise<boolean> {
  const { srv, hosts } = mongoUriParts(uri);
  if (!development || !srv || hosts.length !== 1) return false;
  try {
    await resolver.resolveSrv(`_mongodb._tcp.${hosts[0]}`);
    return false;
  } catch (error) {
    if (!RESOLVER_REFUSALS.has((error as NodeJS.ErrnoException).code ?? '')) return false;
  }
  apply(PUBLIC_DNS_SERVERS);
  return true;
}
