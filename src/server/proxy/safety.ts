import { isIP } from 'node:net';

function ipv4Number(address: string): number {
  return address.split('.').reduce((value, part) => value * 256 + Number(part), 0) >>> 0;
}

function inV4Range(address: string, network: string, bits: number): boolean {
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (ipv4Number(address) & mask) === (ipv4Number(network) & mask);
}

export function isUnsafeAddress(input: string): boolean {
  const address = input.toLowerCase().split('%')[0];
  if (isIP(address) === 4) {
    return [
      ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
      ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16],
      ['198.18.0.0', 15], ['224.0.0.0', 4], ['240.0.0.0', 4],
    ].some(([network, bits]) => inV4Range(address, String(network), Number(bits)));
  }
  if (isIP(address) === 6) {
    const value = ipv6Number(address);
    if (value === null) return true;
    if ((value >> 32n) === 0xffffn) {
      const mapped = Number(value & 0xffffffffn);
      return isUnsafeAddress(`${mapped >>> 24}.${(mapped >>> 16) & 255}.${(mapped >>> 8) & 255}.${mapped & 255}`);
    }
    // Public IPv6 is global unicast (2000::/3), minus IANA special-purpose ranges.
    if (!inV6Range(value, ipv6Number('2000::')!, 3)) return true;
    return [
      ['2001::', 23],         // IETF protocol assignments and reserved sub-ranges
      ['2001:db8::', 32],    // documentation
      ['2001:20::', 28],     // ORCHIDv2
      ['2002::', 16],         // deprecated 6to4 (may embed an unsafe IPv4 target)
      ['3fff::', 20],         // documentation
    ].some(([network, bits]) => inV6Range(value, ipv6Number(String(network))!, Number(bits)));
  }
  return true;
}

function ipv6Number(address: string): bigint | null {
  let source = address;
  const dotted = source.match(/(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  if (dotted) {
    if (isIP(dotted) !== 4) return null;
    const value = ipv4Number(dotted);
    source = source.slice(0, -dotted.length) + `${(value >>> 16).toString(16)}:${(value & 0xffff).toString(16)}`;
  }
  const halves = source.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  if (halves.length === 1 && left.length !== 8) return null;
  const missing = 8 - left.length - right.length;
  if (missing < (halves.length === 2 ? 1 : 0)) return null;
  const groups = [...left, ...Array(missing).fill('0'), ...right];
  if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/i.test(group))) return null;
  return groups.reduce((result, group) => (result << 16n) | BigInt(`0x${group}`), 0n);
}

function inV6Range(address: bigint, network: bigint, bits: number): boolean {
  const shift = 128n - BigInt(bits);
  return (address >> shift) === (network >> shift);
}
