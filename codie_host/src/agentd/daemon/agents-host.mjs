import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { DeviceClient } from '../tools/device-client.mjs';
import { AGENTS_CLIENT, integrationId } from '../tools/integration-id.mjs';
import { validateTools } from '../tools/catalog.mjs';
import { ToolLink } from '../tools/tool-link.mjs';
import { redactSecrets } from '../redact.mjs';
import { ACCEPTED_TIMEOUT, HANDED_OVER, CALL_ONCE } from '../texts.mjs';

// clt01 silently drops an announce longer than this many runes (code points)
// after trimming (devicecommand.go maxAnnounceRunes): every announce is clamped.
export const ANNOUNCE_MAX = 200;

export function clampAnnounce(text, max = ANNOUNCE_MAX) {
  const cps = [...String(text).trim()];
  return cps.length <= max ? cps.join('') : `${cps.slice(0, max - 1).join('')}…`;
}

export { AGENTS_CLIENT };
// clt01 caps a call at 20s; the answer must be on its way before then.
const CALL_TIMEOUT_MS = 20_000;
const ANSWER_MARGIN_MS = 2_000;
// A conversation turn's tool loop is over well within this.
const TURN_TTL_MS = 120_000;
// Before speaking, wait at most this long for the device to go idle.
const IDLE_WAIT_MS = 60_000;
const IDLE_POLL_MS = 1_000;
const sleep = ms => new Promise(r => { const t = setTimeout(r, ms); t.unref?.(); });

const ASK_RESULT = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['accepted', 'rejected', 'done'] },
    task_id: { type: 'string' },
    message: { type: 'string' },
  },
  required: ['status'],
  additionalProperties: false,
};

// clt01 refuses a changed tool under the same version (TOOL_VERSION_CONFLICT):
// bump `version` with any change to a tool's description or schemas.
export const AGENT_TOOLS = validateTools([
  {
    name: 'ask_agent', version: 'v7', risk: 'reversible', idempotent: false, confirmation_required: false, timeout_ms: CALL_TIMEOUT_MS,
    completion: 'async',
    description: 'How you act on the user\'s computer; requests go here by default, computer mentioned or not. Call it at once: never ask "shall I pass it on?". Only small talk and what another tool covers (alarms, music, lights...) stay with you; other tasks and questions go here, never from memory. An AI agent there does the work; results arrive elsewhere and may look pending: call once per new request. accepted means handed over, not done: say so, never guess. rejected: tell the user why; if it names sessions, ask which.',
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'The task in the user\'s words.' },
        mode: {
          type: 'string', enum: ['auto', 'idle', 'continue', 'session'],
          description: 'auto (default): an independent task. idle: the user requires an idle session; rejected when none is idle. continue: an unnamed follow-up such as "continue the previous task". session: the user named a session or project (give target).',
        },
        target: { type: 'string', description: 'Only with mode session: the exact session or project the user named. Never invent one.' },
      },
      required: ['prompt'],
      additionalProperties: false,
    },
    result_schema: ASK_RESULT,
  },
  {
    name: 'cancel_task', version: 'v2', risk: 'reversible', idempotent: true, confirmation_required: false, timeout_ms: 20_000,
    description: 'Stop a task handed to the computer with ask_agent, when the user asks to stop or cancel it. Without task_id, the latest task of this device.',
    parameters: { type: 'object', properties: { task_id: { type: 'string' } }, additionalProperties: false },
    result_schema: {
      type: 'object',
      properties: { status: { type: 'string', enum: ['canceled', 'not_found'] }, task_id: { type: 'string' } },
      required: ['status'],
      additionalProperties: false,
    },
  },
]);

// The ask_agent arguments as a router event's text/routing, or an error
// message.
export function askRequest(args) {
  const prompt = typeof args?.prompt === 'string' ? args.prompt.trim() : '';
  if (!prompt) return { error: 'The task prompt must not be empty.' };
  const mode = args.mode ?? 'auto';
  const target = typeof args.target === 'string' ? args.target.trim() : '';
  if (mode === 'session' && !target) return { error: 'Specify the session or project to continue.' };
  if (mode !== 'session' && target) return { error: 'Only session routing may specify a target session.' };
  if (mode === 'auto') return { text: prompt };
  return { text: prompt, routing: { mode, ...(mode === 'session' ? { target } : {}) } };
}

// Voice tasks from every paired device with a client credential, through
// tool hosting (spec §6.3): the device link the Router, App and Dispatcher
// use. The ask_agent call is the device's waiting call, answered by accept /
// sendResult / sendError; an accepted task's final answer is spoken on the
// device.
export class AgentsHost {
  // `onUnreachable(deviceId, error)` / `onReachable(deviceId)` hear whether a link's
  // publish reached its device's address (ToolLink).
  constructor({ store, tasks, onMessage, onCancel, onChange = () => {}, refuse = () => null, onUnreachable = () => {}, onReachable = () => {},
    log = () => {}, WebSocketImpl = WebSocket, fetchImpl = fetch, now = Date.now }) {
    Object.assign(this, { store, tasks, onMessage, onCancel, onChange, refuse, onUnreachable, onReachable, log, WebSocketImpl, fetchImpl, now });
    this.links = new Map(); // deviceId -> { link, record }
    this.calls = new Map(); // taskId -> { link, invocationId, timer }
    this.verbatimAt = new Map(); // deviceId -> when an answer or the agent's own words were last queued
    this.turns = new Map(); // `${deviceId}/${turn_id}` -> { taskId, data, at }: one task per voice turn
    this.voices = new Map(); // deviceId -> the promise of its last queued utterance
  }

  static serves(record) {
    return !!record?.credentialId;
  }

  // Starts a link for every pairing with a client credential, stops the
  // others (unpaired, credential or address changed).
  sync() {
    const wanted = new Map(this.store.listPairings().filter(AgentsHost.serves).map(r => [r.deviceId, r]));
    for (const [deviceId, { link, record }] of this.links) {
      const next = wanted.get(deviceId);
      const sameCredential = next && next.credentialSecret === record.credentialSecret;
      if (sameCredential && next.host === record.host && next.port === record.port) continue;
      link.stop();
      this.links.delete(deviceId);
      // A device that only moved keeps its tasks: their answers go out on the new link.
      if (!sameCredential) this.tasks.dropDevice(deviceId);
    }
    for (const [deviceId, record] of wanted) {
      if (this.links.has(deviceId)) continue;
      const link = new ToolLink({
        device: DeviceClient.forPairing(record, this.fetchImpl),
        integrationId: integrationId(deviceId, AGENTS_CLIENT),
        name: AGENTS_CLIENT, tools: AGENT_TOOLS, log: this.log, WebSocketImpl: this.WebSocketImpl,
        onInvoke: call => this.#invoke(deviceId, call),
        onState: () => this.onChange(),
        onUnreachable: e => this.onUnreachable(deviceId, e),
        onReachable: () => this.onReachable(deviceId),
      });
      this.links.set(deviceId, { link, record });
      link.start();
    }
  }

  // A pairing was removed or changed.
  pruneUnpaired() { this.sync(); }

  // Ends accepted tasks older than the max age with `text`.
  expireAccepted(text = ACCEPTED_TIMEOUT, maxAge = undefined) {
    const expired = this.tasks.expiredAccepted(maxAge);
    for (const t of expired) this.sendError(t.taskId, text);
    return expired.length;
  }

  close() {
    for (const { link } of this.links.values()) link.stop();
    this.links.clear();
    for (const c of this.calls.values()) clearTimeout(c.timer);
    this.calls.clear();
  }

  onlineDevices() {
    return [...this.links.values()].filter(({ link }) => link.online).map(({ record }) => record);
  }

  async #invoke(deviceId, call) {
    const entry = this.links.get(deviceId);
    if (!entry) return;
    const { link, record } = entry;
    const reply = data => link.sendResult(call.invocation_id, { status: 'succeeded', data });
    try {
      if (call.name === 'cancel_task') { reply(await this.#cancel(record, call.arguments?.task_id)); return; }
      if (call.name !== 'ask_agent') {
        link.sendResult(call.invocation_id, { status: 'failed', code: 'UNKNOWN_TOOL', message: call.name, data: {} });
        return;
      }
      // On firmware without `completion: 'async'` a model may call again in
      // the same turn: that is the same request, not a new
      // task (clt01 sends the turn id with every invoke).
      const turnKey = call.turn_id ? `${deviceId}/${call.turn_id}` : null;
      this.#pruneTurns();
      const same = turnKey && this.turns.get(turnKey);
      if (same) { reply(same.data ?? { status: 'accepted', task_id: same.taskId, message: CALL_ONCE }); return; }
      const request = askRequest(call.arguments);
      if (request.error) { reply({ status: 'rejected', message: request.error }); return; }
      const refusal = this.refuse(record);
      const task = refusal ? null : this.tasks.begin(deviceId, call.invocation_id);
      if (!task) { reply({ status: 'rejected', message: refusal || 'The previous task is still running. Please try again later.' }); return; }
      // Still not handed over close to clt01's deadline: answer now and keep
      // the task (accepted) — the Router's later accept is then a no-op and
      // its outcome, even a refusal, is spoken like any final answer.
      const wait = Math.max(0, (call.deadline_unix_ms ?? this.now() + (call.timeout_ms ?? CALL_TIMEOUT_MS)) - this.now() - ANSWER_MARGIN_MS);
      const timer = setTimeout(() => this.accept(task.taskId, HANDED_OVER), wait);
      timer.unref?.();
      this.calls.set(task.taskId, { link, invocationId: call.invocation_id, timer, turnKey });
      if (turnKey) this.turns.set(turnKey, { taskId: task.taskId, data: null, at: this.now() });
      this.onMessage({ taskId: task.taskId, deviceId, deviceName: record.name, ...request });
      this.onChange();
    } catch (e) {
      this.log('ask_agent failed', e);
      link.sendResult(call.invocation_id, { status: 'failed', code: 'AGENT_ERROR', message: String(e?.message ?? e).slice(0, 200), data: {} });
    }
  }

  #pruneTurns() {
    const cutoff = this.now() - TURN_TTL_MS;
    for (const [key, t] of this.turns) if (t.at < cutoff) this.turns.delete(key);
  }

  async #cancel(record, taskId) {
    const mine = this.tasks.pending().filter(t => t.deviceId === record.deviceId);
    const task = taskId ? mine.find(t => t.taskId === taskId) : mine.at(-1);
    if (!task) return { status: 'not_found' };
    this.tasks.setCancelRequested(task.taskId, true);
    try {
      await this.onCancel({ taskId: task.taskId, deviceId: record.deviceId, deviceName: record.name,
        ...(task.threadId ? { threadId: task.threadId, turnId: task.turnId } : {}) });
    } catch (e) { this.tasks.setCancelRequested(task.taskId, false); throw e; }
    this.#answerCall(task.taskId, { status: 'rejected', task_id: task.taskId, message: 'Cancelled.' });
    this.tasks.finish(task.taskId);
    this.onChange();
    return { status: 'canceled', task_id: task.taskId };
  }

  // Answers the task's open ask_agent call, once; false when there is none.
  #answerCall(taskId, data) {
    const c = this.calls.get(taskId);
    if (!c) return false;
    clearTimeout(c.timer);
    this.calls.delete(taskId);
    const turn = c.turnKey && this.turns.get(c.turnKey);
    if (turn) turn.data = data;
    return c.link.sendResult(c.invocationId, { status: 'succeeded', data });
  }

  accept(taskId, text) {
    const task = this.tasks.accept(taskId);
    if (!task) return false;
    this.#answerCall(taskId, { status: 'accepted', task_id: taskId, message: `${text} ${CALL_ONCE}` });
    this.onChange();
    return true;
  }

  // A waiting task's call returns the answer; an accepted task's answer is
  // spoken on its device, verbatim in the character's voice.
  sendResult(taskId, answer) {
    const text = redactSecrets(answer);
    const task = this.tasks.finish(taskId);
    if (!task) return false;
    const r = task.state === 'accepted'
      ? this.#speak(task.deviceId, text)
      : (this.#answerCall(taskId, { status: 'done', task_id: taskId, message: text }) || 'undelivered');
    this.onChange();
    return r;
  }

  // An error may quote an agent's own failure text (a Codex e.message).
  sendError(taskId, error) {
    const message = redactSecrets(error);
    const task = this.tasks.finish(taskId);
    if (!task) return false;
    const r = task.state === 'accepted'
      ? this.#speak(task.deviceId, message)
      : (this.#answerCall(taskId, { status: 'rejected', task_id: taskId, message }) || 'undelivered');
    this.onChange();
    return r;
  }

  // `verbatim`: the agent's own words (a codie_notify message), read as
  // written like a task answer; otherwise a reminder the device rephrases.
  // A reminder waits `delayMs` first, and is dropped (`onDropped` is told)
  // when `stale()` says the user has moved on by the time it would be spoken.
  announce(text, { quietMs = 0, verbatim = false, delayMs = 0, stale, onDropped } = {}) {
    let n = 0;
    const said = redactSecrets(text);
    for (const record of this.onlineDevices()) {
      if (this.isQuiet(record.deviceId, quietMs)) continue;
      this.#utter(record, said, verbatim, { delayMs, stale, onDropped });
      n++;
    }
    return n;
  }

  isQuiet(deviceId, quietMs) {
    return this.now() - (this.verbatimAt.get(deviceId) ?? -Infinity) < quietMs;
  }

  // Speaks a task answer: true once queued, 'offline' when the device's link
  // is down (nothing is kept for it).
  #speak(deviceId, text) {
    const entry = this.links.get(deviceId);
    if (!entry?.link.online) return 'offline';
    this.#utter(entry.record, text, true, {});
    return true;
  }

  // A task answer, or the agent's own words, goes to clt01 agent/results
  // (§12 C3), which queues it until the device is idle, reads it as written
  // and records it in the chat. A reminder is not part of the conversation:
  // it uses tts/utterances, which cuts off whatever the device is saying, so
  // what is said to one device goes one at a time, a reminder only after the
  // device is idle again. A refused one is retried a few times.
  #utter(record, text, verbatim, { delayMs = 0, stale, onDropped }) {
    if (verbatim) this.verbatimAt.set(record.deviceId, this.now());
    const prev = this.voices.get(record.deviceId) ?? Promise.resolve();
    const next = prev.then(async () => {
      if (delayMs) await sleep(delayMs);
      await this.#sayWhenIdle(record, text, verbatim, { stale, onDropped });
    });
    this.voices.set(record.deviceId, next);
  }

  // Waits for ai/backend `active_state` Idle, at most IDLE_WAIT_MS; firmware
  // without that state is not waited for.
  async #untilIdle(d) {
    const deadline = this.now() + IDLE_WAIT_MS;
    while (this.now() < deadline) {
      let state;
      try { state = (await d.request('GET', '/v1/api/data/user/ai/backend'))?.active_state; } catch { return; }
      if (!state || state === 'Idle') return;
      await sleep(IDLE_POLL_MS);
    }
  }

  async #sayWhenIdle(record, text, verbatim, drop, attempt = 0) {
    const d = DeviceClient.forPairing(record, this.fetchImpl);
    const dropped = () => drop.stale?.() && (drop.onDropped?.(), true);
    try {
      if (dropped()) return;
      if (verbatim) {
        await d.request('POST', '/v1/api/data/user/agent/results', { text: clampAnnounce(text) });
        return;
      }
      await this.#untilIdle(d);
      if (dropped()) return;
      const slot = (await d.request('GET', '/v1/api/data/user/slot'))?.slot_number;
      await d.request('POST', '/v1/api/data/user/tts/utterances', { request_id: randomUUID(), slot, text: clampAnnounce(text) });
    } catch (e) {
      if (attempt >= 3) { this.log(`announce to ${record.deviceId} failed`, e?.code ?? '', e?.message ?? e); return; }
      await sleep(5_000 * (attempt + 1));
      await this.#sayWhenIdle(record, text, verbatim, drop, attempt + 1);
    }
  }
}
