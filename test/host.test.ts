import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, expect, test } from 'bun:test';

import { SessionHost, SessionStore, type ActorEntry, type Client, type ClientCall } from 'cohesion-agent-kit';

import { Events, type OpenCodeHost } from '../src/engine.ts';
import { adoptOrphan, openCodeEngine } from '../src/host.ts';
import type { SessionRecord } from '../src/session.ts';

const directories: string[] = [];
afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

/** A `SessionHost` with this client's engine, on a store in a temp directory and a fake OpenCode and cohesiond. */
async function setUp() {
	const directory = mkdtempSync(join(tmpdir(), 'actor-opencode-'));
	directories.push(directory);
	const actor: ActorEntry = { identifier: 'a', directory };
	const sent: unknown[] = [];
	/** What was asked of OpenCode, as `[method, input]`, in order. */
	const calls: [string, unknown][] = [];
	let windowLists = 0;
	const call = (name: string, result: unknown = undefined) => async (input: unknown) => {
		calls.push([name, input]);
		return result;
	};
	const opencode = {
		agent: { list: async () => ({ data: [{ id: 'plan', name: 'Plan' }, { id: 'build', name: 'Build' }] }) },
		model: {
			// With no `types`, it is a step asking for a context window rather than an offer.
			list: async (input: { types?: string[] }) => {
				if (!input.types) windowLists++;
				return { data: [] };
			},
			default: async () => ({ data: null }),
		},
		sessions: {
			create: async (input: { model?: { id: string } }) => {
				if (input.model?.id === 'missing') throw new Error('No such model.');
				return { id: 'new' };
			},
			prompt: call('prompt'), switchAgent: call('switchAgent'),
		},
		experimental: { session: { instructions: { entry: { put: call('instructions') } } } },
	} as unknown as OpenCodeHost;
	const store = new SessionStore<SessionRecord>(directory);
	const events = new Events(opencode, (sessionId, event) => adoptOrphan(host, store, sessionId, event), () => {});
	const engine = openCodeEngine(opencode, store, events, () => {});
	const host = new SessionHost([actor], engine, store, () => {});
	host.client = {
		report: async (_: number, report: unknown) => {
			sent.push(report);
			return { id: sent.length };
		},
	} as unknown as Client;
	await engine.offers({ server: {} as never, actors: [actor] });
	const onCall = (call: Record<string, unknown>) => host.onCall({ actor: 'a', ...call } as unknown as ClientCall);
	const start = { kind: 'startActorSession', session_id: 7, prompt: 'go', title: null, mode: null, model: null, effort: null };
	return { host, store, events, engine, directory, actor, sent, calls, onCall, start, windowLists: () => windowLists };
}

test('an actor session starts as the agent cohesiond names if offered, else the default, and a session that fails fails the call', async () => {
	const { store, onCall, start, calls } = await setUp();
	await onCall({ ...start, mode: 'plan' });
	expect(store.get(7)).toEqual({ actor: 'a', session_id: 'new', agent: 'plan', model: null, effort: null, titled: 'pending' });
	expect(calls.at(-1)).toEqual(['prompt', { sessionID: 'new', text: 'go' }]);
	await onCall({ ...start, session_id: 8, mode: 'nope', title: 'Mine' });
	expect(store.get(8)).toMatchObject({ agent: 'build', titled: 'given', title: 'Mine' });
	await expect(onCall({ ...start, session_id: 9, model: 'p/missing' })).rejects.toThrow('No such model.');
});

test('a mode is switched by its agent, on disk for an actor session with no runner; one not offered is refused', async () => {
	const { directory, store, onCall, calls, start } = await setUp();
	await expect(onCall({ kind: 'setActorSessionMode', session_id: 7, mode: 'nope' })).rejects.toThrow('OpenCode has no agent nope here.');
	store.put(9, { actor: 'a', session_id: 's', agent: 'plan', model: null, effort: null });
	await onCall({ kind: 'setActorSessionMode', session_id: 9, mode: 'build' });
	expect(new SessionStore<SessionRecord>(directory).get(9)?.agent).toBe('build');
	await onCall(start);
	await onCall({ kind: 'setActorSessionMode', session_id: 7, mode: 'build' });
	expect(calls.at(-1)).toEqual(['switchAgent', { sessionID: 'new', agent: 'build' }]);
	expect(store.get(7)?.agent).toBe('build');
});

test('an actor session this client never had starts anew, given its title, with its transcript as OpenCode reads it', async () => {
	const { host, store, onCall, calls } = await setUp();
	host.client.request = (async (name: string) =>
		name === 'getActorSession'
			? { mode: 'nope', model: 'p/m', effort: null, title: 'Held' }
			: [
					{ content: { sender: 'user', kind: 'text', text: 'hi' } },
					{ content: { sender: 'actor', kind: 'toolUse', tool: 'WebFetch', summary: 'x.dev' } },
					{ content: { sender: 'actor', kind: 'text', text: 'done' } },
				]) as never;
	await onCall({ kind: 'sendActorSessionMessage', session_id: 3, content: { kind: 'text', text: 'more' } });
	expect(store.get(3)).toEqual({ actor: 'a', session_id: 'new', agent: 'build', model: 'p/m', effort: null, titled: 'given', title: 'Held' });
	expect(calls.at(-1)).toEqual([
		'prompt',
		{
			sessionID: 'new',
			text:
				'This actor session began in an OpenCode session that is no longer available. Its transcript so far, for context:\n\n' +
				'User: hi\n\n[WebFetch x.dev]\n\nAssistant: done\n\nMy new message:\n\nmore',
		},
	]);
});

test("an event for a stored actor session's session picks it up, and it hears that and the next; an unknown session's is dropped", async () => {
	const { host, store, events, sent } = await setUp();
	store.put(5, { actor: 'a', session_id: 'kept', agent: 'build', model: null, effort: null });
	const route = (type: string, sessionID: string) => events.route({ type, data: { sessionID } } as never);
	route('session.execution.started', 'unknown');
	expect(host.running).toEqual([]);
	route('session.execution.started', 'kept');
	const runner = host.session(5);
	expect(runner).toBeDefined();
	route('session.execution.succeeded', 'kept');
	expect(host.session(5)).toBe(runner);
	await Bun.sleep(0);
	expect(sent).toEqual([{ kind: 'status', status: 'working' }, { kind: 'status', status: 'idle' }]);
});

test("an orphan whose actor isn't offered any more stays on disk, unopened", async () => {
	const { host, store, events } = await setUp();
	store.put(5, { actor: 'gone', session_id: 'kept', agent: 'build', model: null, effort: null });
	events.route({ type: 'session.execution.started', data: { sessionID: 'kept' } } as never);
	expect(host.running).toEqual([]);
});

test('each offer forgets the context windows, since a directory may have changed its models', async () => {
	const { engine, actor, windowLists } = await setUp();
	const limit = async () => {
		const runner = engine.open(1, { actor: 'a', session_id: null, agent: 'build', model: null, effort: null }, actor, {} as Client);
		// What an actor session asks when a step starts.
		return (runner as unknown as { context: { contextLimit(model: { providerID: string; id: string }): Promise<number | null> } }).context.contextLimit({ providerID: 'p', id: 'm' });
	};
	await limit();
	await limit();
	expect(windowLists()).toBe(1);
	await engine.offers({ server: {} as never, actors: [actor] });
	await limit();
	expect(windowLists()).toBe(2);
});
