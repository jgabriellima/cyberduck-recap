#!/usr/bin/env node
import { homedir } from 'node:os';
import { registerBackends } from './backends.js';
import { createRegistry, runCli } from './cli/index.js';

const registry = createRegistry();
registerBackends(registry);

process.exitCode = await runCli(process.argv.slice(2), {
  stdout: process.stdout,
  stderr: process.stderr,
  stdin: process.stdin,
  env: process.env,
  cwd: process.cwd(),
  home: homedir(),
  registry,
});
