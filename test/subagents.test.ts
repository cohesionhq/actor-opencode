import { expect, test } from 'bun:test';

import { call, fakeSession } from './fake_session.ts';

type Sent = { kind: string; subagent?: string; [field: string]: unknown };
const sentOf = (all: unknown[]) => all as Sent[];

const created = (id = 'kid', parentID = 's', extra: Record<string, unknown> = {}) => ({
	sessionID: id,
	parentID,
	title: 'Child',
	agent: 'explore',
	model: { providerID: 'anthropic', id: 'haiku' },
	...extra,
});

/** The parent's `subagent` tool call, then the child session it made. */
async function launched(it: ReturnType<typeof fakeSession>, id = 'kid', parentID = 's', owner = 's') {
	await call((type, data) => it.handle(type, { sessionID: owner, ...data }), `c_${id}`, 'subagent', { description: 'Map the db layer', subagent_type: 'Explore' });
	await it.handle('session.created', created(id, parentID));
}

test('a child session is launched under the tool call that made it, with its kind, model and no parent', async () => {
	const it = fakeSession();
	await launched(it);
	const launch = sentOf(it.sent).find((report) => report.kind === 'launch');
	expect(launch).toMatchObject({
		subagent: 'kid',
		title: 'Map the db layer',
		parent: null,
		message_id: it.idOf('toolUse'),
		agent_type: 'Explore',
		model: 'anthropic/haiku',
		background: false,
	});
});

test('a child launched with no subagent call to match falls back on its own title and agent', async () => {
	const it = fakeSession();
	await it.handle('session.created', created());
	expect(sentOf(it.sent).find((report) => report.kind === 'launch')).toMatchObject({ title: 'Child', agent_type: 'explore', message_id: null });
});

test("a grandchild goes under its parent child, naming that child's tool call", async () => {
	const it = fakeSession();
	await launched(it);
	await launched(it, 'grand', 'kid', 'kid');
	const grand = sentOf(it.sent).find((report) => report.kind === 'launch' && report.subagent === 'grand');
	const toolInKid = sentOf(it.sent).findIndex((report) => report.subagent === 'kid' && report.kind === 'message') + 1;
	expect(grand).toMatchObject({ parent: 'kid', message_id: toolInKid });
});

test("two subagent calls are matched to their sessions in order", async () => {
	const it = fakeSession();
	await call(it.handle, 'c1', 'subagent', { description: 'First' });
	await call(it.handle, 'c2', 'subagent', { description: 'Second' });
	await it.handle('session.created', created('k1'));
	await it.handle('session.created', created('k2'));
	const launches = sentOf(it.sent).filter((report) => report.kind === 'launch');
	expect(launches.map((report) => [report.subagent, report.title])).toEqual([['k1', 'First'], ['k2', 'Second']]);
	expect(launches[0]!.message_id).not.toBe(launches[1]!.message_id);
});

test("a child's stream is its own transcript; the session's status, progress and tools are untouched", async () => {
	const it = fakeSession();
	await launched(it);
	const before = sentOf(it.sent).filter((report) => report.subagent === undefined).length;
	await it.handle('session.execution.started', { sessionID: 'kid' }, true);
	await it.handle('session.reasoning.ended', { sessionID: 'kid', text: 'hm', ordinal: 0 }, true);
	await it.handle('session.text.ended', { sessionID: 'kid', text: 'Looking', ordinal: 1 }, true);
	await call((type, data) => it.handle(type, { sessionID: 'kid', ...data }, true), 'r1', 'read', { path: '/src/a.ts' });
	await it.handle('session.tool.success', { sessionID: 'kid', id: 'r1', content: [] }, true);
	await it.handle('session.step.started', { sessionID: 'kid', model: { providerID: 'anthropic', id: 'haiku' } }, true);
	await it.handle('session.step.ended', { sessionID: 'kid', tokens: { input: 100, output: 20, reasoning: 0, cache: { read: 0, write: 0 } } }, true);
	const own = sentOf(it.sent).filter((report) => report.subagent === 'kid');
	expect(own.filter((report) => report.kind === 'message').map((report) => (report.content as { kind: string }).kind)).toEqual(['thinking', 'text', 'toolUse']);
	expect(own.filter((report) => report.kind === 'end')).toHaveLength(2);
	expect(own.find((report) => report.kind === 'context')).toMatchObject({ context: { used_tokens: 120, total_tokens: 1000 } });
	expect(sentOf(it.sent).filter((report) => report.subagent === undefined)).toHaveLength(before);
	// Said once already when the first step named the same model, not again.
	expect(sentOf(it.sent).filter((report) => report.kind === 'launch')).toHaveLength(1);
});

test('a child ends done, failed, or interrupted-as-done; a superseded interruption says nothing', async () => {
	const it = fakeSession();
	await it.handle('session.created', created('a'));
	await it.handle('session.created', created('b'));
	await it.handle('session.created', created('c'));
	await it.handle('session.execution.succeeded', { sessionID: 'a' }, true);
	await it.handle('session.execution.failed', { sessionID: 'b', error: { type: 'x', message: 'boom' } }, true);
	await it.handle('session.execution.interrupted', { sessionID: 'c', reason: 'superseded' }, true);
	await it.handle('session.execution.interrupted', { sessionID: 'c', reason: 'user' }, true);
	const statuses = sentOf(it.sent).filter((report) => report.kind === 'status').map((report) => [report.subagent, report.status]);
	expect(statuses).toEqual([['a', 'idle'], ['b', 'failed'], ['c', 'idle']]);
	expect(sentOf(it.sent).some((report) => report.subagent === 'b' && report.kind === 'message')).toBe(true);
});

test("a child's permission is in its transcript, answered there in its own session, and the session isn't asked", async () => {
	const it = fakeSession();
	await launched(it);
	const request = { id: 'per_1', sessionID: 'kid', action: 'edit', resources: ['a.ts'], metadata: {}, save: [] };
	await it.handle('permission.asked', request, true);
	const asked = sentOf(it.sent).findIndex((report) => report.kind === 'message' && report.subagent === 'kid' && (report.content as { kind: string }).kind === 'permission') + 1;
	expect(asked).toBeGreaterThan(0);
	expect(sentOf(it.sent).filter((report) => report.kind === 'status')).toEqual([{ kind: 'status', status: 'needsAttention', subagent: 'kid' }]);
	// A response with no subagent is not for it: said to the session as words.
	await it.session.hear({ kind: 'permission', request_id: asked, decision: 'deny', message: 'no' } as never, [], undefined).catch(() => {});
	expect(it.calls.some(([name]) => name === 'permission.reply')).toBe(false);
	await it.session.hear({ kind: 'permission', request_id: asked, decision: 'deny', message: 'not that' } as never, [], 'kid');
	expect(it.calls.filter(([name]) => name === 'permission.reply')).toEqual([['permission.reply', { sessionID: 'kid', requestID: 'per_1', decision: 'reject', message: 'not that' }]]);
	await it.handle('permission.replied', { requestID: 'per_1', reply: 'reject' }, true);
	expect(sentOf(it.sent).filter((report) => report.kind === 'status').at(-1)).toEqual({ kind: 'status', status: 'working', subagent: 'kid' });
});

test("words to the session don't answer a child's request", async () => {
	const it = fakeSession();
	await launched(it);
	await it.handle('permission.asked', { id: 'per_1', sessionID: 'kid', action: 'edit', resources: ['a.ts'], metadata: {}, save: [] }, true);
	await it.session.say('x').catch(() => {});
	await it.session.hear({ kind: 'text', text: 'hello' }, []);
	expect(it.calls.some(([name]) => name === 'permission.reply')).toBe(false);
	await it.session.hear({ kind: 'text', text: 'no thanks' }, [], 'kid');
	expect(it.calls.filter(([name]) => name === 'permission.reply')).toEqual([['permission.reply', { sessionID: 'kid', requestID: 'per_1', decision: 'reject', message: 'no thanks' }]]);
});

test("a child this process never saw made, after a restart, is launched from what OpenCode says of it, parents first", async () => {
	const it = fakeSession();
	it.infos.kid = { parentID: 's', title: 'Kid', agent: 'explore' };
	it.infos.grand = { parentID: 'kid', title: 'Grand' };
	await it.handle('session.text.ended', { sessionID: 'grand', text: 'hello', ordinal: 0 }, true);
	const launches = sentOf(it.sent).filter((report) => report.kind === 'launch');
	expect(launches.map((report) => [report.subagent, report.parent, report.message_id])).toEqual([['kid', null, null], ['grand', 'kid', null]]);
	expect(sentOf(it.sent).some((report) => report.subagent === 'grand' && report.kind === 'message')).toBe(true);
});

test('a session OpenCode says is no child, or cannot be told of, reports nothing', async () => {
	const it = fakeSession();
	await it.handle('session.text.ended', { sessionID: 'stranger', text: 'hello', ordinal: 0 }, true);
	expect(it.sent).toEqual([]);
});

test("a subagent call's tool result settles the child it launched", async () => {
	const it = fakeSession();
	await launched(it);
	await it.handle('session.execution.started', { sessionID: 'kid' }, true);
	await it.handle('session.tool.success', { sessionID: 's', id: 'c_kid', content: [] });
	expect(sentOf(it.sent).filter((report) => report.kind === 'status').at(-1)).toEqual({ kind: 'status', status: 'idle', subagent: 'kid' });
});

test('a reconnect launches every child again, parents first, each with its status', async () => {
	const it = fakeSession();
	await launched(it);
	await launched(it, 'grand', 'kid', 'kid');
	await it.handle('session.execution.succeeded', { sessionID: 'grand' }, true);
	const again: Sent[] = [];
	await it.session.resync(async (report, subagent) => void again.push({ ...report, ...(subagent ? { subagent } : {}) } as Sent));
	expect(again.filter((report) => report.subagent).map((report) => [report.kind, report.subagent, report.status ?? report.parent])).toEqual([
		['launch', 'kid', null],
		['status', 'kid', 'working'],
		['launch', 'grand', 'kid'],
		['status', 'grand', 'idle'],
	]);
});

test('stopping the session leaves its working children idle', async () => {
	const it = fakeSession();
	await launched(it);
	await it.session.stop();
	expect(sentOf(it.sent).filter((report) => report.kind === 'status')).toEqual([{ kind: 'status', status: 'idle', subagent: 'kid' }]);
});
