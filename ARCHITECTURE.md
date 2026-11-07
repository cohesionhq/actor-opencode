# Architecture

How this client is put together. What it does is in `README.md`, and the
protocol it implements is `docs/actors.md` in cohesion (`../cohesion`). It is
built like `../actor-agentsdk`; where the two differ, it is because
OpenCode is embedded and event-driven where Claude Code is a process per
session.

## Shape

One process (`bun index.ts run`) is one paired Cohesion client running one
embedded OpenCode (`OpenCode.create()` from `@opencode/sdk`, in memory). It
offers one actor per configured directory and runs one `ActorSession` per Cohesion
actor session, each one OpenCode session. OpenCode's single event stream is routed to
actor sessions by session:

```
cohesiond ⇄ cohesion-ts Client ⇄ SessionHost ─┬─ ActorSession 12 ─ session ses_a1… ┐
                                              └─ ActorSession 13 ─ session ses_c3… ┤
                                         Events (one subscription) ◀───────┴─ embedded OpenCode
```

Calls go to OpenCode directly (`sessions.prompt`, `permission.reply`, …);
what OpenCode does comes back only as events. `sessions.json` keeps the actor session →
session mapping; OpenCode keeps the sessions.

The parts every actor client shares come from `cohesion-agent-kit`: the CLI
(`runCli`), the run loop and config watch (`ActorService`), call routing
(`SessionHost`), `config.json` and `sessions.json`. This repo is what is
particular to OpenCode, behind the kit's `SessionEngine` and `SessionRunner`.

## Modules

| File | Role |
| --- | --- |
| `index.ts` | The kit's `runCli`, with `run` starting OpenCode and `Events` around a `SessionHost` and an `ActorService`, and stopping them once it ends. |
| `src/engine.ts` | `startOpenCode`, and `Events`: one filtered subscription (`EVENT_TYPES`), resubscribed should it end, routing each event to the actor session of its session's root (subagents run in child sessions, learnt from `session.created`), or to `adoptOrphan`. |
| `src/host.ts` | `openCodeEngine`, the kit's `SessionEngine`: the `SessionRecord` for an actor session started or picked up from Cohesion's transcript, the agents (checked against what `offers` last read), the `ActorSession` to run it, and models' context windows. `SessionHost` answers cohesiond's four calls with it. `adoptOrphan` picks up an actor session OpenCode's events wake, with `SessionStore.find` and `SessionHost.adopt`. |
| `src/session.ts` | `SessionRecord`, and `ActorSession`, the kit's `SessionRunner`: one session. `say`/`hear`/`stop`/`setMode` call OpenCode; `take` queues events, which `handle` turns into reports (messages, `end`, status, progress, context, title) in order; `ask`/`answer` track the requests waiting on the user. |
| `src/translate.ts` | Pure functions between OpenCode's tools, permissions and forms and Cohesion's transcript kinds: `toolUse`, `category`, `displayName`, `progress`, `permissionRequest`, `formQuestions`, `formAnswer`. |
| `src/offers.ts` | Modes (primary agents) and models (with variants) each actor offers, and `<provider>/<model>` identifiers. |
| `src/images.ts` | Image conversion both ways (`imagesIn`, `attachments`); the limits are the kit's `sendable`. |
| `src/instructions.ts` | The instruction entry added to each new session (mermaid diagrams). |

## Flows

- **In**: cohesiond call → `SessionHost.onCall` → `ActorSession.say` / `hear` →
  `sessions.prompt` (or `permission.reply`, `sessions.form.reply`/`cancel`).
- **Out**: OpenCode event → `Events.route` → `ActorSession.take` (queued) →
  `ActorSession.handle` → `translate` → `ActorSession.report` → `Client`.
- **Requests**: `permission.asked` / `form.created` → a request message, and
  `needsAttention` → the user's response through `hear` → `answer` → OpenCode;
  `permission.replied` / `form.replied` / `form.cancelled` clear it however
  it was answered.
- **Status**: `session.execution.started` → `working`; `.succeeded` → `idle`;
  `.failed` → `failed` with its error; `.interrupted` → `idle`, or nothing
  when Cohesion stopped it (it set `idle` itself) or a newer turn superseded
  it. Rules: `docs/actors.md` "Statuses".

## Dependencies

- `cohesion-ts` (`github:cohesionhq/ts`) owns the protocol.
- `cohesion-agent-kit` (`github:cohesionhq/actor-kit`) owns what actor clients
  share, on top of cohesion-ts. What `actor-agentsdk` needs too belongs
  there, not here.
- Both come from GitHub at the commits `bun.lock` pins, with one copy of
  cohesion-ts for both. A change to either reaches this client once it's
  pushed and `bun update cohesion-agent-kit cohesion-ts` has run.
- `@opencode/sdk` embeds OpenCode; `@opencode/client` (same version) is
  imported for its generated types (`OpenCodeEvent`, `PermissionAsked`, …).
  Keep the two on one version.
