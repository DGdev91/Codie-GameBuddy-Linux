import { endsWithQuestion } from './summary.mjs';
import { lastAssistantText, progressedSince, transcriptMark } from './transcript.mjs';
import { canonicalLanguage, languageName, resolveVoiceLanguage, sentences } from './locales.mjs';
import { REMIND_DETAILS, REMIND_MODES } from './session-tools.mjs';

// A Notification hook within this window of the last thing Codie said is
// dropped: idle_prompt fires ~60s after a turn whose reply or codie_notify
// already spoke. A device that had a task answer announced within the window
// is skipped too (AgentsHost.announce `quietMs`): clt01 keeps only the latest
// pending announce, so the reminder could replace an answer not yet spoken.
export const REMIND_DEDUP_MS = 120_000;
// Notification types that mean "Claude is waiting on the user".
const REMIND_TYPES = new Set(['permission_prompt', 'idle_prompt']);
const REMIND_MODE_LABEL = { question: 'remind only when a turn ends with a question', every_turn: 'remind at the end of every turn' };
// A turn-end reminder right after codie_notify spoke would say it twice.
export const TURN_END_DEDUP_MS = 30_000;
const REMIND_DETAIL_LABEL = { full: 'full (reads the agent message aloud)', brief: 'brief (a fixed reminder only)' };
// A PermissionRequest hook is remembered this long for the permission_prompt
// Notification (about 6 s later) that speaks it.
export const PERMISSION_TTL_MS = 120_000;
// How long a Codex PermissionRequest waits before it is spoken, like the
// delay before Claude Code's permission_prompt Notification.
export const PERMISSION_DELAY_MS = 6_000;

// What a permission prompt asks, said aloud: the agent's own description of
// the call (Bash has one), else the tool's short name and the file it touches.
function permissionAction(toolName, input) {
  if (typeof input?.description === 'string' && input.description.trim()) return input.description.trim();
  const tool = String(toolName ?? '').split('__').at(-1);
  const file = typeof input?.file_path === 'string' ? input.file_path.split(/[\\/]/).at(-1) : '';
  return file ? `${tool} ${file}` : tool;
}

// When Codie calls the user back to the computer, and in what words: after a
// turn, on a permission prompt, before a question. `ctx` is the calling
// session (its `host` words the sentence; `fallbackHost` without one).
export class Reminders {
  constructor({ store, link, now = Date.now, fallbackHost, systemLocale, permissionDelayMs = PERMISSION_DELAY_MS }) {
    Object.assign(this, { store, link, now, fallbackHost, systemLocale, permissionDelayMs });
    this.lastSpokenAt = -Infinity;
    this.permissions = new Map(); // session id -> { action, at }: the last PermissionRequest
  }

  // Read per call: any session may have switched them.
  mode() {
    const m = this.store.readSettings().remindMode;
    return REMIND_MODES.includes(m) ? m : 'question';
  }

  detail() {
    const d = this.store.readSettings().remindDetail;
    return REMIND_DETAILS.includes(d) ? d : 'full';
  }

  voiceLanguage() { return resolveVoiceLanguage(this.store.readSettings().voiceLanguage, this.systemLocale); }

  settingsText() {
    const m = this.mode();
    const follows = canonicalLanguage(this.store.readSettings().voiceLanguage) ? '' : ' (follows the system)';
    return [`Remind mode: ${REMIND_MODE_LABEL[m]} (${m})`, `Detail: ${REMIND_DETAIL_LABEL[this.detail()]}`,
      `Voice language: ${languageName(this.voiceLanguage())}${follows}`].join('\n');
  }

  #host(ctx) { return ctx?.host ?? this.fallbackHost; }

  // A turn ended without answering a device task.
  atTurnEnd(message, ctx, mark) {
    if (this.mode() !== 'every_turn' && !endsWithQuestion(message)) return;
    if (this.now() - this.lastSpokenAt < TURN_END_DEDUP_MS) return;
    this.remind(ctx, TURN_END_DEDUP_MS, { mark });
  }

  // Body posted by the Notification hook: Claude is waiting for permission
  // or has sat idle on a question. Payloads without a type (older Claude
  // Code) still remind. idle_prompt fires ~60s after every turn the user
  // leaves unanswered, so it follows the mode like the turn-end reminder:
  // by default only a turn whose last reply asks a question counts.
  // A permission_prompt says what the session's last PermissionRequest asked,
  // in full detail.
  onNotification(body, ctx) {
    const type = body?.notification_type;
    if (type !== undefined && !REMIND_TYPES.has(type)) return;
    const action = type === 'permission_prompt' ? this.#takePermission(ctx) : null;
    if (type === 'idle_prompt' && this.mode() !== 'every_turn'
      && !endsWithQuestion(lastAssistantText(body?.transcript_path))) return;
    if (this.now() - this.lastSpokenAt < REMIND_DEDUP_MS) return;
    const message = action && this.detail() === 'full'
      ? sentences(this.voiceLanguage()).approval(this.#host(ctx), action) : undefined;
    this.remind(ctx, REMIND_DEDUP_MS, { message, mark: transcriptMark(body?.transcript_path) });
  }

  // PreToolUse hook for AskUserQuestion: the agent was told to speak its
  // question through codie_notify first; when it did not, the reminder.
  onAsk(body, ctx) {
    if (this.now() - this.lastSpokenAt < TURN_END_DEDUP_MS) return;
    const questions = body?.tool_input?.questions;
    const message = ctx?.session?.host === 'codex' && this.detail() === 'full' && Array.isArray(questions)
      ? questions.map(q => [q.question ?? q.title, ...(q.options ?? []).map((o, i) => `${i + 1}. ${typeof o === 'string' ? o : o.label}`)].filter(Boolean).join(' ')).join(' ').slice(0, 200)
      : undefined;
    this.remind(ctx, TURN_END_DEDUP_MS, { message: message || undefined, verbatim: !!message, mark: transcriptMark(body?.transcript_path) });
  }

  // PermissionRequest hook: remembers what the session asks to do for the
  // permission_prompt Notification that follows (only if the user has not
  // answered within ~6 s). AskUserQuestion is not a permission.
  onPermission(body, ctx) {
    if (body?.tool_name === 'AskUserQuestion') return;
    // Codex has no permission_prompt Notification: wait as long as Claude
    // Code does before it, and say nothing if the user answered meanwhile.
    if (ctx?.session?.host === 'codex') {
      const message = this.detail() === 'full'
        ? sentences(this.voiceLanguage()).approval(ctx.host, permissionAction(body?.tool_name, body?.tool_input)) : undefined;
      this.remind(ctx, TURN_END_DEDUP_MS, { message, mark: transcriptMark(body?.transcript_path), delayMs: this.permissionDelayMs });
      return;
    }
    this.permissions.set(ctx?.session?.id, { action: permissionAction(body?.tool_name, body?.tool_input), at: this.now() });
  }

  #takePermission(ctx) {
    const key = ctx?.session?.id;
    const p = this.permissions.get(key);
    this.permissions.delete(key);
    return p && this.now() - p.at < PERMISSION_TTL_MS ? p.action : null;
  }

  // How many devices will speak. Devices that had a task answer announced
  // within `quietMs` are skipped.
  // `message` replaces the fixed reminder; `verbatim` (the agent's own words)
  // has the device read it as written instead of rephrasing it.
  // `mark` (transcriptMark): the reminder is dropped if the session shows the
  // user's progress past it before it is spoken; then it no longer counts
  // for the dedup windows either.
  remind(ctx, quietMs, { message, verbatim = false, mark = null, delayMs = 0 } = {}) {
    const said = message ?? sentences(this.voiceLanguage()).reminder(this.#host(ctx));
    const before = this.lastSpokenAt;
    const at = this.now();
    const drop = mark ? { stale: () => progressedSince(mark), onDropped: () => { if (this.lastSpokenAt === at) this.lastSpokenAt = before; } } : {};
    const n = this.link.announce(said, { quietMs, verbatim, delayMs, ...drop });
    if (n) this.lastSpokenAt = at;
    return n;
  }
}
