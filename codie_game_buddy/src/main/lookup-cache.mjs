import fs from 'node:fs';
import path from 'node:path';

// A key nothing was found for is looked up again after this.
export const MISS_RETRY_MS = 24 * 60 * 60 * 1000;
// A lookup that failed (the site refused or did not answer) is tried again
// after this: the key may well have a value.
export const FAILED_RETRY_MS = 10 * 60 * 1000;

const readJson = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; } };

// Wiki lookups (game backgrounds, on-screen terms) cached in a JSON file under
// userData, as { [keyOf(args)]: { value, at } }. get() never waits on the
// network: a key it has nothing for is looked up in the background and is
// there from the next get on. A miss or a failed lookup is cached as null,
// the failed one marked so it is retried sooner.
export function createLookupCache({ file, keyOf, lookup, label, now = Date.now, log = () => {} }) {
  let cache = readJson(file);
  if (typeof cache !== 'object' || cache === null || Array.isArray(cache)) cache = {};
  const inflight = new Map();

  function save() {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, `${JSON.stringify(cache, null, 2)}\n`);
      fs.renameSync(tmp, file);
    } catch (e) {
      log(`${label}: could not save (${e.message})`);
    }
  }

  function fetchValue(key, args) {
    const run = lookup(args)
      .then(value => ({ value: value ?? null }), error => ({ value: null, failed: true, error }))
      .then(({ value, failed, error }) => {
        cache = { ...cache, [key]: { value, at: now(), ...(failed && { failed }) } };
        save();
        log(value ? `${label}: ${key}` : failed ? `${label}: lookup failed for ${key} (${error?.message ?? error})` : `${label}: nothing for ${key}`);
      })
      .finally(() => inflight.delete(key));
    inflight.set(key, run);
  }

  return {
    // The cached value for args, or null (a lookup may start).
    get(args) {
      const key = keyOf(args);
      const entry = cache[key];
      if (entry?.value) return entry.value;
      if (!inflight.has(key) && !(entry && now() - entry.at < (entry.failed ? FAILED_RETRY_MS : MISS_RETRY_MS))) fetchValue(key, args);
      return null;
    },
    // Whether a lookup for args has finished, found or not.
    settled(args) {
      return Boolean(cache[keyOf(args)]);
    },
    // Resolves once no lookup is running (tests).
    async idle() { await Promise.all(inflight.values()); },
  };
}
