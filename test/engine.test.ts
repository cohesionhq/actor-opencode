import { expect, test } from 'bun:test';

import { Events } from '../src/engine.ts';

test("a subagent's events go to the actor session of its root session, marked a child's; an unknown session's are orphans", () => {
	const heard: [string, boolean][] = [];
	const orphans: string[] = [];
	const events = new Events({ events: { subscribe: () => [] } } as never, (session) => orphans.push(session), () => {});
	events.listen('root', (event, child) => heard.push([event.type, child]));
	const route = (event: unknown) => events.route(event as never);
	route({ type: 'session.created', data: { sessionID: 'kid', parentID: 'root' } });
	route({ type: 'session.created', data: { sessionID: 'grandkid', parentID: 'kid' } });
	route({ type: 'session.text.ended', data: { sessionID: 'root' } });
	route({ type: 'permission.asked', data: { sessionID: 'grandkid' } });
	route({ type: 'form.created', data: { form: { sessionID: 'kid' } } });
	route({ type: 'session.execution.started', data: { sessionID: 'other' } });
	expect(heard).toEqual([['session.text.ended', false], ['permission.asked', true], ['form.created', true]]);
	expect(orphans).toEqual(['other']);
});
