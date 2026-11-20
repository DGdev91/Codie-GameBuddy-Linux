// For the tests of programs built on codie-host: a real agentd in-process,
// a fake clt01 device, and the texts and ids a test asserts on.

export { ACCEPTED, NOT_AVAILABLE, CALL_ONCE } from '../src/agentd/texts.mjs';
export { startAgentd } from '../src/agentd/daemon/agentd-core.mjs';
export { AGENTD_VERSION } from '../src/agentd/daemon/version.mjs';
export { AGENTS_CLIENT, integrationId } from '../src/agentd/tools/integration-id.mjs';
export { Store, writeJsonAtomic } from '../src/agentd/store.mjs';
export { startFakeDevice } from '../test/agentd/helpers/fake-device.mjs';
