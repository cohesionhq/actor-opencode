// The one OpenCode this client runs, embedded in its process, and the
// stream of its events, handed to the actor session whose session each is about.

import { OpenCode } from '@opencode/sdk';
import type { OpenCodeEvent } from '@opencode/client';

/** The embedded OpenCode, as the SDK hands it out. */
export type OpenCodeHost = OpenCode.Interface;

/** How long after the event stream ends it is opened again. */
const RESUBSCRIBE = 1_000;

/** The events an actor session acts on; the rest, deltas above all, are never read. */
export const EVENT_TYPES = [
	'session.created',
	'session.execution.started',
	'session.execution.succeeded',
	'session.execution.failed',
	'session.execution.interrupted',
	'session.status',
	'session.step.started',
	'session.step.ended',
	'session.text.ended',
	'session.tool.input.started',
	'session.tool.called',
	'session.tool.success',
	'session.tool.failed',
	'session.renamed',
	'permission.asked',
	'permission.replied',
	'form.created',
	'form.replied',
	'form.cancelled',
] as const;

/** Where an event goes: the actor session's own session, or a subagent's under it. */
export type Listener = (event: OpenCodeEvent, child: boolean) => void;

/** The OpenCode session an event is about, if any. */
export function sessionOf(event: OpenCodeEvent): string | null {
	const data = (event as { data?: unknown }).data as Record<string, unknown> | undefined;
	if (!data) return null;
	if (typeof data.sessionID === 'string') return data.sessionID;
	// A form carries its session inside it.
	const form = data.form as { sessionID?: unknown } | undefined;
	return typeof form?.sessionID === 'string' ? form.sessionID : null;
}

/**
 * Routes OpenCode's events to actor sessions by session. A subagent runs in a child
 * session of its own: its events go to the actor session its root session belongs
 * to, marked as a child's, so a permission it asks reaches the user.
 */
export class Events {
	private readonly listeners = new Map<string, Listener>();
	/** Each child session's parent, as OpenCode said on creating it. */
	private readonly parents = new Map<string, string>();
	private stopped = false;
	private abort: AbortController | null = null;

	constructor(
		private readonly opencode: Pick<OpenCodeHost, 'events'>,
		/** An event for a session no actor session listens to yet, such as one OpenCode resumes after a restart. */
		private readonly orphan: (sessionId: string, event: OpenCodeEvent) => void,
		private readonly log: (message: string) => void,
	) {}

	listen(sessionId: string, listener: Listener): void {
		this.listeners.set(sessionId, listener);
	}

	forget(sessionId: string): void {
		this.listeners.delete(sessionId);
	}

	/** Reads OpenCode's events until stopped, opening the stream again should it end. */
	async run(): Promise<void> {
		while (!this.stopped) {
			this.abort = new AbortController();
			try {
				for await (const event of this.opencode.events.subscribe({ types: EVENT_TYPES, signal: this.abort.signal })) this.route(event);
			} catch (error) {
				if (this.stopped) break;
				this.log(`OpenCode's events stopped: ${error instanceof Error ? error.message : error}`);
			}
			if (!this.stopped) await Bun.sleep(RESUBSCRIBE);
		}
	}

	stop(): void {
		this.stopped = true;
		this.abort?.abort();
	}

	/** Hands `event` to its actor session. The stream waits on each, so a listener mustn't. */
	route(event: OpenCodeEvent): void {
		// Only for knowing whose a subagent's session is: no actor session acts on it.
		if (event.type === 'session.created') {
			if (event.data.parentID) this.parents.set(event.data.sessionID, event.data.parentID);
			return;
		}
		const session = sessionOf(event);
		if (!session) return;
		const root = this.root(session);
		const listener = this.listeners.get(root);
		if (listener) return listener(event, root !== session);
		if (root === session) this.orphan(session, event);
	}

	/** The session at the top of `session`'s subagents, or itself. */
	private root(session: string): string {
		let at = session;
		for (let depth = 0; depth < 32; depth++) {
			const parent = this.parents.get(at);
			if (!parent) break;
			at = parent;
		}
		return at;
	}
}

/** Starts the embedded OpenCode, with the user's own OpenCode configuration and data. */
export function startOpenCode(): Promise<OpenCodeHost> {
	return OpenCode.create();
}
