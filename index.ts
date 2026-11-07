#!/usr/bin/env bun
// actor-opencode: offers OpenCode, in the directories it is given, to
// cohesiond as actors, and runs the actor sessions Cohesion hands them in an
// OpenCode embedded in this process. The command line and the run loop are
// cohesion-agent-kit's.

import { ActorService, loadConfig, runCli, SessionHost, SessionStore, stderrLog, type AppInfo } from 'cohesion-agent-kit';

import { Events, startOpenCode } from './src/engine.ts';
import { adoptOrphan, openCodeEngine } from './src/host.ts';
import { PRODUCT } from './src/offers.ts';
import type { SessionRecord } from './src/session.ts';

const app: AppInfo = { name: 'actor-opencode', product: PRODUCT };

process.exit(await runCli({ app, run }));

async function run(directory: string): Promise<void> {
	const log = stderrLog();
	const config = loadConfig(app, directory);
	const opencode = await startOpenCode();
	const store = new SessionStore<SessionRecord>(directory);
	const events = new Events(opencode, (sessionId, event) => adoptOrphan(host, store, sessionId, event), log);
	const engine = openCodeEngine(opencode, store, events, log);
	const host = new SessionHost(config.actors, engine, store, log);
	const service = await ActorService.create({ app, directory, config, host, offers: engine.offers, log });
	const reading = events.run();
	await service.run();
	events.stop();
	await reading;
	await opencode.close();
}
