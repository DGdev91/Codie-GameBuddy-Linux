import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// Each entry point package.json exports must load: a re-export of a name its
// module no longer has fails only at import time.
test('every exported entry point loads', async () => {
  const { exports } = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
  for (const [name, file] of Object.entries(exports)) {
    const m = await import(new URL(`../../${file}`, import.meta.url));
    assert.ok(Object.keys(m).length > 0, `${name} exports something`);
  }
});
