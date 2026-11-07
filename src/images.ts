// Images between OpenCode and Cohesion: the user's go in as inline file
// attachments (data URIs), and the ones a tool gives back (an image it read,
// a screenshot an MCP tool took) come back with the transcript message they
// belong to, checked with the kit's `sendable` against the rules cohesiond
// refuses a message for.

import type { ClientImage } from 'cohesion-agent-kit';

/**
 * The images among a tool's result, as Cohesion takes them: each `file`
 * part whose type is an image and whose URI is a base64 `data:` URI. One
 * named by any other URI is skipped: there is nothing here to fetch it.
 */
export function imagesIn(content: unknown): ClientImage[] {
	if (!Array.isArray(content)) return [];
	return content.flatMap((part): ClientImage[] => {
		if (part?.type !== 'file' || typeof part.uri !== 'string') return [];
		const image = fromDataUri(part.uri, typeof part.mime === 'string' ? part.mime : undefined);
		return image ? [image] : [];
	});
}

/** A base64 `data:` URI as an image, or null when it isn't one. */
export function fromDataUri(uri: string, mime?: string): ClientImage | null {
	const match = /^data:([^;,]*)(?:;[^,]*)?;base64,(.*)$/s.exec(uri);
	if (!match) return null;
	const media_type = (mime || match[1] || '').toLowerCase();
	return media_type.startsWith('image/') ? { media_type, data: match[2]! } : null;
}

/** The user's images, as the inline files an OpenCode prompt takes. */
export function attachments(images: ClientImage[]): { uri: string; name: string; source: { type: 'inline' } }[] {
	return images.map((image, index) => ({
		uri: `data:${image.media_type};base64,${image.data}`,
		name: `image-${index + 1}.${image.media_type.split('/')[1] ?? 'png'}`,
		source: { type: 'inline' },
	}));
}

/** Whether a `read` of `path` gives OpenCode an image. */
export function readsImage(path: string): boolean {
	return /\.(png|jpe?g|gif|webp)$/i.test(path);
}
