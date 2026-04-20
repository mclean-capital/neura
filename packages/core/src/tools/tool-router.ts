import { Logger } from '@neura/utils/logger';
import type { ToolCallContext } from './types.js';
import { handleVisionTool } from './vision-tools.js';
import { handleTimeTool } from './time-tools.js';
import { handleMemoryTool } from './memory-tools.js';
import { handlePresenceTool } from './presence-tools.js';
import { handleTaskTool } from './task-tools.js';
import { handleSkillTool } from './skill-tools.js';
import { handleWorkerControlTool } from './worker-control-tools.js';
import { handleLogTool } from './log-tools.js';

const log = new Logger('tool');

export async function handleToolCall(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolCallContext
): Promise<Record<string, unknown>> {
  log.info(`${name}`, { args });

  return (
    (await handleVisionTool(name, args, ctx)) ??
    handleTimeTool(name) ??
    (await handleMemoryTool(name, args, ctx)) ??
    handlePresenceTool(name, args, ctx) ??
    (await handleTaskTool(name, args, ctx)) ??
    (await handleSkillTool(name, args, ctx)) ??
    (await handleWorkerControlTool(name, args, ctx)) ??
    (await handleLogTool(name, args, ctx)) ?? { error: `Unknown tool: ${name}` }
  );
}
