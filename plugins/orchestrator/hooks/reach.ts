// hooks/reach.ts
// The ssh destinations a machine may be reached by from another one, as it learns them by itself:
// its user at the address its own router gives it on the internet (UPnP, asked on the local network
// only: no outside service), at each of its local network addresses, and at its `.local` name. A
// remote row carries them (remote-row.ts `reach`) and the coordinator's machine tries each, keeping
// the one whose host name is the row's machine (remote-view.ts). Pure on purpose but for `reachOf`,
// which runs the reads through the host it is handed, and never holds a send past its wait.
import { reachShaped } from './remote-row.ts'
import type { Host } from './host.ts'

// The question to the router, in Python's standard library: an SSDP search for an internet gateway
// on the local network, then its GetExternalIPAddress. It prints the address alone, or nothing.
export const UPNP_SCRIPT = [
  'import re, socket, urllib.request',
  'ST = "urn:schemas-upnp-org:device:InternetGatewayDevice:1"',
  's = socket.socket(socket.AF_INET, socket.SOCK_DGRAM); s.settimeout(2)',
  's.sendto(("M-SEARCH * HTTP/1.1\\r\\nHOST: 239.255.255.250:1900\\r\\nMAN: \\"ssdp:discover\\"\\r\\nMX: 1\\r\\nST: %s\\r\\n\\r\\n" % ST).encode(), ("239.255.255.250", 1900))',
  'locs = []',
  'try:',
  '    while len(locs) < 4:',
  '        m = re.search(r"(?im)^location:\\s*(\\S+)", s.recvfrom(4096)[0].decode(errors="replace"))',
  '        if m and m.group(1) not in locs: locs.append(m.group(1))',
  'except OSError: pass',
  'for loc in locs:',
  '    try:',
  '        desc = urllib.request.urlopen(loc, timeout=3).read().decode(errors="replace")',
  '        base = re.match(r"(https?://[^/]+)", loc).group(1)',
  '        for kind in ("WANIPConnection", "WANPPPConnection"):',
  '            m = re.search(r"<serviceType>(urn:schemas-upnp-org:service:%s:\\d)</serviceType>.*?<controlURL>([^<]+)</controlURL>" % kind, desc, re.S)',
  '            if not m: continue',
  '            url = m.group(2) if m.group(2).startswith("http") else base + m.group(2)',
  '            body = \'<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:GetExternalIPAddress xmlns:u="%s"/></s:Body></s:Envelope>\' % m.group(1)',
  '            req = urllib.request.Request(url, body.encode(), {"Content-Type": "text/xml", "SOAPAction": \'"%s#GetExternalIPAddress"\' % m.group(1)})',
  '            ip = re.search(r"<NewExternalIPAddress>([0-9.]+)<", urllib.request.urlopen(req, timeout=3).read().decode(errors="replace"))',
  '            if ip:',
  '                print(ip.group(1)); raise SystemExit(0)',
  '    except (OSError, ValueError, AttributeError): pass',
].join('\n')

export const UPNP_ARGV = ['python3', '-I', '-c', UPNP_SCRIPT] as const
// The local network addresses macOS gives its first two interfaces.
export const LAN_ARGVS = [['ipconfig', 'getifaddr', 'en0'], ['ipconfig', 'getifaddr', 'en1']] as const

const IPV4 = /^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)$/

// An address a read printed: its one line when it is an IPv4 address, else none.
export function addressOf(stdout: string): string | null {
  const line = stdout.trim()
  return IPV4.test(line) ? line : null
}

// The destinations, in the order they are tried: the internet address first (the one a machine on
// another network reaches), then the local ones, then the `.local` name. A user or a part not of a
// destination's shape gives none.
export function reachFrom(user: string, label: string, publicAddress: string | null, lan: readonly (string | null)[]): string[] {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(user)) return []
  const hosts = [publicAddress, ...lan, label && label !== 'unknown' ? `${label}.local` : null]
  return [...new Set(hosts.flatMap(host => host ? [`${user}@${host}`] : []).filter(reachShaped))]
}

// How long what was learnt holds: an address changes seldom.
export const REACH_EVERY_MS = 60 * 60 * 1000
// How long a send waits on a learning before it goes with what was known: well under the turn
// end's bound (supervision.ts RELAY_BOUND_MS), since the router's search alone waits 2 s.
export const REACH_WAIT_MS = 1000
const UPNP_TIMEOUT_MS = 8000
const LAN_TIMEOUT_MS = 2000

let learnt: { at: number; value: string[] } | null = null
let learning: Promise<string[]> | null = null
// What to run once a learning that outlived its wait ends with something new: the row sent again.
const onLate = new Set<() => unknown>()

/** What was learnt forgotten, as at a module load. */
export function forgetReach(): void {
  learnt = null
  learning = null
  onLate.clear()
}

async function learn($: Host<'env' | 'process'>, label: string): Promise<string[]> {
  const user = (await $.env.get('USER')) ?? ''
  const read = async (argv: readonly string[], timeoutMs: number) => {
    const run = await $.process.run([...argv], { timeoutMs }).catch(() => null)
    return run?.exitCode === 0 ? addressOf(String(run.stdout ?? '')) : null
  }
  const publicAddress = await read(UPNP_ARGV, UPNP_TIMEOUT_MS)
  const lan = await Promise.all(LAN_ARGVS.map(argv => read(argv, LAN_TIMEOUT_MS)))
  return reachFrom(user, label, publicAddress, lan)
}

// This machine's destinations, learnt at most once per bound. A send never waits on the router past
// `waitMs`: past it, it goes with what was known before, and `onChange` runs once the learning
// ends, if what it learnt differs; a read that fails gives none of its part.
export async function reachOf($: Host<'env' | 'process'>, label: string, now = Date.now(), onChange?: () => unknown, waitMs = REACH_WAIT_MS): Promise<string[]> {
  if (learnt && now - learnt.at < REACH_EVERY_MS) return learnt.value
  const before = learnt?.value ?? []
  if (!learning) {
    const run: Promise<string[]> = learn($, label).catch(() => [] as string[]).then(value => {
      if (learning === run) {
        learnt = { at: now, value }
        learning = null
        const late = [...onLate]
        onLate.clear()
        if (JSON.stringify(value) !== JSON.stringify(before)) for (const fn of late) void Promise.resolve().then(fn).catch(() => undefined)
      }
      return value
    })
    learning = run
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  const waited = new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), waitMs) })
  try {
    const value = await Promise.race([learning, waited])
    if (value !== null) return value
  } finally {
    clearTimeout(timer)
  }
  if (onChange) onLate.add(onChange)
  return before
}
