const NODE_MIN = 20;

const mark = { ok: '✅', warn: '⚠️', bad: '❌' };

// Per calling host: its settings.json switch for taking device tasks nobody
// listens for, and where that needs a session open.
const BACKGROUND = {
  claude: { key: 'claudeBackground', label: 'background Claude sessions', how: 'start a Claude session in the background',
    need: 'Run claude once in the project directory you want Codie to work in.' },
  codex: { key: 'codexQueue', label: 'queue tasks into Codex', how: 'hand them to an open Codex session',
    need: 'Enable and trust Codie hooks in Codex, then send a message in the target session to register it. Until then, say "listen to Codie".' },
};

// The setup checklist for the calling host only (never the other app), as
// lines for the agent to show and act on: each item is ✅ / ⚠️ / ❌ with what
// to do next.
export async function runDoctor({ host, session, store, link, router, dispatcher, version, repairRequired = () => false, nodeVersion = process.versions.node }) {
  const lines = [];
  const add = (level, label, fix) => lines.push(`${mark[level]} ${label}${fix ? `\n   → ${fix}` : ''}`);

  const major = Number(String(nodeVersion).split('.')[0]);
  add(major >= NODE_MIN ? 'ok' : 'bad', `Node ${nodeVersion}`, major >= NODE_MIN ? '' : `Needs Node ≥ ${NODE_MIN}: install it from https://nodejs.org, or \`brew install node\` on macOS, \`winget install OpenJS.NodeJS.LTS\` on Windows.`);
  add('ok', `Codie background service v${version} is running`);

  const pairings = store.listPairings();
  const online = new Set(link.onlineDevices().map(d => d.deviceId));
  if (!pairings.length) {
    add('bad', 'No Codie device is paired yet', 'Say "pair Codie": scan the LAN, pick a device, enter the 6-digit code from its screen.');
  } else {
    for (const p of pairings) {
      if (repairRequired(p.deviceId)) {
        add('bad', `Device "${p.name || p.deviceId}" no longer accepts this computer`,
          'It was reset or updated and dropped its pairings. Say "pair Codie" and enter the 6-digit code from its screen.');
        continue;
      }
      const on = online.has(p.deviceId);
      add(on ? 'ok' : 'bad', `Device "${p.name || p.deviceId}" ${on ? 'online' : 'offline'}`, on ? ''
        : `Make sure the device is on and on the same Wi-Fi as the computer; on macOS also allow the terminal or this app under System Settings → Privacy & Security → Local Network. If all of that is fine, pair again.`);
    }
  }

  // A Claude Code session takes device tasks through its plugin monitor.
  if (host !== 'codex') {
    if (router.hasInbox(session)) add('ok', 'This Claude Code session receives device tasks automatically (plugin monitor; no channel or listening needed)');
    else add('warn', 'This Claude Code session has not started the Codie inbox; device tasks will not arrive automatically',
      'The plugin monitor runs only in interactive sessions; on Windows it needs Git Bash; it is unavailable with Bedrock / Vertex / Foundry or when DISABLE_TELEMETRY is set. Restart Claude Code and run the check again.');
  }

  const bg = BACKGROUND[host] ?? BACKGROUND.claude;
  const on = store.readSettings()[bg.key] !== false;
  const backend = dispatcher?.backend?.() ?? null;
  const push = router.hasPushReceiver?.() ?? false;
  const how = push ? 'a Claude Code session that receives tasks automatically (before Codex or listeners)'
    : BACKGROUND[backend]?.how ?? 'nowhere (the device hears "no session is handling Codie")';
  add('ok', `Where device tasks go when no one is listening: ${how} (${bg.label} ${on ? 'on' : 'off'})`,
    `This uses your quota; to turn it off set "${bg.key}": false in ~/.codie/settings.json.`);
  if (backend === null && on && !push) add('warn', 'Device tasks have nowhere to go when no one is listening', bg.need);
  add('ok', `Connected sessions: ${router.describe()}`);
  lines.push('', 'Last step, a live check: call codie_notify so the device speaks a reminder; then ask the user to say "on the computer, check what the date is today" to the device and confirm the device reads out the result.');
  return lines.join('\n');
}
