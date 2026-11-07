import { expect, test } from 'bun:test';

import { category, displayName, patchedFiles, progress, toolUse } from '../src/translate.ts';

test("OpenCode's tools show by their usual names, any other with its underscores as spaces", () => {
	expect(displayName('webfetch')).toBe('WebFetch');
	expect(displayName('todowrite')).toBe('TodoWrite');
	expect(displayName('github_search_issues')).toBe('Github search issues');
});

test('each tool has the category for what it does', () => {
	expect(['shell', 'read', 'edit', 'write', 'patch', 'grep', 'glob', 'webfetch', 'websearch', 'subagent', 'skill', 'todowrite', 'github_x'].map(category)).toEqual([
		'command', 'read', 'edit', 'edit', 'edit', 'search', 'search', 'web', 'web', 'agent', 'skill', 'other', 'other',
	]);
});

test('a patch shows the files it touches, relative to the directory', () => {
	const patch = '*** Begin Patch\n*** Update File: /src/a.ts\n@@\n-x\n+y\n*** Add File: b.ts\n+z\n*** End Patch';
	expect(patchedFiles(patch)).toEqual(['/src/a.ts', 'b.ts']);
	expect(toolUse('patch', { patchText: patch }, '/src').summary).toBe('a.ts, b.ts');
});

test('progress says what a tool is doing', () => {
	expect(progress('read', { path: '/src/a.ts' }, '/src')).toBe('Reading a.ts');
	expect(progress('subagent', { description: 'Find the bug' }, '/src')).toBe('Find the bug');
	expect(progress('todowrite', { todos: [] }, '/src')).toBe('Using TodoWrite');
});
