// A ActorSession reporting to a fake cohesiond and a fake OpenCode, handed OpenCode's events directly.

import type { SessionStore } from 'cohesion-agent-kit';
import type { ActorSessionReport, Client } from 'cohesion-ts';

import { ActorSession, type SessionOpenCode, type SessionRecord } from '../src/session.ts';

/** An actor session reporting to a fake cohesiond, which refuses what `refuse` says to. */
export function fakeSession(refuse: (report: ActorSessionReport) => boolean = () => false, record: Partial<SessionRecord> = {}) {
	const sent: ActorSessionReport[] = [];
	/** What the actor session asked of OpenCode, as `[method, input]`, in order. */
	const calls: [string, unknown][] = [];
	const client = {
		report: async (_: number, report: ActorSessionReport) => {
			sent.push(report);
			if (refuse(report)) throw new Error('refused');
			return { id: sent.length };
		},
	} as unknown as Client;
	const store = { put() {}, get() {} } as unknown as SessionStore<SessionRecord>;
	const call = (name: string, result: unknown = undefined) => async (input: unknown) => {
		calls.push([name, input]);
		return result;
	};
	const opencode = {
		sessions: {
			create: call('create', { id: 'new' }),
			prompt: call('prompt'),
			interrupt: call('interrupt'),
			switchAgent: call('switchAgent'),
			get: call('get', { permissions: [{ action: 'read', resource: '*', effect: 'allow' }] }),
			update: call('update'),
			form: { reply: call('form.reply'), cancel: call('form.cancel') },
		},
		permission: { reply: call('permission.reply') },
		experimental: { session: { instructions: { entry: { put: call('instructions') } } } },
	} as unknown as SessionOpenCode;
	const it = new ActorSession(
		1,
		{ actor: 'a', session_id: 's', agent: 'build', model: null, effort: null, ...record },
		{ client, store, opencode, events: { listen() {} }, cwd: '/src', contextLimit: async () => 1000, log() {} },
	);
	const handle = (type: string, data: Record<string, unknown>, child = false) =>
		(it as unknown as { handle(e: unknown, c: boolean): Promise<void> }).handle({ type, data: { sessionID: 's', ...data } }, child);
	return {
		session: it,
		sent,
		calls,
		handle,
		/** The actor session's statuses as said to cohesiond, in order. */
		statuses: () => sent.flatMap((report) => (report.kind === 'status' ? [report.status] : [])),
		messages: () => sent.flatMap((report) => (report.kind === 'message' ? [report.content] : [])),
		/** The ids of the messages whose tools were ended, in order. */
		ended: () => sent.flatMap((report) => (report.kind === 'end' ? [report.message_id] : [])),
		/** The id the fake gave the message whose content is of `kind`, the last such. */
		idOf: (kind: string) => sent.findLastIndex((report) => report.kind === 'message' && report.content.kind === kind) + 1,
	};
}

/** A tool call: its input starting, then the call. */
export async function call(handle: ReturnType<typeof fakeSession>['handle'], id: string, name: string, input: Record<string, unknown>) {
	await handle('session.tool.input.started', { id, name });
	await handle('session.tool.called', { id, input, executed: true });
}
