// One Cohesion actor session, run as one OpenCode session: what the user says goes
// in as the session's prompts, and what OpenCode does comes back as the
// actor session's transcript, status and progress.

import type { FormInfo1, OpenCodeEvent, TokenUsageInfo } from '@opencode/client';
import { Subagents, describe, reportTo, sendable, type AddressedReport, type SessionRecordBase, type SessionStore, type SubagentLaunch, type SubagentReport } from 'cohesion-agent-kit';
import type { ActorSaidContent, ActorSessionStatus, ActorUserContent, Client, ClientImage, ContextUsage } from 'cohesion-ts';

import { sessionOf, type Events, type OpenCodeHost } from './engine.ts';
import { attachments, imagesIn, readsImage } from './images.ts';
import { COHESION_INSTRUCTIONS, INSTRUCTIONS_KEY } from './instructions.ts';
import { modelIdentifier, modelRef } from './offers.ts';
import { QUESTION_TOOL, formAnswer, formQuestions, permissionRequest, progress, toolUse, type PermissionRequest } from './translate.ts';

/** The parts of the embedded OpenCode an actor session uses. */
export type SessionOpenCode = Pick<OpenCodeHost, 'sessions' | 'permission' | 'experimental'>;

/**
 * What is kept on disk of one actor session, by Cohesion's id for it, so a
 * restart carries on in its OpenCode session. Its `model` is
 * `<provider>/<model>`, and its `effort` the model's variant.
 */
export interface SessionRecord extends SessionRecordBase {
	/** The OpenCode session the actor session runs in, once it has one. */
	session_id: string | null;
	/** The OpenCode agent it runs as: the actor session's mode. */
	agent: string;
}

/** What an actor session needs from the client around it. */
export interface SessionContext {
	client: Client;
	store: SessionStore<SessionRecord>;
	opencode: SessionOpenCode;
	events: Pick<Events, 'listen'>;
	/** The actor's directory. */
	cwd: string;
	/** How many tokens model `model` holds in its context, once known. */
	contextLimit: (model: { providerID: string; id: string }) => Promise<number | null>;
	log: (message: string) => void;
}

/** A request waiting on the user: a permission OpenCode asked, or a form, such as its questions. */
type Pending =
	| { kind: 'permission'; asked: PermissionRequest; owner: string | undefined }
	| { kind: 'form'; form: FormInfo1; owner: string | undefined };

/** What is known of a subagent, a child session, beyond what the kit keeps. */
interface Child {
	/** How many tokens its model's context holds at most, as its model last said. */
	window: number | null;
	/** The context last said for it. */
	said: ContextUsage | null;
	/** Its launch as last said, to say again with more. */
	launched: Omit<SubagentLaunch, 'kind'>;
	title: string;
}

/** `value` as text, or an empty string when it isn't some. */
function text(value: unknown): string {
	return typeof value === 'string' ? value.trim() : '';
}

/** A tool use waiting on its result. */
interface Use {
	name: string;
	input: Record<string, unknown>;
	content: Extract<ActorSaidContent, { kind: 'toolUse' }>;
	/** Whether it is shown only once its result is in, with its images. */
	held: boolean;
	/** Whose transcript it is in: a subagent's key, or the actor session's own. */
	owner: string | undefined;
	/** The subagent it launched, once matched to the session OpenCode made for it. */
	child?: string;
	/** The messages showing it, settling with their ids. */
	shown: Promise<{ id: number }>[];
}

export class ActorSession {
	/** Where the actor session stands, as this client last reported it. */
	status: ActorSessionStatus = 'idle';
	private progress: string | null = null;
	/** The requests waiting on the user, by their message's id. */
	private readonly waiting = new Map<number, Pending>();
	/** The subagents, by OpenCode's id for the child session each runs in, as cohesiond is told of them. */
	private readonly subagents: Subagents;
	private readonly children = new Map<string, Child>();
	/** The same, by OpenCode's id for the permission or form. */
	private readonly requests = new Map<string, number>();
	/** Each tool's name, by OpenCode's id for its call, from as its input starts. */
	private readonly names = new Map<string, string>();
	/** The tool uses waiting on their results, by OpenCode's id for the call. */
	private readonly uses = new Map<string, Use>();
	private stopping = false;
	/** The session, once made: what the actor session says goes in once it is. */
	private session: Promise<string> | null = null;
	/** Events in the order they came, handled one at a time. */
	private queue: Promise<void> = Promise.resolve();
	/** How many tokens the session's context holds at most, as its model last said. */
	private window: number | null = null;
	/** The context last said to cohesiond, which keeps it with the actor session. */
	private said: ContextUsage | null = null;

	constructor(
		readonly id: number,
		private record: SessionRecord,
		private readonly context: SessionContext,
	) {
		this.subagents = Subagents.of(context.client, id);
		if (record.session_id) this.attach(record.session_id);
	}

	/**
	 * Hands the actor session what the user said, with the images they attached: more
	 * to do, or a response to a request. Words said while requests wait
	 * pass them over: OpenCode hears the words as why, and carries on.
	 */
	async hear(content: ActorUserContent, images: ClientImage[] = [], subagent?: string): Promise<void> {
		if (content.kind === 'text') {
			// Only the requests of the transcript spoken in: words to the session pass over a subagent's.
			const asked = [...this.waiting].filter(([, pending]) => pending.owner === subagent).map(([id]) => id);
			if (asked.length === 0) return this.say(content.text, images);
			for (const id of asked) await this.answer(id, content);
			if (images.length) await this.say('The images I attached to my reply:', images);
			return;
		}
		const waiter = this.waiting.get(content.request_id);
		if (!waiter || waiter.owner !== subagent) {
			// Asked before a restart, say: OpenCode reads it as words.
			return this.say(describe(content), images);
		}
		await this.answer(content.request_id, content);
		// A response can't carry images to OpenCode, so they follow it.
		if (images.length) await this.say('The images I attached to my response:', images);
	}

	/** Starts a turn with `text` and `images`, or adds them to the turn under way. */
	async say(text: string, images: ClientImage[] = []): Promise<void> {
		// cohesiond sets an actor session the user speaks to working itself.
		this.status = 'working';
		const sessionID = await this.ensureSession();
		const files = attachments(sendable(images).images);
		await this.context.opencode.sessions.prompt({ sessionID, text, ...(files.length ? { files } : {}) });
	}

	/** Stops the turn under way; the actor session is idle until the user says more. */
	async stop(): Promise<void> {
		const busy = this.status === 'working' || this.status === 'needsAttention';
		this.status = 'idle';
		this.progress = null;
		// Cohesion leaves its subagents idle, as stopped, itself.
		await this.settleChildren();
		const sessionID = this.record.session_id;
		if (!sessionID || !busy) return;
		this.stopping = true;
		for (const id of [...this.waiting.keys()]) await this.answer(id, null);
		await this.context.opencode.sessions.interrupt({ sessionID });
	}

	/** Runs the actor session as agent `agent` from its next step on, leaving its status as it is. */
	async setMode(agent: string): Promise<void> {
		const sessionID = this.record.session_id;
		// An agent OpenCode refuses leaves the old one, as cohesiond does.
		if (sessionID) await this.context.opencode.sessions.switchAgent({ sessionID, agent });
		this.keep({ ...this.record, agent });
	}

	/** Reports where the actor session stands, for a session that just began: cohesiond forgot. */
	async resync(report: AddressedReport): Promise<void> {
		if (this.status === 'working' || this.status === 'needsAttention') {
			await report({ kind: 'status', status: this.status });
			await report({ kind: 'progress', progress: this.progress });
			// Said while cohesiond was away, it may not have kept it.
			if (this.record.titled === 'pending' && this.record.title) await report({ kind: 'title', title: this.record.title });
		}
		// Launched again, parents first, each with its status: cohesiond settled the working ones idle when it lost us.
		await this.subagents.resync(report);
	}

	/** Takes an event about the actor session's session, or a subagent's under it, in its turn. */
	readonly take = (event: OpenCodeEvent, child: boolean): void => {
		this.queue = this.queue
			.then(() => this.handle(event, child))
			.catch((error: Error) => this.context.log(`actor session ${this.id}: ${event.type}: ${error.message}`));
	};

	/** The actor session's session, made with its first words. */
	private ensureSession(): Promise<string> {
		if (this.record.session_id) return Promise.resolve(this.record.session_id);
		this.session ??= this.create().catch((error) => {
			this.session = null;
			throw error;
		});
		return this.session;
	}

	private async create(): Promise<string> {
		const { record } = this;
		const model = modelRef(record.model, record.effort);
		const session = await this.context.opencode.sessions.create({
			location: { directory: this.context.cwd },
			agent: record.agent,
			...(model ? { model } : {}),
			...(record.titled === 'given' && record.title ? { title: record.title } : {}),
		});
		this.keep({ ...this.record, session_id: session.id });
		this.attach(session.id);
		await this.context.opencode.experimental.session.instructions.entry
			.put({ sessionID: session.id, key: INSTRUCTIONS_KEY, value: COHESION_INSTRUCTIONS })
			.catch((error: Error) => this.context.log(`actor session ${this.id}: couldn't add Cohesion's instructions: ${error.message}`));
		return session.id;
	}

	private attach(sessionId: string): void {
		this.context.events.listen(sessionId, this.take);
	}

	private async handle(event: OpenCodeEvent, _child: boolean): Promise<void> {
		// A subagent's session reports into its own transcript, under its key (OpenCode's id for the session).
		const owner = this.ownerOf(event);
		if (owner !== undefined) {
			if (event.type === 'session.created') return this.created(event);
			// One this process never saw begin, such as after a restart: launched from what OpenCode knows of it.
			if (!(await this.ensureChild(owner))) return;
		}
		switch (event.type) {
			case 'session.execution.started':
				if (this.statusOf(owner) !== 'working' && !this.asking(owner)) await this.setStatusOf(owner, 'working');
				return;
			case 'session.status':
				if (owner === undefined && event.data.status.type === 'retry') await this.setProgress(`Retrying: ${event.data.status.message}`);
				return;
			case 'session.step.started': {
				const window = await this.context.contextLimit(event.data.model);
				if (owner === undefined) {
					this.window = window ?? this.window;
					return;
				}
				const child = this.children.get(owner)!;
				child.window = window ?? child.window;
				// The model it runs on, once its first step shows it.
				const model = modelIdentifier(event.data.model);
				if (child.launched.model !== model) await this.launchAgain(owner, { model });
				return;
			}
			case 'session.step.ended':
				this.setContext(event.data.tokens, owner);
				return;
			case 'session.text.ended':
				if (event.data.text.trim()) await this.show({ kind: 'text', text: event.data.text }, [], owner);
				return;
			case 'session.reasoning.ended':
				// A session's own thinking was never shown; a subagent's is its transcript.
				if (owner !== undefined && event.data.text.trim()) await this.think(event.data.text, owner);
				return;
			case 'session.tool.input.started':
				this.names.set(event.data.id, event.data.name);
				return;
			case 'session.tool.called': {
				const name = this.names.get(event.data.id) ?? 'tool';
				this.names.delete(event.data.id);
				// Its form is the request the user sees.
				if (name === QUESTION_TOOL) return;
				const input = event.data.input ?? {};
				const use: Use = { name, input, content: toolUse(name, input, this.context.cwd), held: showsImages(name, input), owner, shown: [] };
				this.uses.set(event.data.id, use);
				if (!use.held) {
					use.shown.push(this.show(use.content, [], owner));
					await use.shown[0];
				}
				if (owner === undefined) await this.setProgress(progress(name, input, this.context.cwd));
				return;
			}
			case 'session.tool.success':
			case 'session.tool.failed': {
				const use = this.uses.get(event.data.id);
				if (!use) return;
				this.uses.delete(event.data.id);
				const images = imagesIn(event.data.content);
				// One reported already that gave images after all is shown again, with them.
				if (use.held || images.length) use.shown.push(this.show(use.content, images, use.owner));
				await this.end(use);
				// The subagent it launched is done with its tool use, whatever it said of itself.
				if (use.child && this.subagents.status(use.child) === 'working' && !this.asking(use.child)) {
					await this.setStatusOf(use.child, event.type === 'session.tool.failed' ? 'failed' : 'idle');
				}
				return;
			}
			case 'session.renamed':
				if (owner === undefined) await this.retitle(event.data.title);
				else await this.retitleChild(owner, event.data.title);
				return;
			case 'permission.asked': {
				const source = event.data.source;
				const use = source ? [...this.uses.entries()].find(([id]) => id === source.id)?.[1] : undefined;
				await this.ask({ kind: 'permission', asked: event.data, owner }, event.data.id, permissionRequest(event.data, use ?? null, this.context.cwd));
				return;
			}
			case 'form.created':
				await this.ask({ kind: 'form', form: event.data.form, owner }, event.data.form.id, { kind: 'question', questions: formQuestions(event.data.form) });
				return;
			case 'permission.replied':
				return this.answered(event.data.requestID);
			case 'form.replied':
			case 'form.cancelled':
				return this.answered(event.data.id);
			case 'session.execution.succeeded':
				await this.release(owner);
				if (owner !== undefined) return this.setStatusOf(owner, 'idle');
				this.stopping = false;
				await this.setProgress(null);
				await this.setStatus('idle');
				return;
			case 'session.execution.failed': {
				await this.release(owner);
				if (owner !== undefined) {
					await this.report({ kind: 'message', content: { kind: 'text', text: event.data.error.message || event.data.error.type } }, owner);
					return this.setStatusOf(owner, 'failed');
				}
				await this.setProgress(null);
				if (this.stopping) {
					this.stopping = false;
					this.status = 'idle';
					return;
				}
				await this.report({ kind: 'message', content: { kind: 'text', text: event.data.error.message || event.data.error.type } });
				await this.setStatus('failed');
				return;
			}
			case 'session.execution.interrupted': {
				await this.release(owner);
				// A newer turn takes over: it reports for itself.
				if (event.data.reason === 'superseded') return;
				// A subagent that was interrupted can only be said done.
				if (owner !== undefined) return this.setStatusOf(owner, 'idle');
				const stopped = this.stopping;
				this.stopping = false;
				await this.setProgress(null);
				// Stopped from Cohesion, which made it idle itself.
				if (stopped) this.status = 'idle';
				else await this.setStatus('idle');
				return;
			}
		}
	}

	/** The subagent an event is about: its session's id, or `undefined` for the actor session's own. */
	private ownerOf(event: OpenCodeEvent): string | undefined {
		const session = sessionOf(event);
		return session && session !== this.record.session_id ? session : undefined;
	}

	private statusOf(owner: string | undefined): ActorSessionStatus | undefined {
		return owner === undefined ? this.status : this.subagents.status(owner);
	}

	/** Whether requests wait on the user in `owner`'s transcript: a subagent's, or the actor session's own. */
	private asking(owner: string | undefined): boolean {
		return [...this.waiting.values()].some((pending) => pending.owner === owner);
	}

	/** Sets where `owner` stands: a subagent, or the actor session itself. */
	private async setStatusOf(owner: string | undefined, status: ActorSessionStatus): Promise<void> {
		if (owner === undefined) return this.setStatus(status);
		if (this.subagents.status(owner) === status) return;
		await this.subagents.setStatus(owner, status).catch((error: Error) => this.context.log(`actor session ${this.id}, subagent ${owner}: couldn't say ${status}: ${error.message}`));
	}

	/** A child session OpenCode made: a subagent, launched under the session whose `parentID` it names. */
	private async created(event: Extract<OpenCodeEvent, { type: 'session.created' }>): Promise<void> {
		const { sessionID, parentID, title, agent, model } = event.data;
		if (!parentID || this.subagents.has(sessionID)) return;
		await this.launch(sessionID, { parentID, title, agent, model });
	}

	/** Makes sure subagent `key` is launched, asking OpenCode what it is when this process never saw it made. */
	private async ensureChild(key: string): Promise<boolean> {
		if (this.subagents.has(key)) return true;
		try {
			const info = await this.context.opencode.sessions.get({ sessionID: key });
			if (!info.parentID) return false;
			await this.launch(key, { parentID: info.parentID, title: info.title, agent: info.agent, model: info.model });
		} catch (error) {
			this.context.log(`actor session ${this.id}: couldn't tell what session ${key} is: ${(error as Error).message}`);
		}
		return this.subagents.has(key);
	}

	/**
	 * Tells cohesiond of the subagent `key`, a child session of `parentID`,
	 * under the subagent whose session that is or else the actor session.
	 * The tool use that launched it is the oldest `subagent` call in that
	 * transcript not yet matched to a session: OpenCode doesn't say which.
	 */
	private async launch(key: string, seed: { parentID: string; title?: string; agent?: string; model?: { providerID: string; id: string } }): Promise<void> {
		let parent: string | null = seed.parentID === this.record.session_id ? null : seed.parentID;
		if (parent !== null && !(await this.ensureChild(parent))) parent = null;
		const use = [...this.uses.values()].find((use) => use.name === 'subagent' && !use.child && use.owner === (parent ?? undefined));
		const tool = use?.shown[0] ? (await use.shown[0]).id : -1;
		const said = {
			title: text(use?.input.description) || seed.title?.trim() || 'Subagent',
			parent,
			message_id: tool === -1 ? null : tool,
			agent_type: text(use?.input.subagent_type) || text(use?.input.agent) || seed.agent || null,
			model: seed.model ? modelIdentifier(seed.model) : null,
			background: use?.input.background === true,
		};
		try {
			await this.subagents.launch(key, said);
		} catch (error) {
			this.context.log(`actor session ${this.id}: couldn't launch subagent ${key}: ${(error as Error).message}`);
			return;
		}
		this.children.set(key, { window: null, said: null, launched: said, title: said.title });
		if (use) use.child = key;
	}

	/** Says more of subagent `key`, launching it again with what is new. */
	private async launchAgain(key: string, more: { model?: string }): Promise<void> {
		const child = this.children.get(key);
		if (!child) return;
		child.launched = { ...child.launched, ...more };
		await this.subagents.launch(key, child.launched).catch((error: Error) => this.context.log(`actor session ${this.id}: couldn't update subagent ${key}: ${error.message}`));
	}

	/** Says OpenCode's title for subagent `key`, when it changes. */
	private async retitleChild(key: string, title: string): Promise<void> {
		const child = this.children.get(key);
		const trimmed = title.trim();
		if (!child || !trimmed || trimmed === child.title) return;
		child.title = trimmed;
		await this.report({ kind: 'title', title: trimmed }, key);
	}

	/** Leaves the subagents still going idle: the actor session was stopped. */
	private async settleChildren(): Promise<void> {
		for (const key of this.subagents.keys) {
			const status = this.subagents.status(key);
			if (status === 'working' || status === 'needsAttention') await this.setStatusOf(key, 'idle');
		}
	}

	/** Shows request `asked` as `content`, and waits on the user: the actor session needs attention. */
	private async ask(pending: Pending, requestId: string, content: ActorSaidContent): Promise<void> {
		const message = await this.report({ kind: 'message', content }, pending.owner);
		if (message.id === -1) return;
		this.waiting.set(message.id, pending);
		this.requests.set(requestId, message.id);
		await this.setStatusOf(pending.owner, 'needsAttention');
	}

	/** A request answered, here or elsewhere (in OpenCode's own UI, or by a rule it saved): the actor session waits on it no more. */
	private async answered(requestId: string): Promise<void> {
		const message = this.requests.get(requestId);
		if (message === undefined) return;
		this.requests.delete(requestId);
		const owner = this.waiting.get(message)?.owner;
		this.waiting.delete(message);
		if (!this.asking(owner) && this.statusOf(owner) === 'needsAttention' && !this.stopping) await this.setStatusOf(owner, 'working');
	}

	/** Tells OpenCode the user's `response` to the request shown as message `id`, or that it is called off when null. */
	private async answer(id: number, response: ActorUserContent | null): Promise<void> {
		const pending = this.waiting.get(id);
		if (!pending) return;
		const { opencode } = this.context;
		if (pending.kind === 'permission') {
			const { sessionID, id: requestID } = pending.asked;
			if (response?.kind === 'permission' && (response.decision === 'allow' || response.decision === 'allowForSession')) {
				if (response.decision === 'allowForSession') await this.allowForSession(pending.asked);
				await opencode.permission.reply({ sessionID, requestID, decision: 'once' });
			} else {
				const why = response?.kind === 'permission' ? response.message : response?.kind === 'text' ? response.text : null;
				await opencode.permission.reply({ sessionID, requestID, decision: 'reject', ...(why ? { message: why } : {}) });
				if (response?.kind === 'permission' && response.decision === 'abort') void this.stop();
			}
		} else {
			const { sessionID, id: formID } = pending.form;
			if (response?.kind === 'answers') {
				await opencode.sessions.form.reply({ sessionID, formID, answer: formAnswer(pending.form, response.answers) });
			} else {
				const why = response?.kind === 'text' ? `The user didn't answer, and said instead: ${response.text}` : undefined;
				await opencode.sessions.form.cancel({ sessionID, formID, ...(why ? { message: why } : {}) });
			}
		}
		await this.answered(pending.kind === 'permission' ? pending.asked.id : pending.form.id);
	}

	/**
	 * Allows what `asked` asks, and the like (OpenCode's `save` patterns),
	 * for the rest of the session: rules on the session that asked and the
	 * actor session's own, never saved for the project as OpenCode's "always" does.
	 */
	private async allowForSession(asked: PermissionRequest): Promise<void> {
		const rules = (asked.save ?? []).map((resource) => ({ action: asked.action, resource, effect: 'allow' as const }));
		const sessions = new Set([asked.sessionID, this.record.session_id].filter((id): id is string => !!id));
		for (const sessionID of sessions) {
			try {
				const session = await this.context.opencode.sessions.get({ sessionID });
				await this.context.opencode.sessions.update({ sessionID, permissions: [...(session.permissions ?? []), ...rules] });
			} catch (error) {
				this.context.log(`actor session ${this.id}: couldn't allow ${asked.action} for the session: ${(error as Error).message}`);
			}
		}
	}

	/** Says OpenCode's title for the session as the actor session's, for an actor session Cohesion titled with its prompt's first line. */
	private async retitle(title: string): Promise<void> {
		const trimmed = title.trim();
		if (this.record.titled !== 'pending' || !trimmed || trimmed === this.record.title) return;
		this.keep({ ...this.record, title: trimmed });
		await this.report({ kind: 'title', title: trimmed });
	}

	/** Reports the tool uses still held, whose results never came. */
	private async release(owner: string | undefined): Promise<void> {
		const mine = [...this.uses].filter(([, use]) => use.owner === owner);
		for (const [id] of mine) this.uses.delete(id);
		if (owner === undefined) this.names.clear();
		for (const [, use] of mine) if (use.held) await this.show(use.content, [], owner);
	}

	/**
	 * Reports a stretch of a subagent's thinking and ends it at once: OpenCode
	 * gives its text only once it is done, and a message's text can't change later.
	 */
	private async think(text: string, owner: string): Promise<void> {
		const { id } = await this.report({ kind: 'message', content: { kind: 'thinking', text, ended_at: null } }, owner);
		if (id !== -1) await this.report({ kind: 'end', message_id: id }, owner);
	}

	/** Reports that `use`'s tool has ended, once each message showing it has its id. */
	private async end(use: Use): Promise<void> {
		for (const shown of use.shown) {
			const { id } = await shown;
			// A refused one has nothing to end.
			if (id !== -1) await this.report({ kind: 'end', message_id: id }, use.owner);
		}
	}

	/**
	 * Reports `content` in the transcript with the `images` cohesiond will
	 * take, saying so when there are some it can't show: it refuses a whole
	 * message for one image, so a refused one goes again without them.
	 */
	private async show(content: ActorSaidContent, images: ClientImage[] = [], owner?: string): Promise<{ id: number }> {
		const checked = sendable(images);
		for (const why of checked.dropped) this.context.log(`actor session ${this.id}: an image can't be shown: ${why}`);
		let dropped = checked.dropped.length;
		let message: { id: number };
		if (checked.images.length) {
			try {
				message = (await reportTo(this.context.client, this.id, { kind: 'message', content, images: checked.images }, owner)) as { id: number };
			} catch (error) {
				this.context.log(`actor session ${this.id}: update with images refused: ${(error as Error).message}`);
				dropped += checked.images.length;
				message = await this.report({ kind: 'message', content }, owner);
			}
		} else message = await this.report({ kind: 'message', content }, owner);
		if (dropped && message.id !== -1) await this.report({ kind: 'message', content: { kind: 'text', text: unshown(dropped) } }, owner);
		return message;
	}

	/** Says how full the context is after a step, unless unchanged or the window isn't known. */
	private setContext(tokens: TokenUsageInfo, owner?: string): void {
		const child = owner === undefined ? undefined : this.children.get(owner);
		const context = contextOf(tokens, child ? child.window : this.window);
		if (!context) return;
		const said = child ? child.said : this.said;
		if (context.used_tokens === said?.used_tokens && context.total_tokens === said.total_tokens) return;
		if (child) child.said = context;
		else this.said = context;
		void this.report({ kind: 'context', context }, owner);
	}

	private keep(record: SessionRecord): void {
		this.record = record;
		this.context.store.put(this.id, record);
	}

	private async setStatus(status: ActorSessionStatus): Promise<void> {
		if (this.status === status) return;
		this.status = status;
		await this.report({ kind: 'status', status });
	}

	private async setProgress(progress: string | null): Promise<void> {
		if (this.progress === progress) return;
		this.progress = progress;
		await this.report({ kind: 'progress', progress });
	}

	private report(report: Extract<SubagentReport, { kind: 'message' }>, subagent?: string): Promise<{ id: number }>;
	private report(report: SubagentReport, subagent?: string): Promise<unknown>;
	private report(report: SubagentReport, subagent?: string): Promise<unknown> {
		// A subagent cohesiond never took: nothing to report into.
		if (subagent !== undefined && !this.subagents.has(subagent)) return Promise.resolve({ id: -1 });
		return reportTo(this.context.client, this.id, report, subagent).catch((error: Error) => {
			// Refused, such as for an actor session cohesiond no longer has: dropped.
			this.context.log(`actor session ${this.id}: update refused: ${error.message}`);
			return { id: -1 };
		});
	}
}

/**
 * How full a context of `window` tokens is after a step that used
 * `tokens`: everything the step read, cached or not, and what it wrote,
 * which the next step reads. Null while the window isn't known.
 */
export function contextOf(tokens: TokenUsageInfo, window: number | null): ContextUsage | null {
	if (!window || window <= 0) return null;
	const used = tokens.input + tokens.cache.read + tokens.cache.write + tokens.output + tokens.reasoning;
	if (!Number.isFinite(used)) return null;
	return { used_tokens: Math.max(0, Math.round(used)), total_tokens: Math.round(window) };
}

/** Whether tool `name` may give back images, so its use waits for its result: an image `read`, or any tool not OpenCode's own. */
function showsImages(name: string, input: Record<string, unknown>): boolean {
	if (name === 'read') return typeof input.path === 'string' && readsImage(input.path);
	return !BUILT_IN.has(name);
}

const BUILT_IN = new Set(['shell', 'edit', 'write', 'patch', 'grep', 'glob', 'webfetch', 'websearch', 'subagent', 'skill', 'todowrite', 'question']);

/** The note in place of images that couldn't be shown. */
function unshown(count: number): string {
	return count === 1 ? "(An image couldn't be shown here.)" : `(${count} images couldn't be shown here.)`;
}
