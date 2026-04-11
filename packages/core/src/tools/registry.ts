import type { ToolDefinition } from '@neura/types';
import { visionToolDefs } from './vision-tools.js';
import { timeToolDefs } from './time-tools.js';
import { memoryToolDefs } from './memory-tools.js';
import { presenceToolDefs } from './presence-tools.js';
import { taskToolDefs } from './task-tools.js';
import { skillToolDefs } from './skill-tools.js';
import { workerControlToolDefs } from './worker-control-tools.js';

export const MEMORY_TOOL_NAMES = new Set(memoryToolDefs.map((t) => t.name));
export const PRESENCE_TOOL_NAMES = new Set(presenceToolDefs.map((t) => t.name));
export const TASK_TOOL_NAMES = new Set(taskToolDefs.map((t) => t.name));
export const SKILL_TOOL_NAMES = new Set(skillToolDefs.map((t) => t.name));
export const WORKER_CONTROL_TOOL_NAMES = new Set(workerControlToolDefs.map((t) => t.name));

export const toolDefs: ToolDefinition[] = [
  ...visionToolDefs,
  ...timeToolDefs,
  ...memoryToolDefs,
  ...presenceToolDefs,
  ...taskToolDefs,
  ...skillToolDefs,
  ...workerControlToolDefs,
];

/** Return tool definitions, excluding unavailable tool groups. */
export function getToolDefs(options: {
  includeMemory: boolean;
  includePresence: boolean;
  includeTasks: boolean;
  includeSkills: boolean;
  includeWorkerControl: boolean;
}) {
  return toolDefs.filter((t) => {
    if (MEMORY_TOOL_NAMES.has(t.name) && !options.includeMemory) return false;
    if (PRESENCE_TOOL_NAMES.has(t.name) && !options.includePresence) return false;
    if (TASK_TOOL_NAMES.has(t.name) && !options.includeTasks) return false;
    if (SKILL_TOOL_NAMES.has(t.name) && !options.includeSkills) return false;
    if (WORKER_CONTROL_TOOL_NAMES.has(t.name) && !options.includeWorkerControl) return false;
    return true;
  });
}
