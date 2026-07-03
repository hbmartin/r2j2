interface JournalEntry {
	timestamp: number;
	text: string;
}

const DEFAULT_ENTRIES_PREFIX = 'entries/';
const DEFAULT_LEGACY_JOURNAL_KEY = 'journal.txt';
// Unix timestamps padded to 12 digits sort lexicographically until year 33658.
const TIMESTAMP_PAD = 12;
// Number of R2 get() calls issued concurrently when reading entries back.
const READ_BATCH_SIZE = 50;

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		try {
			if (request.method !== 'GET') {
				return new Response('Method Not Allowed', { status: 405 });
			}

			const rateLimited = await isRateLimited(request, env);
			if (rateLimited) {
				return new Response('Too Many Requests', { status: 429 });
			}

			const url = new URL(request.url);
			if (!(await authenticate(request, url, env))) {
				return new Response('', { status: 401 });
			}

			switch (url.pathname) {
				case '/':
					return await handleAddEntry(url, env);
				case '/csv':
					return await handleCsv(url, env);
				case '/count':
					return await handleCount(url, env);
				default:
					return new Response('Not Found', { status: 404 });
			}
		} catch (error) {
			console.error('Error processing request:', error);
			return new Response('Internal Server Error', { status: 500 });
		}
	},
} satisfies ExportedHandler<Env>;

async function isRateLimited(request: Request, env: Env): Promise<boolean> {
	if (!env.RATE_LIMITER) {
		return false;
	}
	const key = request.headers.get('cf-connecting-ip') ?? 'unknown';
	const { success } = await env.RATE_LIMITER.limit({ key });
	return !success;
}

async function authenticate(request: Request, url: URL, env: Env): Promise<boolean> {
	const password = passwordFromRequest(request, url);
	if (!password || !env.SECRET_PASSWORD) {
		return false;
	}
	// Hash both values so the comparison is constant-time and length-independent.
	const encoder = new TextEncoder();
	const [provided, expected] = await Promise.all([
		crypto.subtle.digest('SHA-256', encoder.encode(password)),
		crypto.subtle.digest('SHA-256', encoder.encode(env.SECRET_PASSWORD)),
	]);
	return crypto.subtle.timingSafeEqual(provided, expected);
}

function passwordFromRequest(request: Request, url: URL): string | null {
	const authorization = request.headers.get('Authorization');
	if (authorization !== null) {
		const bearer = /^Bearer\s+(.+)$/i.exec(authorization);
		return bearer?.[1] ?? authorization;
	}
	return request.headers.get('X-Journal-Password') ?? url.searchParams.get('password');
}

async function handleAddEntry(url: URL, env: Env): Promise<Response> {
	// searchParams.get() already URL-decodes; decoding again would corrupt
	// text containing literal `%` sequences.
	const text = url.searchParams.get('text');
	if (!text) {
		return new Response('', { status: 400 });
	}

	const timestamp = Math.floor(Date.now() / 1000);
	// One object per entry keeps writes atomic: concurrent requests can never
	// overwrite each other the way a read-modify-write of a single file could.
	const key = entryKey(env, timestamp);
	await env.JOURNAL_BUCKET.put(key, text);

	return Response.json({ timestamp });
}

async function handleCsv(url: URL, env: Env): Promise<Response> {
	const filters = parseFilters(url);
	if (filters === null) {
		return new Response('', { status: 400 });
	}

	const entries = await loadEntries(env, filters);
	const csv = entries.map((entry) => `${entry.timestamp},${escapeCsvField(entry.text)}\n`).join('');
	return new Response(csv, {
		status: 200,
		headers: { 'Content-Type': 'text/csv; charset=utf-8' },
	});
}

async function handleCount(url: URL, env: Env): Promise<Response> {
	const since = parseSince(url);
	if (since === null) {
		return new Response('', { status: 400 });
	}

	const [keys, legacy] = await Promise.all([listEntryKeys(env, since), loadLegacyEntries(env)]);
	const legacyCount = legacy.filter((entry) => since === undefined || entry.timestamp > since).length;
	return Response.json({ count: keys.length + legacyCount });
}

interface Filters {
	since?: number;
	limit?: number;
}

function parseFilters(url: URL): Filters | null {
	const since = parseSince(url);
	const limit = parseNonNegativeInt(url.searchParams.get('limit'));
	if (since === null || limit === null || limit === 0) {
		return null;
	}
	return { since, limit };
}

function parseSince(url: URL): number | undefined | null {
	return parseNonNegativeInt(url.searchParams.get('since'));
}

/** Returns undefined when absent, null when present but not a non-negative integer. */
function parseNonNegativeInt(value: string | null): number | undefined | null {
	if (value === null) {
		return undefined;
	}
	if (!/^\d+$/.test(value)) {
		return null;
	}
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed)) {
		return null;
	}
	return parsed;
}

async function loadEntries(env: Env, filters: Filters): Promise<JournalEntry[]> {
	const [keys, legacy] = await Promise.all([listEntryKeys(env, filters.since, filters.limit), loadLegacyEntries(env)]);

	// Merge timestamps first and apply the limit before fetching any bodies,
	// so a limited read costs at most `limit` R2 get() calls, not one per entry.
	interface PendingEntry {
		timestamp: number;
		text?: string;
		key?: string;
	}
	const merged: PendingEntry[] = [
		...legacy.filter((entry) => filters.since === undefined || entry.timestamp > filters.since),
		...keys.map((key) => ({ timestamp: key.timestamp, key: key.key })),
	];
	merged.sort((a, b) => a.timestamp - b.timestamp);
	const selected = filters.limit === undefined ? merged : merged.slice(0, filters.limit);

	const entries: JournalEntry[] = [];
	for (let i = 0; i < selected.length; i += READ_BATCH_SIZE) {
		const batch = await Promise.all(
			selected.slice(i, i + READ_BATCH_SIZE).map(async (pending) => {
				if (pending.key === undefined) {
					return { timestamp: pending.timestamp, text: pending.text ?? '' };
				}
				const object = await env.JOURNAL_BUCKET.get(pending.key);
				return object === null ? null : { timestamp: pending.timestamp, text: await object.text() };
			}),
		);
		entries.push(...batch.filter((entry) => entry !== null));
	}
	return entries;
}

interface EntryKey {
	key: string;
	timestamp: number;
}

async function listEntryKeys(env: Env, since?: number, keyLimit?: number): Promise<EntryKey[]> {
	const prefix = entriesPrefix(env);
	const keys: EntryKey[] = [];
	let cursor: string | undefined;
	do {
		const listed = await env.JOURNAL_BUCKET.list({
			prefix,
			cursor,
			limit: keyLimit === undefined ? undefined : Math.max(1, Math.min(1000, keyLimit - keys.length)),
			// Skip most already-seen keys server-side; the exact `> since`
			// comparison below handles entries within the same second.
			startAfter: cursor === undefined && since !== undefined ? prefix + padTimestamp(since) : undefined,
		});
		for (const object of listed.objects) {
			const timestamp = timestampFromKey(object.key, prefix);
			if (timestamp !== null && (since === undefined || timestamp > since)) {
				keys.push({ key: object.key, timestamp });
				if (keyLimit !== undefined && keys.length >= keyLimit) {
					return keys;
				}
			}
		}
		cursor = listed.truncated ? listed.cursor : undefined;
	} while (cursor !== undefined);
	return keys;
}

async function loadLegacyEntries(env: Env): Promise<JournalEntry[]> {
	const object = await env.JOURNAL_BUCKET.get(legacyJournalKey(env));
	if (object === null) {
		return [];
	}
	const content = await object.text();
	const entries: JournalEntry[] = [];
	for (const line of content.split('\n')) {
		if (line === '') {
			continue;
		}
		const separator = line.indexOf(',');
		const timestamp = separator === -1 ? Number.NaN : Number(line.slice(0, separator));
		if (Number.isInteger(timestamp)) {
			entries.push({ timestamp, text: line.slice(separator + 1) });
		} else {
			// Malformed legacy line: keep it visible rather than dropping data.
			entries.push({ timestamp: 0, text: line });
		}
	}
	return entries;
}

function entryKey(env: Env, timestamp: number): string {
	const suffix = crypto.randomUUID().slice(0, 8);
	return `${entriesPrefix(env)}${padTimestamp(timestamp)}-${suffix}`;
}

function timestampFromKey(key: string, prefix: string): number | null {
	const suffix = key.slice(prefix.length);
	const match = new RegExp(`^(\\d{${TIMESTAMP_PAD}})-[0-9a-f]{8}$`).exec(suffix);
	if (match === null) {
		return null;
	}
	return Number(match[1]);
}

function padTimestamp(timestamp: number): string {
	return String(timestamp).padStart(TIMESTAMP_PAD, '0');
}

function escapeCsvField(text: string): string {
	// RFC 4180: quote fields containing commas, quotes, or line breaks.
	if (/[",\r\n]/.test(text)) {
		return `"${text.replaceAll('"', '""')}"`;
	}
	return text;
}

function entriesPrefix(env: Env): string {
	return env.ENTRIES_PREFIX || DEFAULT_ENTRIES_PREFIX;
}

function legacyJournalKey(env: Env): string {
	return env.LEGACY_JOURNAL_KEY || DEFAULT_LEGACY_JOURNAL_KEY;
}
