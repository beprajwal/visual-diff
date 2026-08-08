#!/usr/bin/env node
/**
 * The `vdiff` binary (package.json `bin`). Deliberately three lines: everything testable lives in
 * `main.ts`, and this file exists only to give the process an entry point and a shebang.
 */

import { main } from './main.js';

await main(process.argv.slice(2));
