// What this client adds to OpenCode's own instructions: what Cohesion can
// show that OpenCode would not know of.

/** The key the note is kept under among a session's instruction entries. */
export const INSTRUCTIONS_KEY = 'cohesion.diagrams';

export const COHESION_INSTRUCTIONS = `You are running as an actor session in Cohesion. Cohesion renders a fenced code block whose info string is \`mermaid\` as a diagram, in the actor session's transcript on web and iOS; a diagram that fails to parse falls back to a plain code block. When a diagram would help explain a flow, architecture, sequence or state in a reply or report, send one this way. Keep it small and simple (flowchart-style is the safest). Otherwise use plain text.`;
