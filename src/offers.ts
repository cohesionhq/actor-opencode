// The actors this client offers: one OpenCode per directory, each with the
// primary agents OpenCode has there as its modes, and the models it can run.

import type { AgentInfo, ModelInfo } from '@opencode/client';
import type { ActorEntry } from 'cohesion-agent-kit';
import type { ActorDefinition, ActorMode, ActorModel } from 'cohesion-ts';

import type { OpenCodeHost } from './engine.ts';

export const PRODUCT = 'OpenCode';

/** OpenCode's default agent, offered first when there. */
export const DEFAULT_AGENT = 'build';

const EFFORT_TITLES: Record<string, string> = {
	none: 'None',
	minimal: 'Minimal',
	low: 'Low',
	medium: 'Medium',
	high: 'High',
	xhigh: 'Extra high',
	max: 'Max',
};

/** What each actor offers, as OpenCode has it in the actor's directory (its project may add agents or providers). */
export async function actorDefinitions(opencode: OpenCodeHost, actors: ActorEntry[], log: (message: string) => void): Promise<ActorDefinition[]> {
	return Promise.all(
		actors.map(async ({ identifier, directory }) => {
			const location = { directory };
			const [agents, models, preferred] = await Promise.all([
				opencode.agent.list({ location }).then((list) => list.data),
				opencode.model.list({ location, types: ['chat'] }).then((list) => list.data),
				opencode.model.default({ location }).then((found) => found.data).catch(() => null),
			]).catch((error: Error) => {
				log(`Couldn't read OpenCode's agents and models in ${directory}, so ${identifier} runs on its defaults: ${error.message}`);
				return [[], [], null] as const;
			});
			return { identifier, product: PRODUCT, scope: directory, modes: modes(agents), models: actorModels(models, preferred) };
		}),
	);
}

/** The agents the user can run a session as, the default first. Subagents and OpenCode's own (title, compaction) aren't. */
export function modes(agents: readonly AgentInfo[]): ActorMode[] {
	const primary = agents.filter((agent) => agent.mode !== 'subagent' && !agent.hidden);
	primary.sort((a, b) => Number(b.id === DEFAULT_AGENT) - Number(a.id === DEFAULT_AGENT));
	return primary.map((agent) => ({ identifier: agent.id, title: agent.name, description: agent.description ?? null }));
}

/** The enabled models, OpenCode's default for the directory first, each with its variants as efforts. */
export function actorModels(models: readonly ModelInfo[], preferred: ModelInfo | null): ActorModel[] {
	const enabled = models.filter((model) => model.enabled && model.status !== 'deprecated');
	const key = (model: { providerID: string; id: string }) => modelIdentifier(model);
	if (preferred) enabled.sort((a, b) => Number(key(b) === key(preferred)) - Number(key(a) === key(preferred)));
	return enabled.map((model) => ({
		identifier: key(model),
		title: model.name,
		efforts: model.variants.map((variant) => ({ identifier: variant.id, title: EFFORT_TITLES[variant.id] ?? variant.id })),
	}));
}

/** A model as this client names it to Cohesion: `<provider>/<model>`. */
export function modelIdentifier(model: { providerID: string; id: string }): string {
	return `${model.providerID}/${model.id}`;
}

/** The model a Cohesion identifier names, with its variant, as OpenCode takes it. */
export function modelRef(identifier: string | null, effort: string | null): { providerID: string; id: string; variant?: string } | null {
	if (!identifier) return null;
	const slash = identifier.indexOf('/');
	if (slash <= 0) return null;
	return { providerID: identifier.slice(0, slash), id: identifier.slice(slash + 1), ...(effort ? { variant: effort } : {}) };
}
