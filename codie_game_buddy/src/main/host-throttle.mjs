// A fetch whose requests to one host start at least `gapMs` apart, in the
// order they were made, whichever lookup makes them. BWIKI's firewall answers
// bursts with HTTP 514 or 567 and then blocks every request for a while
// (measured 2026-11-10), so the guide lookups of several games and pages
// share one queue per host (spec §4.1.4).

export const HOST_GAP_MS = 1_000;

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

export function throttleByHost(fetch, { gapMs = HOST_GAP_MS, now = Date.now, sleep = pause } = {}) {
  const lastStart = new Map(); // host -> promise of when its last request started
  return (url, init) => {
    const host = new URL(url).host;
    const start = (lastStart.get(host) ?? Promise.resolve(-Infinity)).then(async last => {
      const wait = last + gapMs - now();
      if (wait > 0) await sleep(wait);
      return now();
    });
    lastStart.set(host, start);
    return start.then(() => fetch(url, init));
  };
}
