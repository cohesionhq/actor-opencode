# actor-opencode

Offers [OpenCode](https://opencode.ai) to Cohesion as actors, one per
directory, and runs the actor sessions Cohesion hands them in an OpenCode embedded in
this process through the [OpenCode SDK](https://opencode.ai/v2/docs/build/sdk/)
(`@opencode/sdk`): no `opencode` binary, no HTTP listener. Each actor session is one
OpenCode session in its directory: what the user says in Cohesion goes in as
the session's prompts, and OpenCode's words, tool uses, questions and
permission prompts come back as the actor session's transcript, with its status and
progress. See `docs/actors.md` in cohesion for the protocol; this client
speaks it through [cohesion-ts](https://github.com/cohesionhq/ts), and its command line,
configuration and call routing are
[cohesion-agent-kit](https://github.com/cohesionhq/actor-kit)'s.

It runs on Bun, as the user who runs it, with that user's OpenCode
configuration, credentials and session store, as `opencode` itself would.

## Set up

```sh
bun install
# On the machine running cohesiond (its socket, or the default one):
bun index.ts setup --local /tmp/cohesion.sock --name "My laptop"
# Or from another device, with a code from `cohesion pair`:
bun index.ts setup <setup-code> --name "My laptop"

bun index.ts add ~/src/website  # offered as "website"
bun index.ts add ~/src/api-server --as api
bun index.ts run
```

The configuration lives in `~/.config/actor-opencode` (or `--config <dir>`,
or `$COHESION_ACTOR_OPENCODE_CONFIG`): `config.json` holds how to reach cohesiond,
the client's key, and the directories offered, readable only by its owner;
`sessions.json` maps each Cohesion actor session to its OpenCode session. `add` and
`remove` take effect on a running client at once.

## What each actor offers

As OpenCode has them in the actor's directory (a project's config may add
agents or providers), read at startup and whenever the configuration changes:

- **Modes**, OpenCode's primary agents the user can pick: Build first
  (OpenCode's default), then Plan and any the user defined. Subagents and
  OpenCode's own hidden agents (title, compaction, summary) aren't offered.
- **Models**, the enabled chat models of the providers OpenCode is connected
  to, OpenCode's default for the directory first, each as
  `<provider>/<model>`, with the model's variants as its efforts.

## How an actor session runs

- **Start**: a new OpenCode session in the actor's directory, as the actor session's
  agent, on its model and variant, and titled with its title when Cohesion
  gave one. A session that can't be made (a model OpenCode doesn't have)
  fails the call.
- **Messages**: go in as prompts to the session; one sent mid-turn joins it
  (OpenCode's `steer` delivery). OpenCode keeps its sessions itself, so a
  restart of this client carries on in the same session, and an event for a
  session OpenCode takes up again after a restart picks its actor session up. An actor session
  this client has no record of starts a new session from Cohesion's
  transcript.
- **Requests**: an OpenCode permission prompt becomes a `permission`
  request: a `command` for `shell`, a `fileChange` with OpenCode's own
  unified diffs for `edit` (which `write` and `patch` ask as), or any other
  `tool`. A form, such as the `question` tool's, becomes a `question`, its
  answers going back by field, an option by its value. A subagent's prompts
  are in its own transcript (below), and answered in its own session.
  The actor session needs attention until the user responds, or until the request is
  answered elsewhere (in OpenCode's own UI, or by a rule). Allow for session
  adds OpenCode's suggested rules (`save`) to the session's own permissions,
  and its parent's, never as a saved project rule as OpenCode's "always"
  does. Deny passes on the user's words; abort denies and stops the turn.
  Words said while requests wait deny them (or dismiss a form) with the
  words as why.
- **Instructions**: OpenCode's own, plus a session instruction entry
  (`cohesion.diagrams`, `src/instructions.ts`) saying Cohesion renders
  `mermaid` code blocks as diagrams.
- **Images**: the user's go in with what they said as inline attachments.
  Those a tool gives back as `data:` URIs (an image `read`, an MCP tool's
  screenshot) come back under the tool use, reported once its result is in;
  one cohesiond would refuse is left out, with a note in the transcript.
- **Tool times**: each tool use is reported as OpenCode calls it and ended
  (`end`) once its result is in, failed or not. One reported only once
  its result is in (for its images) ends as it is shown.
- **Subagents**: a child session (`session.created` with a `parentID`) is a
  subagent, launched to Cohesion by OpenCode's id for the session, before
  anything else about it: `title` the `subagent` call's description (else the
  session's title), `agent_type` the call's `subagent_type` (else the session's
  agent), `model` the session's, `background` the call's `background`,
  `message_id` the Cohesion message of the `subagent` tool call that made it
  (OpenCode doesn't say which call; the oldest unmatched one in that
  transcript is taken), and `parent` the subagent whose session it was made in,
  or none. Its whole stream (thinking, text, tool uses with their `end`s, steps'
  context, its title, `execution.*`) goes in its own transcript, addressed with
  `subagent`: `started` is working, `succeeded` and `interrupted` idle ("Done"),
  `failed` failed; the session's own status and progress are untouched. Its
  permissions and forms are requests in its transcript, marking it
  `needsAttention`; the user's response arrives as `sendActorSessionMessage` with
  `subagent` and is answered in the child session. A session OpenCode events
  name that this process never saw made (after a restart) is asked of OpenCode
  (`sessions.get`, up through its parents) and launched from that, with no
  `message_id`. Stopping the session leaves working subagents idle; after a
  reconnect every one still known is launched again.

- **Tool categories**: `command` (`shell`), `read` (`read`), `edit`
  (`edit`, `write`, `patch`), `search` (`grep`, `glob`), `web` (`webfetch`,
  `websearch`), `agent` (`subagent`), `skill` (`skill`), and `other` for the
  rest (`todowrite`, MCP and plugin tools). OpenCode's tools show by their
  usual names ("WebFetch"), any other with its underscores as spaces.
- **Mode**: switching it switches the session's agent from its next step.
- **Status**: working while an execution runs, idle when it succeeds, or
  is interrupted from elsewhere, failed with OpenCode's error when it fails
  (a provider error, say; not when tests it ran fail). Stop interrupts the
  session and dismisses its waiting requests. A provider retry shows as the
  actor session's progress.
- **Title**: an actor session Cohesion titled with its prompt's first line takes
  OpenCode's own title for the session once OpenCode names it, and again on
  each rename. An actor session started with a title keeps it.
- **Away from cohesiond**: the session keeps working; its updates are held
  and sent in order once it reconnects, after reporting each running actor session's
  status.

## Usage

- **Context**: an actor session's own, as a `context` report after each step: the
  step's tokens (input, cached, output and reasoning) against the model's
  context window as OpenCode lists it.
- **Plan**: none yet; OpenCode's own usage limits (an experimental API) aren't
  reported.

## Checks

```sh
bun run check
bun test
```

CI (`.github/workflows/test.yml`) runs both on every push to `master`,
against the commits of cohesion-ts and cohesion-agent-kit that `bun.lock`
pins.

## Licence

Copyright (c) 2026 Jackson Zamorano.

Licensed under the MIT License. See [`LICENSE`](LICENSE).
