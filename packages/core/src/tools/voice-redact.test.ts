import { describe, it, expect } from 'vitest';
import type { TaskCommentEntry, WorkItemEntry } from '@neura/types';
import { redactCommentForVoice, redactTaskForVoice } from './voice-redact.js';

function makeTask(overrides: Partial<WorkItemEntry> = {}): WorkItemEntry {
  return {
    id: 'task-1',
    title: 'Hello World',
    status: 'in_progress',
    priority: 'medium',
    description: null,
    dueAt: null,
    goal: null,
    context: null,
    source: 'user',
    sourceSessionId: null,
    relatedSkills: [],
    repoPath: null,
    baseBranch: null,
    workerId: 'a47274d8-0a72-4659-be43-9b680303bf88',
    version: 1,
    leaseExpiresAt: null,
    createdAt: '2026-04-20T00:00:00Z',
    updatedAt: '2026-04-20T00:01:00Z',
    completedAt: null,
    parentId: null,
    ...overrides,
  };
}

function makeComment(overrides: Partial<TaskCommentEntry> = {}): TaskCommentEntry {
  return {
    id: 'c-1',
    taskId: 'task-1',
    type: 'progress',
    author: 'worker:a47274d8-0a72-4659-be43-9b680303bf88',
    content: 'wrote file',
    attachmentPath: null,
    urgency: null,
    metadata: null,
    createdAt: '2026-04-20T00:02:00Z',
    ...overrides,
  };
}

describe('redactTaskForVoice', () => {
  it('strips the workerId UUID from the task row', () => {
    const redacted = redactTaskForVoice(makeTask());
    expect('workerId' in redacted).toBe(false);
  });

  it('exposes a boolean `hasActiveWorker` so the model can reason about state', () => {
    const withWorker = redactTaskForVoice(makeTask({ workerId: 'some-uuid' }));
    const withoutWorker = redactTaskForVoice(makeTask({ workerId: null }));
    expect(withWorker.hasActiveWorker).toBe(true);
    expect(withoutWorker.hasActiveWorker).toBe(false);
  });

  it('preserves the rest of the row', () => {
    const task = makeTask({ title: 'Ship it', status: 'done' });
    const redacted = redactTaskForVoice(task);
    expect(redacted.id).toBe(task.id);
    expect(redacted.title).toBe('Ship it');
    expect(redacted.status).toBe('done');
  });
});

describe('redactCommentForVoice', () => {
  it('collapses worker:<uuid> authors to the stable alias "worker"', () => {
    const redacted = redactCommentForVoice(makeComment());
    expect(redacted.author).toBe('worker');
  });

  it('leaves system/orchestrator/user authors alone', () => {
    expect(redactCommentForVoice(makeComment({ author: 'system' })).author).toBe('system');
    expect(redactCommentForVoice(makeComment({ author: 'orchestrator' })).author).toBe(
      'orchestrator'
    );
    expect(redactCommentForVoice(makeComment({ author: 'user' })).author).toBe('user');
  });

  it('preserves comment content, type, metadata', () => {
    const c = makeComment({ type: 'result', content: 'task finished cleanly' });
    const redacted = redactCommentForVoice(c);
    expect(redacted.type).toBe('result');
    expect(redacted.content).toBe('task finished cleanly');
  });
});
