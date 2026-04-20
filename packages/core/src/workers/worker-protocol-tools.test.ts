/**
 * Tests for the 6-verb worker protocol tools (Phase 6b Pass 3).
 *
 * The tools wrap `update_task` through the per-worker TaskToolHandler, so
 * invariants (transition matrix, cross-task writes, completion gate) are
 * exercised via the handler. Here we pin the parameter translation:
 * report_progress posts the right comment type, heartbeat refreshes
 * lease_expires_at, complete_task targets status=done, etc.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite/vector';
import { runMigrations } from '../stores/migrations.js';
import { createWorkItem, updateWorkItem, getWorkItem } from '../stores/work-item-queries.js';
import { insertComment, listComments } from '../stores/task-comment-queries.js';
import { applyTaskUpdate } from '../tools/task-update-handler.js';
import type { TaskToolHandler } from '../tools/index.js';
import { buildWorkerProtocolTools, WORKER_PROTOCOL_TOOL_NAMES } from './worker-protocol-tools.js';
import type { NeuraAgentTool } from './neura-tools.js';
import { ClarificationBridge } from './clarification-bridge.js';

let db: PGlite;
const WORKER_ID = 'w-1';

beforeEach(async () => {
  db = await PGlite.create('memory://', { extensions: { vector } });
  await runMigrations(db);
});

afterEach(async () => {
  await db.close();
});

async function seedLinkedTask(): Promise<string> {
  const id = await createWorkItem(db, 'Test task', 'medium', {});
  await updateWorkItem(db, id, { status: 'in_progress', workerId: WORKER_ID });
  return id;
}

function buildTaskTools(): TaskToolHandler {
  return {
    createTask: () => Promise.reject(new Error('not used')),
    listTasks: () => Promise.reject(new Error('not used')),
    getTask: (id) => getWorkItem(db, id),
    listTaskComments: (taskId, options) => listComments(db, { taskId, limit: options?.limit }),
    updateTask: async (idOrTitle, payload) => {
      const current = await getWorkItem(db, idOrTitle);
      if (!current) return null;
      return applyTaskUpdate({ db, task: current, payload, actor: `worker:${WORKER_ID}` });
    },
    deleteTask: () => Promise.resolve(false),
  };
}

function findTool(tools: NeuraAgentTool[], name: string): NeuraAgentTool {
  const t = tools.find((x) => x.name === name);
  if (!t) throw new Error(`tool ${name} not found`);
  return t;
}

function firstText(content: { type: string; text?: string }[]): string {
  const head = content[0];
  if (!head) throw new Error('no content');
  if (head.type !== 'text' || typeof head.text !== 'string') {
    throw new Error(`expected text content, got ${head.type}`);
  }
  return head.text;
}

describe('WORKER_PROTOCOL_TOOL_NAMES', () => {
  it('lists all 6 verbs', () => {
    expect(WORKER_PROTOCOL_TOOL_NAMES).toEqual([
      'report_progress',
      'heartbeat',
      'request_clarification',
      'request_approval',
      'complete_task',
      'fail_task',
    ]);
  });
});

describe('report_progress', () => {
  it('appends a progress comment authored by the worker', async () => {
    const taskId = await seedLinkedTask();
    const tool = findTool(
      buildWorkerProtocolTools({ workerId: WORKER_ID, taskId, taskTools: buildTaskTools() }),
      'report_progress'
    );
    await tool.execute('c-1', { message: 'step 1 complete' });

    const comments = await listComments(db, { taskId });
    expect(comments).toHaveLength(1);
    expect(comments[0].type).toBe('progress');
    expect(comments[0].author).toBe(`worker:${WORKER_ID}`);
    expect(comments[0].content).toBe('step 1 complete');
  });

  it('does not change task status', async () => {
    const taskId = await seedLinkedTask();
    const tool = findTool(
      buildWorkerProtocolTools({ workerId: WORKER_ID, taskId, taskTools: buildTaskTools() }),
      'report_progress'
    );
    await tool.execute('c-1', { message: 'just an update' });
    const row = await getWorkItem(db, taskId);
    expect(row?.status).toBe('in_progress');
  });
});

describe('heartbeat', () => {
  it('refreshes lease_expires_at and posts a heartbeat comment', async () => {
    const taskId = await seedLinkedTask();
    const before = await getWorkItem(db, taskId);
    expect(before?.leaseExpiresAt).toBeNull();

    const tool = findTool(
      buildWorkerProtocolTools({ workerId: WORKER_ID, taskId, taskTools: buildTaskTools() }),
      'heartbeat'
    );
    const result = await tool.execute('c-1', { note: 'still alive' });

    const after = await getWorkItem(db, taskId);
    expect(after?.leaseExpiresAt).toBeTruthy();

    const details = result.details as { leaseExpiresAt: string };
    expect(details.leaseExpiresAt).toBeTruthy();

    const comments = await listComments(db, { taskId });
    expect(comments.find((c) => c.type === 'heartbeat')?.content).toBe('still alive');
  });
});

describe('request_clarification', () => {
  it('posts the comment, transitions to awaiting_clarification, and returns the bridge answer', async () => {
    const taskId = await seedLinkedTask();
    const bridge = new ClarificationBridge({
      voiceInterjector: { interject: () => Promise.resolve() },
    });

    const tool = findTool(
      buildWorkerProtocolTools({
        workerId: WORKER_ID,
        taskId,
        taskTools: buildTaskTools(),
        clarificationBridge: bridge,
      }),
      'request_clarification'
    );

    const execPromise = tool.execute('c-1', {
      question: 'which branch?',
      context: 'deploying to prod',
      urgency: 'high',
    });

    // Simulate the voice layer delivering the user's answer.
    await new Promise((r) => setTimeout(r, 5));
    bridge.notifyUserTurn('use main');

    const result = await execPromise;
    expect(firstText(result.content)).toBe('use main');

    const row = await getWorkItem(db, taskId);
    expect(row?.status).toBe('awaiting_clarification');

    const comments = await listComments(db, { taskId });
    const req = comments.find((c) => c.type === 'clarification_request');
    expect(req).toBeDefined();
    expect(req?.urgency).toBe('high');
    expect(req?.content).toContain('which branch?');
    expect(req?.content).toContain('deploying to prod');
  });
});

describe('request_approval', () => {
  it('posts an approval_request comment and sets awaiting_approval', async () => {
    const taskId = await seedLinkedTask();
    const bridge = new ClarificationBridge({
      voiceInterjector: { interject: () => Promise.resolve() },
    });

    const tool = findTool(
      buildWorkerProtocolTools({
        workerId: WORKER_ID,
        taskId,
        taskTools: buildTaskTools(),
        clarificationBridge: bridge,
      }),
      'request_approval'
    );

    const execPromise = tool.execute('c-1', {
      action: 'rm -rf node_modules',
      rationale: 'clean install',
    });
    await new Promise((r) => setTimeout(r, 5));
    bridge.notifyUserTurn('go ahead');
    const result = await execPromise;

    expect(firstText(result.content)).toBe('go ahead');
    const row = await getWorkItem(db, taskId);
    expect(row?.status).toBe('awaiting_approval');
    const comments = await listComments(db, { taskId });
    expect(comments.find((c) => c.type === 'approval_request')).toBeDefined();
  });

  it('returns immediately without a clarification bridge', async () => {
    const taskId = await seedLinkedTask();
    const tool = findTool(
      buildWorkerProtocolTools({ workerId: WORKER_ID, taskId, taskTools: buildTaskTools() }),
      'request_approval'
    );
    const result = await tool.execute('c-1', { action: 'drop table users' });
    expect(firstText(result.content)).toMatch(/no live session/i);
  });
});

describe('complete_task', () => {
  it('transitions to done with a result comment', async () => {
    const taskId = await seedLinkedTask();
    const tool = findTool(
      buildWorkerProtocolTools({ workerId: WORKER_ID, taskId, taskTools: buildTaskTools() }),
      'complete_task'
    );
    await tool.execute('c-1', { summary: 'all done' });
    const row = await getWorkItem(db, taskId);
    expect(row?.status).toBe('done');
    const comments = await listComments(db, { taskId });
    expect(comments[0]?.type).toBe('result');
    expect(comments[0]?.content).toBe('all done');
  });

  it('is blocked by the open-request gate', async () => {
    const taskId = await seedLinkedTask();
    await insertComment(db, {
      taskId,
      type: 'clarification_request',
      author: `worker:${WORKER_ID}`,
      content: 'open question',
      urgency: 'normal',
    });
    const tool = findTool(
      buildWorkerProtocolTools({ workerId: WORKER_ID, taskId, taskTools: buildTaskTools() }),
      'complete_task'
    );
    await expect(tool.execute('c-1', { summary: 'sneaky complete' })).rejects.toThrow(
      /unresolved request/
    );
  });
});

describe('fail_task', () => {
  it('transitions to failed with reason_code on the comment metadata', async () => {
    const taskId = await seedLinkedTask();
    const tool = findTool(
      buildWorkerProtocolTools({ workerId: WORKER_ID, taskId, taskTools: buildTaskTools() }),
      'fail_task'
    );
    await tool.execute('c-1', { reason: 'cannot proceed', reason_code: 'impossible' });

    const row = await getWorkItem(db, taskId);
    expect(row?.status).toBe('failed');
    const comments = await listComments(db, { taskId });
    const err = comments.find((c) => c.type === 'error');
    expect(err).toBeDefined();
    expect(err?.metadata).toMatchObject({ reason_code: 'impossible' });
  });

  it('is allowed even with an open approval_request', async () => {
    const taskId = await seedLinkedTask();
    await insertComment(db, {
      taskId,
      type: 'approval_request',
      author: `worker:${WORKER_ID}`,
      content: 'risky?',
      urgency: 'high',
    });
    const tool = findTool(
      buildWorkerProtocolTools({ workerId: WORKER_ID, taskId, taskTools: buildTaskTools() }),
      'fail_task'
    );
    await tool.execute('c-1', { reason: 'timing out', reason_code: 'hard_error' });
    const row = await getWorkItem(db, taskId);
    expect(row?.status).toBe('failed');
  });
});

describe('error propagation', () => {
  it('surfaces cross-task-write rejections from the invariant layer', async () => {
    const id = await createWorkItem(db, 'Someone else task', 'medium', {});
    await updateWorkItem(db, id, { status: 'in_progress', workerId: 'other-worker' });

    // Build verb tools under a different worker — updates should fail.
    const tool = findTool(
      buildWorkerProtocolTools({
        workerId: WORKER_ID,
        taskId: id,
        taskTools: buildTaskTools(),
      }),
      'report_progress'
    );
    await expect(tool.execute('c-1', { message: 'nope' })).rejects.toThrow(/cannot update task/);
  });

  it('throws when the task does not exist', async () => {
    const tool = findTool(
      buildWorkerProtocolTools({
        workerId: WORKER_ID,
        taskId: 'missing-task',
        taskTools: buildTaskTools(),
      }),
      'report_progress'
    );
    await expect(tool.execute('c-1', { message: 'x' })).rejects.toThrow(/not found/);
  });
});

describe('request_clarification — persists response comment via onAnswer hook', () => {
  it('writes clarification_response with resolves_comment_id when bridge + db are present', async () => {
    const taskId = await seedLinkedTask();
    const bridge = new ClarificationBridge({
      voiceInterjector: { interject: () => Promise.resolve() },
    });

    const tool = findTool(
      buildWorkerProtocolTools({
        workerId: WORKER_ID,
        taskId,
        taskTools: buildTaskTools(),
        clarificationBridge: bridge,
        db,
      }),
      'request_clarification'
    );

    const p = tool.execute('c-1', { question: 'which branch?' });
    await new Promise((r) => setTimeout(r, 5));
    bridge.notifyUserTurn('main');
    await p;
    // Give the fire-and-forget persistence hook a tick.
    await new Promise((r) => setTimeout(r, 20));

    const comments = await listComments(db, { taskId });
    const req = comments.find((c) => c.type === 'clarification_request');
    const resp = comments.find((c) => c.type === 'clarification_response');
    expect(req).toBeDefined();
    expect(resp).toBeDefined();
    expect(resp?.author).toBe('orchestrator');
    expect(resp?.content).toBe('main');
    expect(resp?.metadata).toMatchObject({ resolves_comment_id: req!.id });

    // Task should be back in_progress (not awaiting_clarification).
    const row = await getWorkItem(db, taskId);
    expect(row?.status).toBe('in_progress');

    // And a follow-on complete_task should now be allowed by the gate.
    const completeTool = findTool(
      buildWorkerProtocolTools({
        workerId: WORKER_ID,
        taskId,
        taskTools: buildTaskTools(),
        clarificationBridge: bridge,
        db,
      }),
      'complete_task'
    );
    await completeTool.execute('c-2', { summary: 'done' });
    const done = await getWorkItem(db, taskId);
    expect(done?.status).toBe('done');
  });

  it('same flow for request_approval', async () => {
    const taskId = await seedLinkedTask();
    const bridge = new ClarificationBridge({
      voiceInterjector: { interject: () => Promise.resolve() },
    });
    const tool = findTool(
      buildWorkerProtocolTools({
        workerId: WORKER_ID,
        taskId,
        taskTools: buildTaskTools(),
        clarificationBridge: bridge,
        db,
      }),
      'request_approval'
    );

    const p = tool.execute('c-1', { action: 'rm -rf /' });
    await new Promise((r) => setTimeout(r, 5));
    bridge.notifyUserTurn('no, do not');
    await p;
    await new Promise((r) => setTimeout(r, 20));

    const comments = await listComments(db, { taskId });
    const resp = comments.find((c) => c.type === 'approval_response');
    expect(resp?.content).toBe('no, do not');
    expect(resp?.author).toBe('orchestrator');
  });
});

describe('observability: mock bridge', () => {
  it('passes urgency=critical through as blocking to the bridge', async () => {
    const taskId = await seedLinkedTask();
    const bridge = new ClarificationBridge({
      voiceInterjector: { interject: () => Promise.resolve() },
    });
    const spy = vi.spyOn(bridge, 'askUser');

    const tool = findTool(
      buildWorkerProtocolTools({
        workerId: WORKER_ID,
        taskId,
        taskTools: buildTaskTools(),
        clarificationBridge: bridge,
      }),
      'request_clarification'
    );

    const p = tool.execute('c-1', { question: 'urgent?', urgency: 'critical' });
    await new Promise((r) => setTimeout(r, 5));
    bridge.notifyUserTurn('yes');
    await p;

    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ urgency: 'blocking', workerId: WORKER_ID })
    );
  });
});
