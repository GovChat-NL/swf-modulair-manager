#!/usr/bin/env node
// The govchat command: writes the files of a GovChat deploy repository.
'use strict';

const path = require('node:path');
const { Fail } = require('./lib/core');
const commands = require('./lib/commands');

const HELP = `govchat: the command for a GovChat deploy repository.

Usage: ./govchat <command> [options]

Start
  init                               Ask for the values of your organisation and write the files.

Apps
  app list                           Show the known apps and the installed apps.
  app add <name|address> --env <e>   Add an app, or change its version. Option: --version v1.2.3
  app remove <name> --env <e>        Remove an app.
  app new <name>                     Make a new app from the example. Option: --dir <folder>

Kern
  kern set <version|latest> --env <e>   Set the version of the kern.

Files
  build [--env <e>]                  Write the generated files again.
  check [--env <e>]                  Fail if the generated files are not current. For the pull request check.
  promote                            Copy the versions from acceptatie to productie. Options: --from, --to
  branding                           Write shared/branding.yaml from the files in branding/.

Cluster
  secrets --env <e>                  Create the Secrets in the cluster. Existing Secrets do not change.
  verify --env <e>                   Check that the kern and the apps operate in the cluster.
  local up                           Deploy the local environment to a test cluster on your computer.
  local down                         Delete the local environment from the test cluster.

General options
  --repo <folder>     The deploy repository. Default: the current folder.
  --context <name>    The kubectl context. Default: the current context.

The command writes files only. It does not commit and it does not push.
A change goes to the cluster through a pull request: a second person approves, and the merge is the deployment.`;

const FLAGS = new Set(['force', 'skip-url', 'help']);

function parse(argv) {
  const options = {};
  const words = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) { words.push(arg); continue; }
    const [name, inline] = arg.slice(2).split('=');
    if (FLAGS.has(name)) options[name] = true;
    else if (inline !== undefined) options[name] = inline;
    else { i += 1; if (argv[i] === undefined) throw new Fail(`The option --${name} needs a value.`); options[name] = argv[i]; }
  }
  return { options, words };
}

async function main() {
  const { options, words } = parse(process.argv.slice(2));
  const root = path.resolve(options.repo ?? '.');
  const [command, second, third] = words;
  const table = {
    init: () => commands.init(root, options),
    build: () => commands.build(root, options),
    check: () => commands.check(root, options),
    promote: () => commands.promote(root, options),
    branding: () => commands.branding(root, options),
    secrets: () => commands.secrets(root, options),
    verify: () => commands.verify(root, options),
    'app list': () => commands.appList(root, options),
    'app add': () => commands.appAdd(root, options, third),
    'app remove': () => commands.appRemove(root, options, third),
    'app new': () => commands.appNew(root, options, third),
    'kern set': () => commands.kernSet(root, options, third ?? 'latest'),
    'local up': () => commands.localUp(root, options),
    'local down': () => commands.localDown(root, options),
  };
  const action = table[command] ?? table[`${command} ${second}`];
  if (options.help || !command || !action) {
    console.log(HELP);
    process.exit(command && !action && !options.help ? 1 : 0);
  }
  await action();
}

main().catch((error) => {
  if (!(error instanceof Fail)) throw error;
  console.error(`ERROR: ${error.message}`);
  process.exit(1);
});
