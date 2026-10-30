import { BlockList, isIP } from 'node:net';

// No proxy is trusted implicitly, including loopback. The hosting configuration
// must establish which peers append the real client address to X-Forwarded-For.
export function clientAddressResolver(trustedProxyIps = []) {
  if (!Array.isArray(trustedProxyIps) || trustedProxyIps.length > 32) throw new TypeError('trustedProxyIps must be an explicit list of at most 32 IP addresses');
  const trusted = new BlockList();
  const valid = (value) => typeof value === 'string' && !value.includes('%') && isIP(value);
  for (const address of trustedProxyIps) {
    if (!valid(address)) throw new TypeError('trustedProxyIps requires exact IP addresses, without ranges or ports');
    trusted.addAddress(address, isIP(address) === 6 ? 'ipv6' : 'ipv4');
  }
  const isTrusted = (address) => valid(address) && trusted.check(address, isIP(address) === 6 ? 'ipv6' : 'ipv4');
  return (socketAddress, forwardedFor) => {
    const peer = valid(socketAddress) ? socketAddress : null;
    if (!peer || !isTrusted(peer) || typeof forwardedFor !== 'string' || forwardedFor.length > 2048) return peer;
    const chain = forwardedFor.split(',').map((value) => value.trim());
    if (!chain.length || chain.length > 16 || chain.some((address) => !valid(address))) return peer;
    // An attacker can prepend arbitrary values; only the closest untrusted hop
    // after the explicitly trusted proxies is a defensible client identity.
    for (let i = chain.length - 1; i >= 0; i--) if (!isTrusted(chain[i])) return chain[i];
    return chain[0];
  };
}
