import { App } from '../app.mjs';
import { HOST_LABELS } from './router.mjs';
import { runDoctor } from './doctor.mjs';

export const HOSTS = {
  claude: { host: HOST_LABELS.claude, pairHint: '/codie:pair' },
  codex: { host: HOST_LABELS.codex, pairHint: '"pair Codie"' },
};

const text = (t, isError) => ({ content: [{ type: 'text', text: t }], ...(isError ? { isError: true } : {}) });

// The App agentd runs: one instance for every session, wording each reply
// for the calling session's host, with listening backed by the Router.
// Every hook arrives with a ctx (already matched to its session).
export class AgentApp extends App {
  constructor({ router, dispatcher = null, version = 0, ...opts }) {
    super(opts);
    Object.assign(this, { router, dispatcher, version });
  }

  ctxFor(session, signal) { return { session, signal, ...(HOSTS[session?.host] ?? HOSTS.claude) }; }

  async callTool(name, args = {}, { session, signal } = {}) {
    const ctx = this.ctxFor(session, signal);
    if (session) this.router.active(session.id);
    switch (name) {
      case 'codie_poll':
        if (!session) return text('Could not identify the calling session; cannot claim tasks.', true);
        return text(JSON.stringify(await this.router.poll(session.id, Number(args.wait_seconds) || 0, signal)));
      case 'codie_listen_stop': {
        if (!session) return text('Could not identify the calling session; cannot stop listening.', true);
        const n = this.router.listenStop(session.id);
        return text(n ? `Stopped listening; ${n} unclaimed task${n > 1 ? 's' : ''} handed back.` : 'Stopped listening.');
      }
      case 'codie_turn_complete':
        this.onStopHook({ last_assistant_message: args.message }, ctx);
        return text('Handled the turn end per the remind mode.');
      case 'codie_doctor':
        return text(await runDoctor({ host: session?.host, session, store: this.store, link: this.link, router: this.router, dispatcher: this.dispatcher,
          version: this.version, repairRequired: this.repairRequired }));
      case 'codie_status':
        return text([this.statusText(ctx.pairHint), `Listening: ${this.router.listening() ? 'a session is listening' : 'no session is listening'}`,
          `Connected sessions: ${this.router.describe()}`].join('\n'));
      default:
        return super.callTool(name, args, ctx);
    }
  }
}
