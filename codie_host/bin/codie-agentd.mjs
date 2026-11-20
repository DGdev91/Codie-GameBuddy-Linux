#!/usr/bin/env node
// codie-agentd: what tool clients and the `codie` command line start when no
// agentd runs.
import { runAgentd } from '../src/agentd/main.mjs';

await runAgentd();
