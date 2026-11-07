// One Cohesion actor session, run as one OpenCode session: what the user says goes
// in as the session's prompts, and what OpenCode does comes back as the
// actor session's transcript, status and progress.

import type { FormInfo1, OpenCodeEvent, TokenUsageInfo } from '@opencode/client';
import { describe, sendable, type SessionRecordBase, type SessionStore } from 'cohesion-agent-kit';
import type { ActorSaidContent, ActorSessionReport, ActorSessionStatus, ActorUserContent, Client, ClientImage, ContextUsage } from 'cohesion-ts';

import type { Events, OpenCodeHost } from './engine.ts';
import { attachments, imagesIn, readsImage } from './images.ts';
import { COHESION_INSTRUCTIONS, INSTRUCTIONS_KEY } from './instructions.ts';
import { modelRef } from './offers.ts';
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
	| { kind: 'permission'; asked: PermissionRequest }
	| { kind: 'form'; form: FormInfo1 };

/** A tool use waiting on its result. */
interface Use {
	name: string;
	input: Record<string, unknown>;
	content: Extract<ActorSaidContent, { kind: 'toolUse' }>;
	/** Whether it is shown only once its result is in, with its images. */
	held: boolean;
	/** The messages showing it, settling with their ids. */
	shown: Promise<{ id: number }>[];
}

export class ActorSession {
	/** Where the actor session stands, as this client last reported it. */
	status: ActorSessionStatus = 'idle';
	private progress: string | null = null;
	/** The requests waiting on the user, by their message's id. */
	private readonly waiting = new Map<number, Pending>();
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
		if (record.session_id) this.attach(record.session_id);
	}

	/**
	 * Hands the actor session what the user said, with the images they attached: more
	 * to do, or a response to a request. Words said while requests wait
	 * pass them over: OpenCode hears the words as why, and carries on.
	 */
	async hear(content: ActorUserContent, images: ClientImage[] = []): Promise<void> {
		if (content.kind === 'text') {
			if (this.waiting.size === 0) return this.say(content.text, images);
			for (const id of [...this.waiting.keys()]) await this.answer(id, content);
			if (images.length) await this.say('The images I attached to my reply:', images);
			return;
		}
		if (!this.waiting.has(content.request_id)) {
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
	async resync(report: (report: ActorSessionReport) => Promise<unknown>): Promise<void> {
		if (this.status !== 'working' && this.status !== 'needsAttention') return;
		await report({ kind: 'status', status: this.status });
		await report({ kind: 'progress', progress: this.progress });
		// Said while cohesiond was away, it may not have kept it.
		if (this.record.titled === 'pending' && this.record.title) await report({ kind: 'title', title: this.record.title });
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

	private async handle(event: OpenCodeEvent, child: boolean): Promise<void> {
		// A subagent's own steps stay inside its tool use; only what it asks the user comes through.
		if (child && !['permission.asked', 'permission.replied', 'form.created', 'form.replied', 'form.cancelled'].includes(event.type)) return;
		switch (event.type) {
			case 'session.execution.started':
				if (this.status !== 'working' && this.waiting.size === 0) await this.setStatus('working');
				return;
			case 'session.status':
				if (event.data.status.type === 'retry') await this.setProgress(`Retrying: ${event.data.status.message}`);
				return;
			case 'session.step.started':
				this.window = (await this.context.contextLimit(event.data.model)) ?? this.window;
				return;
			case 'session.step.ended':
				this.setContext(event.data.tokens);
				return;
			case 'session.text.ended':
				if (event.data.text.trim()) await this.show({ kind: 'text', text: event.data.text });
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
				const use: Use = { name, input, content: toolUse(name, input, this.context.cwd), held: showsImages(name, input), shown: [] };
				this.uses.set(event.data.id, use);
				if (!use.held) {
					use.shown.push(this.show(use.content));
					await use.shown[0];
				}
				await this.setProgress(progress(name, input, this.context.cwd));
				return;
			}
			case 'session.tool.success':
			case 'session.tool.failed': {
				const use = this.uses.get(event.data.id);
				if (!use) return;
				this.uses.delete(event.data.id);
				const images = imagesIn(event.data.content);
				// One reported already that gave images after all is shown again, with them.
				if (use.held || images.length) use.shown.push(this.show(use.content, images));
				await this.end(use);
				return;
			}
			case 'session.renamed':
				await this.retitle(event.data.title);
				return;
			case 'permission.asked': {
				const source = event.data.source;
				const use = source ? [...this.uses.entries()].find(([id]) => id === source.id)?.[1] : undefined;
				await this.ask({ kind: 'permission', asked: event.data }, event.data.id, permissionRequest(event.data, use ?? null, this.context.cwd));
				return;
			}
			case 'form.created':
				await this.ask({ kind: 'form', form: event.data.form }, event.data.form.id, { kind: 'question', questions: formQuestions(event.data.form) });
				return;
			case 'permission.replied':
				return this.answered(event.data.requestID);
			case 'form.replied':
			case 'form.cancelled':
				return this.answered(event.data.id);
			case 'session.execution.succeeded':
				await this.release();
				this.stopping = false;
				await this.setProgress(null);
				await this.setStatus('idle');
				return;
			case 'session.execution.failed': {
				await this.release();
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
				await this.release();
				const stopped = this.stopping;
				this.stopping = false;
				// A newer turn takes over: it reports for itself.
				if (event.data.reason === 'superseded') return;
				await this.setProgress(null);
				// Stopped from Cohesion, which made it idle itself.
				if (stopped) this.status = 'idle';
				else await this.setStatus('idle');
				return;
			}
		}
	}

	/** Shows request `asked` as `content`, and waits on the user: the actor session needs attention. */
	private async ask(pending: Pending, requestId: string, content: ActorSaidContent): Promise<void> {
		const message = await this.report({ kind: 'message', content });
		if (message.id === -1) return;
		this.waiting.set(message.id, pending);
		this.requests.set(requestId, message.id);
		await this.setStatus('needsAttention');
	}

	/** A request answered, here or elsewhere (in OpenCode's own UI, or by a rule it saved): the actor session waits on it no more. */
	private async answered(requestId: string): Promise<void> {
		const message = this.requests.get(requestId);
		if (message === undefined) return;
		this.requests.delete(requestId);
		this.waiting.delete(message);
		if (this.waiting.size === 0 && this.status === 'needsAttention' && !this.stopping) await this.setStatus('working');
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
	private async release(): Promise<void> {
		const held = [...this.uses.values()].filter((use) => use.held);
		this.uses.clear();
		this.names.clear();
		for (const use of held) await this.show(use.content);
	}

	/** Reports that `use`'s tool has ended, once each message showing it has its id. */
	private async end(use: Use): Promise<void> {
		for (const shown of use.shown) {
			const { id } = await shown;
			// A refused one has nothing to end.
			if (id !== -1) await this.report({ kind: 'end', message_id: id });
		}
	}

	/**
	 * Reports `content` in the transcript with the `images` cohesiond will
	 * take, saying so when there are some it can't show: it refuses a whole
	 * message for one image, so a refused one goes again without them.
	 */
	private async show(content: ActorSaidContent, images: ClientImage[] = []): Promise<{ id: number }> {
		const checked = sendable(images);
		for (const why of checked.dropped) this.context.log(`actor session ${this.id}: an image can't be shown: ${why}`);
		let dropped = checked.dropped.length;
		let message: { id: number };
		if (checked.images.length) {
			try {
				message = await this.context.client.report(this.id, { kind: 'message', content, images: checked.images });
			} catch (error) {
				this.context.log(`actor session ${this.id}: update with images refused: ${(error as Error).message}`);
				dropped += checked.images.length;
				message = await this.report({ kind: 'message', content });
			}
		} else message = await this.report({ kind: 'message', content });
		if (dropped && message.id !== -1) await this.report({ kind: 'message', content: { kind: 'text', text: unshown(dropped) } });
		return message;
	}

	/** Says how full the context is after a step, unless unchanged or the window isn't known. */
	private setContext(tokens: TokenUsageInfo): void {
		const context = contextOf(tokens, this.window);
		if (!context) return;
		if (context.used_tokens === this.said?.used_tokens && context.total_tokens === this.said.total_tokens) return;
		this.said = context;
		void this.report({ kind: 'context', context });
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

	private report(report: Extract<ActorSessionReport, { kind: 'message' }>): Promise<{ id: number }>;
	private report(report: ActorSessionReport): Promise<unknown>;
	private report(report: ActorSessionReport): Promise<unknown> {
		return this.context.client.report(this.id, report).catch((error: Error) => {
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
