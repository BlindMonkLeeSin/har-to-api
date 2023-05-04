#!/usr/bin/env node

import { Command } from "commander";
import { start } from ".";
const program = new Command();

program.option(
  "-t, --config <config>",
  "config file url",
  "har-to-api.config.js"
);

program.parse(process.argv);

start(program.opts()?.config);
