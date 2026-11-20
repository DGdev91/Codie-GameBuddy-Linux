import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redactSecrets } from '../../src/agentd/redact.mjs';

test('redactSecrets hides well-known credential shapes', () => {
  const cases = [
    ['export OPENAI_API_KEY=sk-proj-abcdefghijklmnop1234', 'export OPENAI_API_KEY=…'],
    ['key sk-ant-api03-AAAAAAAAAAAAAAAAAAAA in use', 'key … in use'],
    ['push with ghp_ABCDEFGHIJKLMNOPQRSTuvwx', 'push with …'],
    ['curl -H "Authorization: Bearer abc.def-123456"', 'curl -H "Authorization: Bearer …"'],
    ['AWS AKIAABCDEFGHIJKLMNOP set', 'AWS … set'],
    ['jwt eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0.SflKxwRJSMeKKF2QT4f', 'jwt …'],
    ['password: hunter22', 'password: …'],
    ['DB_PASSWORD="s3cr3t-value"', 'DB_PASSWORD="…"'],
    ['charge with sk_live_51Habcdefghijklmnop', 'charge with …'],
    ['key -----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXk\n-----END OPENSSH PRIVATE KEY----- added', 'key … added'],
    ['clone https://bob:hunter2pw@git.example.com/x.git', 'clone https://bob:…@git.example.com/x.git'],
  ];
  for (const [input, expected] of cases) assert.equal(redactSecrets(input), expected, input);
});

test('redactSecrets leaves ordinary text alone', () => {
  for (const s of ['All 386 tests pass.', 'max_tokens: 4096', 'Ask for a token?', 'Run npm test in codie-host.', '电脑上的任务完成了。', 'task-skeleton ready']) {
    assert.equal(redactSecrets(s), s);
  }
});
