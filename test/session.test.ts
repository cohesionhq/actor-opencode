import { expect, test } from 'bun:test';

import { call, fakeSession } from './fake_session.ts';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

test('a tool is shown as called, by the name its input started with, and ends as its result comes, failed or not', async () => {
	const { handle, messages, ended, idOf } = fakeSession();
	await call(handle, 't1', 'shell', { command: 'ls -la' });
	expect(messages()).toEqual([{ kind: 'toolUse', tool: 'Shell', category: 'command', summary: 'ls -la' }]);
	const id = idOf('toolUse');
	await call(handle, 't2', 'grep', { pattern: 'x' });
	await handle('session.tool.failed', { id: 't2', error: { type: 'x', message: 'no' }, executed: true });
	await handle('session.tool.success', { id: 't1', content: [{ type: 'text', text: 'ok' }], executed: true });
	expect(ended()).toEqual([idOf('toolUse'), id]);
	// A result heard twice ends nothing more.
	await handle('session.tool.success', { id: 't1', content: [{ type: 'text', text: 'ok' }], executed: true });
	expect(ended()).toHaveLength(2);
});

test("an image read is shown once its result is in, with the image; the question tool isn't shown at all", async () => {
	const { handle, sent, messages } = fakeSession();
	await call(handle, 'r', 'read', { path: '/src/shot.png' });
	await call(handle, 'q', 'question', { questions: [] });
	expect(messages()).toEqual([]);
	await handle('session.tool.success', { id: 'r', content: [{ type: 'file', uri: `data:image/png;base64,${PNG}`, mime: 'image/png' }], executed: true });
	const shown = sent.find((report) => report.kind === 'message');
	expect(shown).toMatchObject({ content: { kind: 'toolUse', summary: 'shot.png' }, images: [{ media_type: 'image/png', data: PNG }] });
});

test('a turn is working as it starts, idle as it succeeds, and failed, with why, only when OpenCode fails', async () => {
	const { handle, statuses, messages } = fakeSession();
	await handle('session.execution.started', {});
	await handle('session.execution.succeeded', {});
	await handle('session.execution.started', {});
	await handle('session.execution.failed', { error: { type: 'provider.free-limit', message: 'Free usage limit reached.' } });
	expect(statuses()).toEqual(['working', 'idle', 'working', 'failed']);
	expect(messages()).toContainEqual({ kind: 'text', text: 'Free usage limit reached.' });
});

test('a turn stopped from Cohesion reports nothing more; one interrupted elsewhere is idle', async () => {
	const { session: it, handle, statuses, calls } = fakeSession();
	await handle('session.execution.started', {});
	await it.stop();
	expect(calls).toContainEqual(['interrupt', { sessionID: 's' }]);
	await handle('session.execution.interrupted', { reason: 'user' });
	expect(statuses()).toEqual(['working']);
	expect(it.status).toBe('idle');
	await handle('session.execution.started', {});
	await handle('session.execution.interrupted', { reason: 'user' });
	expect(statuses()).toEqual(['working', 'working', 'idle']);
});

const asked = (data: Record<string, unknown> = {}) => ({
	id: 'per_1',
	action: 'shell',
	resources: ['rm -rf build'],
	save: ['rm *'],
	source: { type: 'tool', messageID: 'm', id: 't' },
	...data,
});

test('a permission needs attention until answered; allow for session adds session rules and replies once', async () => {
	const { session: it, handle, statuses, messages, idOf, calls } = fakeSession();
	await handle('session.execution.started', {});
	await call(handle, 't', 'shell', { command: 'rm -rf build', workdir: 'sub' });
	await handle('permission.asked', asked());
	expect(messages().at(-1)).toEqual({
		kind: 'permission',
		subject: { kind: 'command', command: 'rm -rf build', cwd: '/src/sub' },
		reason: null,
		decisions: ['allow', 'allowForSession', 'deny', 'abort'],
	});
	expect(statuses()).toEqual(['working', 'needsAttention']);
	await it.hear({ kind: 'permission', request_id: idOf('permission'), decision: 'allowForSession' });
	expect(calls).toContainEqual([
		'update',
		{ sessionID: 's', permissions: [{ action: 'read', resource: '*', effect: 'allow' }, { action: 'shell', resource: 'rm *', effect: 'allow' }] },
	]);
	expect(calls.at(-1)).toEqual(['permission.reply', { sessionID: 's', requestID: 'per_1', decision: 'once' }]);
	expect(calls.some(([, input]) => (input as { decision?: string }).decision === 'always')).toBe(false);
	expect(statuses()).toEqual(['working', 'needsAttention', 'working']);
});

test("words said while a permission waits reject it with them; one with nothing to save offers no allow for session", async () => {
	const { session: it, handle, messages, calls } = fakeSession();
	await handle('permission.asked', asked({ save: [] }));
	expect(messages().at(-1)).toMatchObject({ decisions: ['allow', 'deny', 'abort'] });
	await it.hear({ kind: 'text', text: 'use trash instead' });
	expect(calls).toEqual([['permission.reply', { sessionID: 's', requestID: 'per_1', decision: 'reject', message: 'use trash instead' }]]);
	// Nothing else is prompted: OpenCode hears the words with the rejection.
	expect(calls.some(([name]) => name === 'prompt')).toBe(false);
});

test("a request answered in OpenCode itself waits no more", async () => {
	const { handle, statuses } = fakeSession();
	await handle('session.execution.started', {});
	await handle('permission.asked', asked());
	await handle('permission.replied', { requestID: 'per_1', reply: 'once' });
	expect(statuses()).toEqual(['working', 'needsAttention', 'working']);
});

test('a form is a question; the answers go back by field key, an option by its value', async () => {
	const { session: it, handle, messages, idOf, calls } = fakeSession();
	const form = {
		id: 'frm_1',
		sessionID: 's',
		title: 'Questions',
		fields: [
			{ key: 'q0', type: 'string', title: 'Auth', description: 'Which auth?', options: [{ value: 'oauth', label: 'OAuth' }, { value: 'key', label: 'API key' }], custom: true },
			{ key: 'q1', type: 'multiselect', description: 'Which targets?', options: [{ value: 'web', label: 'Web' }, { value: 'ios', label: 'iOS' }] },
		],
	};
	await handle('form.created', { form });
	expect(messages().at(-1)).toEqual({
		kind: 'question',
		questions: [
			{ header: 'Auth', question: 'Which auth?', options: [{ label: 'OAuth', description: null }, { label: 'API key', description: null }], multi_select: false, allows_other: true },
			{ header: null, question: 'Which targets?', options: [{ label: 'Web', description: null }, { label: 'iOS', description: null }], multi_select: true, allows_other: true },
		],
	});
	await it.hear({ kind: 'answers', request_id: idOf('question'), answers: [{ selected: ['OAuth'] }, { selected: ['Web'], other: 'Android' }] });
	expect(calls).toEqual([['form.reply', { sessionID: 's', formID: 'frm_1', answer: { q0: 'oauth', q1: ['web', 'Android'] } }]]);
});

test("a response to a request this actor session never had goes in as words", async () => {
	const { session: it, calls } = fakeSession();
	await it.hear({ kind: 'plan', request_id: 99, approved: true });
	expect(calls).toEqual([['prompt', { sessionID: 's', text: 'I approve your plan; go ahead.' }]]);
});

test('a new actor session makes its session with its agent, model and given title, then prompts it with the images', async () => {
	const { session: it, calls } = fakeSession(undefined, { session_id: null, agent: 'plan', model: 'opencode/big-pickle', effort: 'high', titled: 'given', title: 'Fix it' });
	await it.say('go', [{ media_type: 'image/png', data: PNG }]);
	expect(calls[0]).toEqual([
		'create',
		{ location: { directory: '/src' }, agent: 'plan', model: { providerID: 'opencode', id: 'big-pickle', variant: 'high' }, title: 'Fix it' },
	]);
	expect(calls.at(-1)).toEqual([
		'prompt',
		{ sessionID: 'new', text: 'go', files: [{ uri: `data:image/png;base64,${PNG}`, name: 'image-1.png', source: { type: 'inline' } }] },
	]);
});

test("OpenCode's title replaces one Cohesion took from the prompt, but never one given", async () => {
	const pending = fakeSession(undefined, { titled: 'pending' });
	await pending.handle('session.renamed', { title: 'Fix the login bug' });
	await pending.handle('session.renamed', { title: 'Fix the login bug' });
	expect(pending.sent.filter((report) => report.kind === 'title')).toEqual([{ kind: 'title', title: 'Fix the login bug' }]);
	const given = fakeSession(undefined, { titled: 'given', title: 'Mine' });
	await given.handle('session.renamed', { title: 'Theirs' });
	expect(given.sent).toEqual([]);
});

test("each step says how full the context is, from the step's tokens and the model's window", async () => {
	const { handle, sent } = fakeSession();
	await handle('session.step.started', { model: { providerID: 'opencode', id: 'm' } });
	await handle('session.step.ended', { tokens: { input: 100, output: 20, reasoning: 5, cache: { read: 300, write: 0 } } });
	expect(sent).toEqual([{ kind: 'context', context: { used_tokens: 425, total_tokens: 1000 } }]);
});
