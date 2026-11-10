import { expect, test } from 'bun:test';

import { Events } from '../src/engine.ts';

test("a subagent's events go to the actor session of its root session, marked a child's; an unknown session's are orphans", async () => {
	const heard: [string, boolean][] = [];
	const orphans: string[] = [];
	const events = new Events({ events: { subscribe: () => [] }, sessions: { get: async () => ({}) } } as never, (session) => orphans.push(session), () => {});
	events.listen('root', (event, child) => heard.push([event.type, child]));
	const route = (event: unknown) => events.route(event as never);
	route({ type: 'session.created', data: { sessionID: 'root' } });
	route({ type: 'session.created', data: { sessionID: 'kid', parentID: 'root' } });
	route({ type: 'session.created', data: { sessionID: 'grandkid', parentID: 'kid' } });
	route({ type: 'session.text.ended', data: { sessionID: 'root' } });
	route({ type: 'permission.asked', data: { sessionID: 'grandkid' } });
	route({ type: 'form.created', data: { form: { sessionID: 'kid' } } });
	route({ type: 'session.execution.started', data: { sessionID: 'other' } });
	await Bun.sleep(0);
	// A subagent's creation reaches its actor session, which launches it.
	expect(heard).toEqual([['session.created', true], ['session.created', true], ['session.text.ended', false], ['permission.asked', true], ['form.created', true]]);
	expect(orphans).toEqual(['other']);
});

test("after a restart, a session's parents are asked of OpenCode once, its events held in order, and go to the root's actor session", async () => {
	const orphans: [string, string][] = [];
	const asked: string[] = [];
	const parents: Record<string, string> = { grandkid: 'kid', kid: 'root' };
	const events = new Events(
		{ events: { subscribe: () => [] }, sessions: { get: async ({ sessionID }: { sessionID: string }) => (asked.push(sessionID), { parentID: parents[sessionID] }) } } as never,
		(session, event) => orphans.push([session, event.type]),
		() => {},
	);
	const route = (event: unknown) => events.route(event as never);
	route({ type: 'session.text.ended', data: { sessionID: 'grandkid' } });
	route({ type: 'session.tool.called', data: { sessionID: 'grandkid' } });
	await Bun.sleep(0);
	expect(orphans).toEqual([['root', 'session.text.ended'], ['root', 'session.tool.called']]);
	expect(asked).toEqual(['grandkid', 'kid', 'root']);
	// Known now: no more asking, and a listener hears it as a child's.
	const heard: boolean[] = [];
	events.listen('root', (_, child) => heard.push(child));
	route({ type: 'session.text.ended', data: { sessionID: 'kid' } });
	expect(heard).toEqual([true]);
	expect(asked).toHaveLength(3);
});
