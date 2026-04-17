#!/usr/bin/env node

import { Command } from 'commander';
import { CLI_VERSION } from './version.js';
import { installCommand } from './commands/install.js';
import { statusCommand } from './commands/status.js';
import { startCommand } from './commands/start.js';
import { stopCommand } from './commands/stop.js';
import { restartCommand } from './commands/restart.js';
import {
  configGetCommand,
  configSetCommand,
  configListCommand,
  configPathCommand,
} from './commands/config.js';
import { logsCommand } from './commands/logs.js';
import { uninstallCommand } from './commands/uninstall.js';
import { versionCommand } from './commands/version.js';
import { openCommand } from './commands/open.js';
import { updateCommand } from './commands/update.js';
import { backupCommand, restoreCommand } from './commands/backup.js';
import { chatCommand } from './commands/chat.js';
import { listenCommand } from './commands/listen.js';
import { skillValidateCommand } from './commands/skill.js';

const program = new Command();

program.name('neura').description('Neura — AI assistant core service manager').version(CLI_VERSION);

// Install & setup
program
  .command('install')
  .description('Interactive setup wizard + service registration')
  .option(
    '--yes',
    'Skip all prompts and reuse existing config (for automation / post-update re-register)'
  )
  .action((opts) => installCommand({ yes: !!opts.yes }));

program
  .command('uninstall')
  .description('Remove service and optionally clean data')
  .option('--force', 'Skip confirmation prompts')
  .action(uninstallCommand);

// Service lifecycle
program.command('start').description('Start the core service').action(startCommand);

program.command('stop').description('Stop the core service').action(stopCommand);

program.command('restart').description('Restart the core service').action(restartCommand);

program.command('status').description('Show core service status').action(statusCommand);

// Configuration
const configCmd = program.command('config').description('Manage configuration');

configCmd.command('get <key>').description('Get a config value').action(configGetCommand);

configCmd.command('set <key> <value>').description('Set a config value').action(configSetCommand);

configCmd.command('list').description('Show all configuration').action(configListCommand);

configCmd
  .command('path')
  .description('Print the Neura home directory path')
  .action(configPathCommand);

// Utilities
program
  .command('logs')
  .description('View core service logs')
  .option('-n, --lines <count>', 'Number of lines to show', '50')
  .option('-f, --follow', 'Follow log output')
  .action(logsCommand);

program.command('open').description('Open the web UI in default browser').action(openCommand);

program.command('update').description('Download the latest core binary').action(updateCommand);

program.command('version').description('Show CLI and core versions').action(versionCommand);

// Data management
program.command('backup').description('Create a memory backup').action(backupCommand);

program
  .command('restore')
  .description('Restore memories from backup')
  .option('--force', 'Skip confirmation prompt')
  .action(restoreCommand);

// Interactive client
program
  .command('chat')
  .description('Text chat with Neura')
  .option('-p, --port <port>', 'Core server port (default: config or 3002)')
  .action(chatCommand);
program
  .command('listen')
  .description('Voice chat with Neura (mic + speaker)')
  .option('-p, --port <port>', 'Core server port (default: config or 3002)')
  .option('--debug', 'Print audio pipeline stats every 2s')
  .action(listenCommand);

// Skill authoring / validation
const skillCmd = program.command('skill').description('Skill authoring tools');

skillCmd
  .command('validate <path>')
  .description('Validate skills at <path> against the agentskills.io spec')
  .action(skillValidateCommand);

program.parse();
