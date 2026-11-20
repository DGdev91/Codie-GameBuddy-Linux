import { DEVICE_TRUST, INTERRUPTED } from './texts.mjs';
import { TASK_TAG } from './transcript.mjs';

// What a session's MCP server shows its model (instructions, tool list) and
// the forms a device task reaches a session in. Plain data and formatting:
// the tools themselves run in agentd (app.mjs).

export const MAX_WAIT_SECONDS = 50; // Codex's default MCP tool timeout is 60s

// Turn-end reminder modes (settings.json remindMode): only when the turn
// ends on a question (default), or after every turn.
export const REMIND_MODES = ['question', 'every_turn'];
// settings.json remindDetail: full reads the agent's codie_notify message and
// what a permission prompt asks; brief speaks only the fixed reminder, which
// tells nothing about the session to whoever is in the room.
export const REMIND_DETAILS = ['full', 'brief'];

export const INSTRUCTIONS = [
  '<channel source="codie"> messages are instructions the user gave through a Codie voice device; meta.device is the device name, meta.task_id the task id.',
  'Carry it out as you would a request the user typed in the terminal. The device is not waiting on you: it has already told the user "handed to the computer", so there is no rush.',
  DEVICE_TRUST,
  'When done (or unable to do it), call codie_reply once with the same task_id and a spoken-style summary; the device announces it:',
  '1-3 short sentences, under 200 characters, no code, no file paths, no markdown (the device reads it aloud). Write it in the language the user spoke to the device.',
  'Reply only once per task_id.',
  `If the user stops a Codie task mid-way or switches to something else: immediately call codie_reply for that task with exactly this summary, word for word: ${INTERRUPTED} Then handle the new request.`,
  'If the task\'s work has to run in the background, end the turn without calling codie_reply: when the turn in which the background work completes ends, the plugin replies to the device with the result (or call codie_reply yourself once you have the final result).',
  'When you need the user to decide or confirm something (mid-turn, before calling AskUserQuestion, or when your reply will end with a question to them), first call codie_notify with message: a spoken summary in the Codie voice language, under 200 characters, no code, file paths or markdown.',
  'In it, say what you are asking, the options, and which one you recommend and why; only when the options are different ways to fix a problem, also say which fixes the root cause and which only works around the symptom. If there is nothing to choose, briefly say what you need from the user.',
  'If the user says "listen to Codie", follow the /codie:listen skill: call codie_poll(wait_seconds=50) in a loop, and call codie_listen_stop when done.',
  'Messages starting with [Codie voice task task_id="…"] are device instructions too (pushed into the session by the plugin monitor, or handed to a background session): likewise call codie_reply once with that task_id; no PushNotification needed.',
  'A message starting with [Codie cancel task_id="…"] means the device cancelled that task: stop it, and do not call codie_reply.',
].join('\n');

export const TOOLS = [
  { name: 'codie_reply', description: 'Send the task\'s closing summary back to the Codie device that started it (the device announces it by voice).',
    inputSchema: { type: 'object', properties: { task_id: { type: 'string' }, summary: { type: 'string' } }, required: ['task_id', 'summary'] } },
  { name: 'codie_notify', description: 'Have Codie call the user back to the computer by voice. With message, Codie reads it out (in brief detail mode it plays one fixed reminder instead); without it, the fixed reminder. Call it when you need the user to decide or confirm something: mid-turn, before AskUserQuestion, or before a reply that ends with a question.',
    inputSchema: { type: 'object', properties: { message: { type: 'string', description: 'What Codie says, in the Codie voice language, under 200 characters, no code, file paths or markdown: the question, the options, your recommendation and why (for fixes: which is the root-cause fix and which a workaround).' } } } },
  { name: 'codie_remind_mode', description: 'Show or switch the Codie reminder settings. mode: question = remind at the end of a turn only when it ends with a question (default), every_turn = after every turn. detail: full = read the agent message aloud (default), brief = a fixed reminder only. language: the Codie voice language, a tag such as zh-CN or en, or system to follow the computer (default). Omit all to just show them.',
    inputSchema: { type: 'object', properties: { mode: { type: 'string', enum: REMIND_MODES }, detail: { type: 'string', enum: REMIND_DETAILS }, language: { type: 'string' } } } },
  { name: 'codie_status', description: 'Show Codie device connection status: each paired device online/offline, and tasks in progress.',
    inputSchema: { type: 'object', properties: {} } },
  { name: 'codie_doctor', description: 'Check every Codie prerequisite (Node, background service, device pairing and online state, where tasks go when no one is listening), giving ✅/⚠️/❌ and the next step for each. Call it first when setting up Codie or troubleshooting.',
    inputSchema: { type: 'object', properties: {} } },
  { name: 'codie_list_devices', description: 'Scan the LAN for Codie devices (about 3 seconds); lists number, name, IP and pairing state.',
    inputSchema: { type: 'object', properties: {} } },
  { name: 'codie_pair_begin', description: 'Start pairing with a device; the device screen shows a 6-digit code.',
    inputSchema: { type: 'object', properties: { device_id: { type: 'string' } }, required: ['device_id'] } },
  { name: 'codie_pair_confirm', description: 'Submit the 6-digit code from the device screen to finish pairing.',
    inputSchema: { type: 'object', properties: { device_id: { type: 'string' }, code: { type: 'string' } }, required: ['device_id', 'code'] } },
  { name: 'codie_pair_cancel', description: 'Abandon the pairing in progress and have the device dismiss the code.',
    inputSchema: { type: 'object', properties: { device_id: { type: 'string' } }, required: ['device_id'] } },
  { name: 'codie_unpair', description: 'Remove a paired device.',
    inputSchema: { type: 'object', properties: { device_id: { type: 'string' } }, required: ['device_id'] } },
];

// Listen tools for hosts without a push channel (Codex): device tasks wait
// for codie_poll instead of arriving in the session.
export const LISTEN_TOOLS = [
  { name: 'codie_poll', description: `Claim Codie voice tasks not yet claimed. wait_seconds (0–${MAX_WAIT_SECONDS}, default 0): with no task, wait at most this long; returns as soon as a task arrives. Device instructions are handed to you only while you listen.`,
    inputSchema: { type: 'object', properties: { wait_seconds: { type: 'number', minimum: 0, maximum: MAX_WAIT_SECONDS } } } },
  { name: 'codie_listen_stop', description: 'Stop listening: stop receiving device instructions right away and hand back unclaimed tasks (to another session, or back to the device). Call it when listening ends or the user asks to stop.',
    inputSchema: { type: 'object', properties: {} } },
];
export const TURN_COMPLETE_TOOL = { name: 'codie_turn_complete', description: 'Handle the turn-end reminder per the remind mode; does not reply to device tasks.',
  inputSchema: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] } };

// The channel push for a device task, and for the device cancelling one
// (sent by the agentd session client, session.mjs).
const channelMeta = ({ taskId, deviceId, deviceName }) => ({ device: deviceName || deviceId, device_id: deviceId, task_id: taskId });

export function channelNotification({ taskId, deviceId, deviceName, text: content }) {
  return { method: 'notifications/claude/channel', params: { content, meta: channelMeta({ taskId, deviceId, deviceName }) } };
}

const cancelText = ({ taskId, deviceId, deviceName }) => `${deviceName || deviceId} cancelled task ${taskId}: stop the task, no codie_reply needed.`;

export function cancelNotification({ taskId, deviceId, deviceName }) {
  return { method: 'notifications/claude/channel',
    params: { content: cancelText({ taskId, deviceId, deviceName }), meta: channelMeta({ taskId, deviceId, deviceName }) } };
}

// The same, as the one line the Codie inbox monitor prints (inbox.mjs):
// Claude Code hands each output line to the session as a notification.
const oneLine = s => String(s ?? '').replace(/\s*[\r\n]+\s*/g, ' ').trim();
const attr = s => oneLine(s).replace(/"/g, "'");

export function inboxTaskLine({ taskId, deviceId, deviceName, text: content }) {
  return `${TASK_TAG}"${taskId}" device="${attr(deviceName || deviceId)}"] ${oneLine(content)}`;
}

export function inboxCancelLine(event) {
  return `[Codie cancel task_id="${event.taskId}"] ${oneLine(cancelText(event))}`;
}
