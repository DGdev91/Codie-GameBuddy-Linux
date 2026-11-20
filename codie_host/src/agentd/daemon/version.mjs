// Bump on ANY change to agentd's behaviour or IPC. A session that finds an
// older agentd running asks it to shut down and starts its own; one that
// finds a newer agentd reuses it. So a newer agentd must stay compatible with
// older session clients: keep old routes and request/response shapes working.
export const AGENTD_VERSION = 47;
