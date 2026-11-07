# CLAUDE.md

`actor-opencode`: a Cohesion actor client that runs OpenCode, embedded
through `@opencode/sdk`, on Bun. Read `README.md`, then `ARCHITECTURE.md`,
then `docs/actors.md` in cohesion (`../cohesion`), which this implements. It
talks to cohesiond only through `cohesion-ts` (cohesionhq/ts); protocol
work belongs there. What every actor client shares (CLI, config, call
routing, run loop) is `cohesion-agent-kit` (cohesionhq/actor-kit).
`../actor-agentsdk` is its sibling for Claude Code: match its
conventions and voice.

- Follow `docs/actors.md` for every status rule: `idle` at the end of each
  turn, `failed` only when OpenCode itself failed, and nothing cohesiond
  already sets itself.
- Never save permission rules for the project (OpenCode's `always`) on the
  user's behalf; allow-for-session adds rules to the session only.
- OpenCode's API types come from `@opencode/client`'s generated
  `types.d.ts`; read them there rather than guessing event shapes.
- `bun run check` and `bun test` must pass before a change is done. Tests
  drive an `ActorSession` with OpenCode events through `test/fake_session.ts`.
- Style: tabs, single quotes, short prose comments that say what a thing is.

## Commits

Commits must NOT include a `Co-Authored-By` (co-author) trailer.
