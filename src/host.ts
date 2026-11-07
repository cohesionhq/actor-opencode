// What the kit's `SessionHost` needs to know of OpenCode: the record an actor
// session keeps, the agents it can run as, and how to run one. What each actor
// offers and its models' context windows are kept here, read as OpenCode has
// them in the actor's directory.

import type { OpenCodeEvent } from '@opencode/client';
import type { ActorDefinition, ClientCapabilities, Config, SessionEngine, SessionHost, SessionStore } from 'cohesion-agent-kit';

import type { Events, OpenCodeHost } from './engine.ts';
import { actorDefinitions, DEFAULT_AGENT, modelIdentifier } from './offers.ts';
import { ActorSession, type SessionRecord } from './session.ts';
import { displayName } from './translate.ts';

export interface OpenCodeEngine extends SessionEngine<SessionRecord> {
	/** What to offer for `config`, as OpenCode has it now; the engine goes by this from then on. */
	offers(config: Config): Promise<ClientCapabilities>;
}

export function openCodeEngine(opencode: OpenCodeHost, store: SessionStore<SessionRecord>, events: Events, log: (message: string) => void): OpenCodeEngine {
	/** What each actor offers, by its identifier, as last offered. */
	let offered = new Map<string, ActorDefinition>();
	/** Each directory's models' context windows, by `<provider>/<model>`. */
	const windows = new Map<string, Promise<Map<string, number>>>();

	const modesOf = (actor: string) => offered.get(actor)?.modes ?? [];

	/** An agent cohesiond names, or the actor's default when it names none it offers. */
	const agent = (actor: string, identifier: string | null): string => {
		const modes = modesOf(actor);
		return modes.find((mode) => mode.identifier === identifier)?.identifier ?? modes[0]?.identifier ?? DEFAULT_AGENT;
	};

	/** How many tokens `model` holds in its context, as OpenCode lists it in `directory`. */
	const contextLimit = async (directory: string, model: { providerID: string; id: string }): Promise<number | null> => {
		let known = windows.get(directory);
		if (!known) {
			known = opencode.model
				.list({ location: { directory } })
				.then((list) => new Map(list.data.map((info) => [modelIdentifier(info), info.limit.context])));
			windows.set(directory, known);
			known.catch(() => windows.delete(directory));
		}
		return (await known.catch(() => null))?.get(modelIdentifier(model)) ?? null;
	};

	return {
		speaker: 'Assistant',
		agentSession: 'an OpenCode session',
		toolName: displayName,
		offers: async (config) => {
			const actors = await actorDefinitions(opencode, config.actors, log);
			offered = new Map(actors.map((actor) => [actor.identifier, actor]));
			// A directory's config may have changed what its models are.
			windows.clear();
			return { actors };
		},
		start: (actor, call) => ({
			actor: actor.identifier,
			session_id: null,
			agent: agent(actor.identifier, call.mode),
			model: call.model,
			effort: call.effort,
			...(call.title ? { titled: 'given' as const, title: call.title } : { titled: 'pending' as const }),
		}),
		recover: (actor, held) => ({
			actor: actor.identifier,
			session_id: null,
			agent: agent(actor.identifier, held.mode),
			model: held.model,
			effort: held.effort,
			// OpenCode's title would describe the transcript it is handed, not the actor session.
			titled: 'given',
			title: held.title,
		}),
		checkMode: (actor, identifier) => {
			if (!modesOf(actor.identifier).some((mode) => mode.identifier === identifier)) throw new Error(`OpenCode has no agent ${identifier} here.`);
			return identifier;
		},
		withMode: (record, mode) => ({ ...record, agent: mode }),
		open: (id, record, actor, client) =>
			new ActorSession(id, record, {
				client,
				store,
				opencode,
				events,
				cwd: actor.directory,
				contextLimit: (model) => contextLimit(actor.directory, model),
				log,
			}),
	};
}

/**
 * An event for a session no running actor session listens to: one OpenCode took
 * up again after a restart, say. Its actor session is picked up from disk, and
 * hears it.
 */
export function adoptOrphan(host: SessionHost<SessionRecord>, store: SessionStore<SessionRecord>, sessionId: string, event: OpenCodeEvent): void {
	const kept = store.find((record) => record.session_id === sessionId);
	if (!kept) return;
	// This client's engine opens nothing else.
	(host.adopt(kept.sessionId) as ActorSession | undefined)?.take(event, false);
}
