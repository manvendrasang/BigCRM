/**
 * SSRF guard (RULE 39, RULE 88, scenario 7).
 *
 * Any "fetch a URL" feature must never reach loopback, RFC1918,
 * link-local (which includes the 169.254.169.254 cloud-metadata endpoint),
 * carrier-grade NAT, multicast, or internal DNS. Resolution happens up-front so
 * a DNS-rebinding second hop cannot sneak past a hostname string check.
 */
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { badRequest } from './errors.ts';

export type UrlVerdict = { allowed: true; url: URL; addresses: string[] } | { allowed: false; reason: string };

const BLOCKED_V4: [string, number][] = [
 ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
 ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
 ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
 ['224.0.0.0', 4], ['240.0.0.0', 4],
];

const v4ToInt = (ip: string): number => ip.split('.').reduce((acc, o) => ((acc << 8) + Number(o)) >>> 0, 0);

export function isBlockedIPv4(ip: string): boolean {
 const n = v4ToInt(ip);
 return BLOCKED_V4.some(([net, bits]) => {
 const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
 return (n & mask) === (v4ToInt(net) & mask);
 });
}

/**
 * Expands an IPv6 literal into its eight 16-bit groups, or `null` if it is not
 * a well-formed address. Zone ids (`%eth0`) are stripped.
 *
 * This exists because a textual match is not a structural one. `new URL()`
 * applies the WHATWG IPv4-mapped normalisation, so `::ffff:127.0.0.1` reaches
 * this module as the hex form `::ffff:7f00:1`. A regex written against the
 * dotted form therefore never fires, and every blocked range becomes reachable
 * by writing the same address in hex -- including the cloud-metadata endpoint.
 */
function expandIPv6(ip: string): number[] | null {
 const text = ip.toLowerCase().split('%')[0]!;
 if (!text.includes(':')) return null;

 // An embedded dotted-quad tail (`::ffff:127.0.0.1`) is expanded to two groups
 // so the rest of the parser only ever deals with hex.
 let body = text;
 const dotted = text.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
 if (dotted) {
 if (isBlockedIPv4(dotted[1]!)) return [0, 0, 0, 0, 0, 0xffff, 0xffff, 0]; // sentinel: blocked
 const n = v4ToInt(dotted[1]!);
 body = `${text.slice(0, dotted.index)}${((n >>> 16) & 0xffff).toString(16)}:${(n & 0xffff).toString(16)}`;
 }

 const [headText, tailText, ...rest] = body.split('::');
 if (rest.length > 0) return null; // more than one `::` is malformed

 const parseGroups = (segment: string): number[] | null => {
 if (segment === '') return [];
 const out: number[] = [];
 for (const part of segment.split(':')) {
 if (!/^[0-9a-f]{1,4}$/.test(part)) return null;
 out.push(parseInt(part, 16));
 }
 return out;
 };

 const head = parseGroups(headText!);
 const tail = tailText === undefined ? null : parseGroups(tailText);
 if (head === null || (tailText !== undefined && tail === null)) return null;

 if (tailText === undefined) return head.length === 8 ? head : null;

 const groups = [...head, ...Array(8 - head.length - tail!.length).fill(0), ...tail!];
 return groups.length === 8 ? groups : null;
}

export function isBlockedIPv6(ip: string): boolean {
 const groups = expandIPv6(ip);
 // Not a parsable IPv6 literal: fail closed rather than assume it is public.
 if (groups === null) return true;
 // `expandIPv6` signals "embedded dotted-quad was blocked" with this sentinel.
 if (groups[0] === 0 && groups[1] === 0 && groups[2] === 0 && groups[3] === 0 &&
 groups[4] === 0 && groups[5] === 0xffff && groups[6] === 0xffff && groups[7] === 0) return true;

 const g = (i: number) => groups[i]!;

 // Unspecified (::) and loopback (::1).
 if (groups.slice(0, 7).every((v) => v === 0) && (g(7) === 0 || g(7) === 1)) return true;
 // Link-local fe80::/10 and unique-local fc00::/7.
 if ((g(0) & 0xffc0) === 0xfe80) return true;
 if ((g(0) & 0xfe00) === 0xfc00) return true;
 // Multicast ff00::/8 and deprecated site-local fec0::/10.
 if ((g(0) & 0xff00) === 0xff00) return true;
 if ((g(0) & 0xffc0) === 0xfec0) return true;
 // Documentation range 2001:db8::/32 is not routable; treat as blocked.
 if (g(0) === 0x2001 && g(1) === 0x0db8) return true;

 // IPv4-mapped ::ffff:a.b.c.d and IPv4-compatible ::a.b.c.d.
 if (g(0) === 0 && g(1) === 0 && g(2) === 0 && g(3) === 0 && g(4) === 0 && (g(5) === 0xffff || g(5) === 0)) {
 return isBlockedIPv4(`${g(6) >>> 8}.${g(6) & 0xff}.${g(7) >>> 8}.${g(7) & 0xff}`);
 }

 // 6to4 2002::/16 embeds the v4 address in the next 32 bits.
 if (g(0) === 0x2002) {
 return isBlockedIPv4(`${g(1) >>> 8}.${g(1) & 0xff}.${g(2) >>> 8}.${g(2) & 0xff}`);
 }

 // NAT64 64:ff9b::/96 (and the local-use 64:ff9b:1::/48) embeds a v4 address
 // in the last 32 bits, which reaches loopback on any translating network.
 if (g(0) === 0x0064 && g(1) === 0xff9b) {
 return isBlockedIPv4(`${g(6) >>> 8}.${g(6) & 0xff}.${g(7) >>> 8}.${g(7) & 0xff}`);
 }

 return false;
}

export const isBlockedAddress = (ip: string): boolean => {
 const v = isIP(ip);
 if (v === 4) return isBlockedIPv4(ip);
 if (v === 6) return isBlockedIPv6(ip);
 return true; // not an IP literal -> treat as unsafe
};

/** Hostnames that must never be dialled even if they resolve to a public IP. */
const BLOCKED_HOSTNAMES = new Set([
 'localhost', 'localhost.localdomain', 'ip6-localhost', 'ip6-loopback',
 'metadata', 'metadata.google.internal', 'metadata.goog',
 'instance-data', '169.254.169.254',
]);

/**
 * Validates a user-supplied URL and resolves it, returning every address that
 * will actually be contacted. All addresses must clear the blocklist.
 */
export async function validateOutboundUrl(raw: unknown, opts: { protocols?: string[] } = {}): Promise<UrlVerdict> {
 const allowed = opts.protocols ?? ['https:', 'http:'];
 if (typeof raw !== 'string' || raw.trim() === '') return { allowed: false, reason: 'URL is required.' };
 let url: URL;
 try { url = new URL(raw.trim()); } catch { return { allowed: false, reason: 'Malformed URL.' }; }

 if (!allowed.includes(url.protocol)) {
 return { allowed: false, reason: `Protocol ${url.protocol} is not permitted.` };
 }
 if (url.username || url.password) {
 return { allowed: false, reason: 'URLs must not embed credentials.' };
 }
 const host = url.hostname.toLowerCase().replace(/\.$/, '');
 if (!host) return { allowed: false, reason: 'URL has no host.' };
 if (host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.localhost')) {
 return { allowed: false, reason: 'Internal hostname is not permitted.' };
 }
 if (BLOCKED_HOSTNAMES.has(host)) return { allowed: false, reason: 'Host is not permitted.' };
 if (host.startsWith('.') || host.includes('..')) return { allowed: false, reason: 'Malformed hostname.' };

 const literal = isIP(host.replace(/^\[|\]$/g, ''));
 if (literal) {
 const ip = host.replace(/^\[|\]$/g, '');
 if (isBlockedAddress(ip)) return { allowed: false, reason: 'Address is in a blocked range.' };
 return { allowed: true, url, addresses: [ip] };
 }

 let addresses: string[];
 try {
 const res = await lookup(host, { all: true, verbatim: true });
 addresses = res.map((r) => r.address);
 } catch {
 return { allowed: false, reason: 'Host could not be resolved.' };
 }
 if (addresses.length === 0) return { allowed: false, reason: 'Host resolved to no addresses.' };
 for (const ip of addresses) {
 if (isBlockedAddress(ip)) {
 return { allowed: false, reason: 'Host resolves to a blocked internal address.' };
 }
 }
 return { allowed: true, url, addresses };
}

export const assertOutboundUrl = async (raw: unknown, opts?: { protocols?: string[] }): Promise<URL> => {
 const v = await validateOutboundUrl(raw, opts);
 if (!v.allowed) throw badRequest(v.reason);
 return v.url;
};
