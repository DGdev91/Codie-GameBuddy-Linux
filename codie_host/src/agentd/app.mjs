import { toSpokenSummary } from './summary.mjs';
import { INTERRUPTED } from './texts.mjs';
import { currentTurnTask, transcriptMark } from './transcript.mjs';
import { canonicalLanguage, failureKind, languageName, sentences, systemLocale } from './locales.mjs';
import { Pairing, errorReason } from './pairing.mjs';
import { PERMISSION_DELAY_MS, Reminders, TURN_END_DEDUP_MS } from './reminders.mjs';
import { REMIND_DETAILS, REMIND_MODES } from './session-tools.mjs';

// One surrounding pair of quotes a model may wrap a summary in (「…」, “…”,
// "…") is dropped: the device would read them out.
const QUOTES = [['「', '」'], ['“', '”'], ['"', '"']];
export function unquote(s) {
  const t = s.trim();
  for (const [a, b] of QUOTES) if (t.length > a.length + b.length - 1 && t.startsWith(a) && t.endsWith(b)) return t.slice(a.length, t.length - b.length);
  return s;
}

const text = (t, isError) => (isError ? { content: [{ type: 'text', text: t }], isError: true } : { content: [{ type: 'text', text: t }] });

// The device-facing tools and hooks. agentd runs one instance (AgentApp)
// for every session; device messages reach sessions through its Router.
// Pairing (`pairing`) and the reminders (`reminders`) are its two parts.
export class App {
  // `host`/`pairHint` word the user-facing text for the host app; a per-call
  // `ctx` (the calling session) overrides them. `systemLocale` is the voice
  // language unless settings.json names one.
  // `forgetDevice(record)` cleans up on the device after an unpair (tool
  // integrations, the client credential); best-effort.
  // `repairRequired(deviceId)`: the device refused this computer's credential
  // (host-refresh.mjs `refused`), so the user has to pair it again.
  constructor({ store, tasks, link, discover, clt01, onPairingsChanged = () => {}, forgetDevice = async () => {}, repairRequired = () => false,
    now = Date.now, host = 'Claude Code', pairHint = '/codie:pair', systemLocale: locale = systemLocale(), platform = process.platform,
    permissionDelayMs = PERMISSION_DELAY_MS }) {
    Object.assign(this, { store, tasks, link, onPairingsChanged, forgetDevice, repairRequired, host, pairHint, platform });
    this.pairing = new Pairing({ store, link, discover, clt01, onPairingsChanged, pairHint });
    this.reminders = new Reminders({ store, link, now, fallbackHost: host, systemLocale: locale, permissionDelayMs });
  }

  // Body posted by the Stop hook (already matched to its session, `ctx`).
  // A turn that answered a device task speaks its summary; any other turn
  // may get a reminder, per the remind mode.
  onStopHook(body, ctx) {
    const replied = !ctx?.session?.threadId
      || (typeof body?.last_assistant_message === 'string' && body.last_assistant_message.trim());
    const ids = replied ? this.#turnTasks(body, ctx) : [];
    for (const id of ids) this.#sendAnswer(id, toSpokenSummary(body.last_assistant_message));
    if (!ids.length) this.reminders.atTurnEnd(body?.last_assistant_message, ctx, transcriptMark(body?.transcript_path));
  }

  // Body posted by the StopFailure hook (Claude Code), which replaces Stop
  // when a turn ends on an API error: the device task that turn was working
  // on hears why at once instead of waiting for the sweep.
  onStopFailureHook(body, ctx) {
    const said = sentences(this.reminders.voiceLanguage()).failed(ctx?.host ?? this.host, failureKind(body?.error));
    for (const id of this.#turnTasks(body, ctx)) this.#sendAnswer(id, said);
  }

  // The other hooks only remind (reminders.mjs); `ctx` as in onStopHook.
  onNotificationHook(body, ctx) { this.reminders.onNotification(body, ctx); }
  onAskHook(body, ctx) { this.reminders.onAsk(body, ctx); }
  onPermissionHook(body, ctx) { this.reminders.onPermission(body, ctx); }

  // The device tasks this turn was started by (Claude Code: its channel push
  // opened the turn; Codex: the turn polled it); a turn the user typed in the
  // terminal must not consume one — the 10-min sweep covers tasks nobody
  // answers. A Codex turn only has tasks its own session claimed (another
  // thread's rollout may mention them too), except on win32, where hooks
  // match sessions too loosely to rely on.
  #turnTasks(body, ctx) {
    let ids = this.tasks.pending().map(t => String(t.taskId));
    const s = ctx?.session;
    if (s?.threadId) {
      return this.tasks.pending().filter(t => t.threadId === s.threadId && t.turnId && t.turnId === body?.turn_id).map(t => t.taskId);
    }
    if (s?.host === 'codex' && s.id && this.platform !== 'win32') {
      const held = new Set(this.tasks.heldBy(s.id).map(t => String(t.taskId)));
      ids = ids.filter(id => held.has(id));
    }
    if (!ids.length) return [];
    const taskId = currentTurnTask(body?.transcript_path, ids);
    return taskId ? [taskId] : [];
  }

  #sendAnswer(taskId, summary) {
    if (this.tasks.get(taskId)?.cancelRequested) return false;
    return this.link.sendResult(taskId, summary, { asIs: summary.trim() === INTERRUPTED });
  }

  statusSnapshot() {
    const online = new Set(this.link.onlineDevices().map(d => d.deviceId));
    const devices = this.store.listPairings().map(r => ({ deviceId: r.deviceId, name: r.name, online: online.has(r.deviceId),
      ...(this.repairRequired(r.deviceId) ? { repairRequired: true } : {}) }));
    return { online: online.size, paired: devices.length, devices, tasks: this.tasks.pending().length };
  }

  // What codie_status says: every paired device, tasks in progress and the
  // reminder settings.
  statusText(pairHint = this.pairHint) {
    const s = this.statusSnapshot();
    if (!s.paired) return `No Codie device is paired yet. Pair one with ${pairHint}.`;
    const lines = s.devices.map(d => (d.repairRequired
      ? `🔴 ${d.name || d.deviceId} no longer accepts this computer: pair it again with ${pairHint} (device_id=${d.deviceId})`
      : `${d.online ? '🟢' : '⚪'} ${d.name || d.deviceId}${d.online ? ' online' : ' offline'} (device_id=${d.deviceId})`));
    // Short ids: the listing lands in session transcripts, where a full id
    // would look like that session took the task.
    const busy = this.tasks.pending().map(t => `In progress: ${String(t.taskId).slice(0, 8)}… (${t.deviceId})`);
    return [...lines, ...busy, this.reminders.settingsText()].join('\n');
  }

  // `ctx` is the calling session: optional host/pairHint/reminder wording and
  // the `signal` that aborts when the client cancels the call.
  async callTool(name, args = {}, ctx) {
    try {
      return await this.#call(name, args, ctx);
    } catch (e) {
      return text(`Failed: ${errorReason(e)}`, true);
    }
  }

  async #call(name, args, ctx) {
    const pairHint = ctx?.pairHint ?? this.pairHint;
    const { reminders, pairing } = this;
    switch (name) {
      case 'codie_reply': {
        const r = this.#sendAnswer(args.task_id, unquote(String(args.summary ?? '')));
        if (r === 'offline') return text('The device is offline; the summary was not delivered.');
        if (r === 'undelivered') return text('The device is offline; the summary was not delivered (an answer the device is still waiting for cannot be resent).');
        return r ? text('Sent to Codie; the device will announce it.') : text(`Task ${args.task_id} does not exist (already answered, cancelled or timed out).`, true);
      }

      case 'codie_notify': {
        const message = String(args.message ?? '').trim();
        const full = message !== '' && reminders.detail() === 'full';
        if (reminders.remind(ctx, TURN_END_DEDUP_MS, full ? { message, verbatim: true } : {})) {
          if (full) return text('Codie will read your message to the user.');
          return text(message ? 'Codie will remind the user (detail is brief, so your message was not read out).' : 'Codie will remind the user.');
        }
        const online = this.link.onlineDevices();
        if (!online.length) return text('No Codie device is online; the reminder was not delivered.');
        if (online.every(d => this.link.isQuiet?.(d.deviceId, TURN_END_DEDUP_MS))) {
          return text('Codie just announced a task result, so this reminder was not sent (it would override the result).');
        }
        return text('Failed to send the reminder: the device connection may have dropped; try again later.');
      }

      case 'codie_remind_mode': {
        const patch = {};
        if (args.mode !== undefined) {
          if (!REMIND_MODES.includes(args.mode)) return text(`mode must be ${REMIND_MODES.join(' / ')}.`, true);
          patch.remindMode = args.mode;
        }
        if (args.detail !== undefined) {
          if (!REMIND_DETAILS.includes(args.detail)) return text(`detail must be ${REMIND_DETAILS.join(' / ')}.`, true);
          patch.remindDetail = args.detail;
        }
        if (args.language !== undefined) {
          const language = args.language === 'system' ? 'system' : canonicalLanguage(args.language);
          if (!language) return text('language must be system or a language tag such as zh-CN or en.', true);
          patch.voiceLanguage = language;
        }
        if (!Object.keys(patch).length) {
          return text(`${reminders.settingsText()}\nOptions: mode question / every_turn; detail full / brief; language system or a tag such as zh-CN or en.`);
        }
        this.store.updateSettings(patch);
        const lines = ['Reminder settings updated.', reminders.settingsText()];
        if (patch.voiceLanguage) lines.push(`From now on write codie_notify messages in ${languageName(reminders.voiceLanguage())}. Other open sessions use it after they restart.`);
        return text(lines.join('\n'));
      }

      case 'codie_status':
        return text(this.statusText(pairHint));

      case 'codie_list_devices': {
        const found = await pairing.scan(3000);
        if (!found.length) return text('No Codie device found on the LAN (make sure the device is on and on the same network as the computer).');
        const lines = found.map((d, i) => {
          const st = d.paired ? (d.online ? 'paired · online' : 'paired · offline') : 'not paired';
          return `${i + 1}. ${d.name || d.deviceId}   ${d.host}   ${st}   (device_id=${d.deviceId})`;
        });
        return text(lines.join('\n'));
      }

      case 'codie_pair_begin': {
        const o = await pairing.begin(args.device_id);
        return text(pairing.text(o, pairHint), !o.ok);
      }

      case 'codie_pair_confirm': {
        const o = await pairing.confirm(args.device_id, args.code);
        return text(pairing.text(o, pairHint), !o.ok);
      }

      case 'codie_pair_cancel': {
        const o = await pairing.cancel(args.device_id);
        return text(pairing.text(o, pairHint), !o.ok);
      }

      case 'codie_unpair': {
        const record = this.store.listPairings().find(r => r.deviceId === args.device_id);
        if (!this.store.removePairing(args.device_id)) return text('No such paired device.', true);
        await this.forgetDevice(record);
        this.tasks.dropDevice(args.device_id);
        this.onPairingsChanged();
        return text('Pairing removed.');
      }

      default:
        return text(`Unknown tool ${name}`, true);
    }
  }
}
