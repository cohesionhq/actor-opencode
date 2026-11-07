import { expect, test } from 'bun:test';

import type { AgentInfo, ModelInfo } from '@opencode/client';

import { actorModels, modelRef, modes } from '../src/offers.ts';

const agent = (id: string, mode: AgentInfo['mode'], hidden = false) => ({ id, name: id.toUpperCase(), mode, hidden, description: `${id}!` }) as AgentInfo;
const model = (id: string, variants: string[], enabled = true) =>
	({ id, providerID: 'p', name: id, enabled, status: 'active', variants: variants.map((id) => ({ id })) }) as unknown as ModelInfo;

test("the modes are the primary agents the user can pick, build first; subagents and OpenCode's own aren't", () => {
	const offered = modes([agent('plan', 'primary'), agent('general', 'subagent'), agent('title', 'primary', true), agent('build', 'primary'), agent('mine', 'all')]);
	expect(offered.map((mode) => mode.identifier)).toEqual(['build', 'plan', 'mine']);
});

test("the models are the enabled ones, OpenCode's default first, each variant an effort", () => {
	const offered = actorModels([model('a', []), model('off', [], false), model('b', ['low', 'xhigh'])], model('b', []));
	expect(offered).toEqual([
		{ identifier: 'p/b', title: 'b', efforts: [{ identifier: 'low', title: 'Low' }, { identifier: 'xhigh', title: 'Extra high' }] },
		{ identifier: 'p/a', title: 'a', efforts: [] },
	]);
});

test('a model identifier names its provider and model, which may hold slashes', () => {
	expect(modelRef('openrouter/anthropic/claude', 'high')).toEqual({ providerID: 'openrouter', id: 'anthropic/claude', variant: 'high' });
	expect(modelRef(null, 'high')).toBeNull();
});
