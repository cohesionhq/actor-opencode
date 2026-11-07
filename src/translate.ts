// Between OpenCode's tools and Cohesion's transcript: what a tool use shows
// as, the request a permission or form becomes, and what the user's
// response tells OpenCode.

import { isAbsolute, relative, resolve } from 'node:path';

import type { FormField1, FormInfo1, PermissionAsked, SessionFormReplyInput } from '@opencode/client';
import type {
	ActorAnswer,
	ActorFileChange,
	ActorPermissionDecision,
	ActorPermissionSubject,
	ActorQuestion,
	ActorSaidContent,
	ActorToolKind,
} from 'cohesion-ts';

type Input = Record<string, unknown>;
export type PermissionRequest = PermissionAsked['data'];
export type FormAnswer = SessionFormReplyInput['answer'];

/** The tool that asks the user questions, as a form; the form is the request, not the tool use. */
export const QUESTION_TOOL = 'question';

const string = (value: unknown): string | null => (typeof value === 'string' ? value : null);

/** A tool use as the transcript shows it: the tool, its kind, and what it did in a line. */
export function toolUse(name: string, input: Input, cwd: string): Extract<ActorSaidContent, { kind: 'toolUse' }> {
	return { kind: 'toolUse', tool: displayName(name), category: category(name), summary: summary(name, input, cwd) };
}

const CATEGORIES: Record<string, ActorToolKind> = {
	shell: 'command',
	read: 'read',
	edit: 'edit',
	write: 'edit',
	patch: 'edit',
	grep: 'search',
	glob: 'search',
	webfetch: 'web',
	websearch: 'web',
	subagent: 'agent',
	skill: 'skill',
};

/** What kind of tool `name` is, for the icon Cohesion shows; any name not known here is `other`. */
export function category(name: string): ActorToolKind {
	return Object.hasOwn(CATEGORIES, name) ? CATEGORIES[name]! : 'other';
}

const NAMES: Record<string, string> = {
	shell: 'Shell',
	read: 'Read',
	edit: 'Edit',
	write: 'Write',
	patch: 'Patch',
	grep: 'Grep',
	glob: 'Glob',
	webfetch: 'WebFetch',
	websearch: 'WebSearch',
	subagent: 'Subagent',
	skill: 'Skill',
	todowrite: 'TodoWrite',
	question: 'Question',
	experimental_image_generate: 'Generate image',
};

/**
 * Tool `name` as the user reads it: OpenCode's own tools by their usual
 * names, and any other (an MCP tool, a plugin's) with its underscores as
 * spaces, `github_search_issues` as "Github search issues". Only for
 * showing; OpenCode still knows the tool by `name`.
 */
export function displayName(name: string): string {
	if (Object.hasOwn(NAMES, name)) return NAMES[name]!;
	const words = name.replace(/[_\-\s]+/g, ' ').trim();
	return words ? words[0]!.toUpperCase() + words.slice(1) : name;
}

function summary(name: string, input: Input, cwd: string): string {
	const path = string(input.path);
	switch (name) {
		case 'shell':
			return line(string(input.command) ?? '');
		case 'read':
		case 'edit':
		case 'write':
			return path ? shown(path, cwd) : '';
		case 'patch':
			return line(patchedFiles(string(input.patchText) ?? '').map((file) => shown(file, cwd)).join(', '));
		case 'grep':
		case 'glob':
			return line(string(input.pattern) ?? '');
		case 'webfetch':
			return string(input.url) ?? '';
		case 'websearch':
			return string(input.query) ?? '';
		case 'subagent':
			return string(input.description) ?? '';
		case 'skill':
			return string(input.id) ?? '';
		case 'todowrite': {
			const todos = Array.isArray(input.todos) ? input.todos.length : 0;
			return todos === 1 ? '1 todo' : `${todos} todos`;
		}
		default:
			return line(Object.values(input).find((value) => typeof value === 'string') ?? '');
	}
}

/** The files a `patch` tool's patch text adds, updates or deletes, in its order. */
export function patchedFiles(patch: string): string[] {
	return [...patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)].map((match) => match[1]!.trim());
}

/** What the actor is doing while a tool runs, for the actor session's activity. */
export function progress(name: string, input: Input, cwd: string): string {
	const about = summary(name, input, cwd);
	const verb: Record<string, string> = {
		shell: 'Running',
		read: 'Reading',
		edit: 'Editing',
		write: 'Writing',
		patch: 'Editing',
		grep: 'Searching for',
		glob: 'Looking for',
		webfetch: 'Reading',
		websearch: 'Searching the web for',
		skill: 'Running skill',
	};
	if (name === 'subagent') return about || 'Working with a subagent';
	return verb[name] && about ? `${verb[name]} ${about}` : `Using ${displayName(name)}`;
}

/** Permission actions that aren't one tool's, by what they ask. */
const ACTIONS: Record<string, string> = {
	external_directory: 'Work outside the directory',
	subagent: 'Subagent',
	question: 'Question',
};

/**
 * The request OpenCode's permission `asked` becomes. `use` is the tool use
 * that asked, when this client saw it start: its name and input.
 */
export function permissionRequest(asked: PermissionRequest, use: { name: string; input: Input } | null, cwd: string): ActorSaidContent {
	const decisions: ActorPermissionDecision[] = ['allow'];
	if (asked.save?.length) decisions.push('allowForSession');
	decisions.push('deny', 'abort');
	return { kind: 'permission', subject: subject(asked, use, cwd), reason: asked.message ?? null, decisions };
}

function subject(asked: PermissionRequest, use: { name: string; input: Input } | null, cwd: string): ActorPermissionSubject {
	switch (asked.action) {
		case 'shell': {
			const workdir = string(use?.input.workdir);
			return {
				kind: 'command',
				command: string(use?.input.command) ?? asked.resources.join('\n'),
				cwd: workdir ? resolve(cwd, workdir) : cwd,
			};
		}
		case 'edit': {
			const changes = fileChanges(asked.metadata?.files, cwd);
			if (changes.length) return { kind: 'fileChange', changes };
			return { kind: 'fileChange', changes: asked.resources.map((path) => ({ path: shown(path, cwd), change: 'update', diff: null })) };
		}
	}
	if (use && use.name === asked.action) return { kind: 'tool', name: displayName(use.name), input: use.input };
	return { kind: 'tool', name: ACTIONS[asked.action] ?? displayName(asked.action), input: { resources: asked.resources } };
}

/** The files an edit permission's metadata says it changes, as OpenCode's `FileDiff`s. */
function fileChanges(files: unknown, cwd: string): ActorFileChange[] {
	if (!Array.isArray(files)) return [];
	return files.flatMap((file): ActorFileChange[] => {
		const path = string(file?.file);
		if (!path) return [];
		const change = file.status === 'added' ? 'add' : file.status === 'deleted' ? 'delete' : 'update';
		return [{ path: shown(path, cwd), change, diff: string(file.patch) }];
	});
}

/** The fields of `form` the user is asked, in its order: hidden ones aren't. */
function asked(form: FormInfo1): FormField1[] {
	return form.fields.filter((field) => !('hidden' in field && field.hidden));
}

/**
 * The questions OpenCode's `form` asks, such as its `question` tool's: one
 * per field, a field with options offering them, a yes-or-no field offering
 * Yes and No, and any other answered in words.
 */
export function formQuestions(form: FormInfo1): ActorQuestion[] {
	return asked(form).map((field) => {
		const header = field.title ?? null;
		const question = [field.description ?? field.title ?? form.title, field.type === 'external' ? field.url : null].filter(Boolean).join('\n\n');
		switch (field.type) {
			case 'string':
			case 'multiselect': {
				const options = (field.options ?? []).map((option) => ({ label: option.label, description: option.description ?? null }));
				return {
					header,
					question,
					options,
					multi_select: field.type === 'multiselect',
					// A field with no options is answered in words; OpenCode says whether one with them may be.
					allows_other: options.length === 0 || field.custom !== false,
				};
			}
			case 'boolean':
				return { header, question, options: [{ label: 'Yes', description: null }, { label: 'No', description: null }], multi_select: false, allows_other: false };
			default:
				return { header, question, options: [], multi_select: false, allows_other: true };
		}
	});
}

/** The user's `answers` to `form`, as OpenCode takes them: by field key, an option's value for its label. */
export function formAnswer(form: FormInfo1, answers: ActorAnswer[]): FormAnswer {
	const answer: Record<string, string | number | boolean | string[]> = {};
	asked(form).forEach((field, index) => {
		const given = answers[index];
		if (!given) return;
		const options = 'options' in field ? (field.options ?? []) : [];
		const picked = given.selected.map((label) => options.find((option) => option.label === label)?.value ?? label);
		if (given.other?.trim()) picked.push(given.other.trim());
		if (picked.length === 0) return;
		switch (field.type) {
			case 'multiselect':
				answer[field.key] = picked;
				return;
			case 'boolean':
				answer[field.key] = picked[0] === 'Yes' || /^(y|yes|true)$/i.test(picked[0]!);
				return;
			case 'number':
			case 'integer': {
				const number = Number(picked[0]);
				answer[field.key] = Number.isFinite(number) ? number : picked[0]!;
				return;
			}
			default:
				answer[field.key] = picked.join(', ');
		}
	});
	return answer;
}

/** `path` relative to the actor's directory when it is inside it. */
export function shown(path: string, cwd: string): string {
	if (!isAbsolute(path)) return path;
	const inside = relative(cwd, path);
	return !inside.startsWith('..') && !isAbsolute(inside) ? inside || '.' : path;
}

function line(text: string): string {
	const first = text.split('\n')[0] ?? '';
	return first.length > 200 ? `${first.slice(0, 199)}…` : first;
}
