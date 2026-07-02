import { env, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import worker from '../src/index';

const PASSWORD = 'test-password';
const BASE = 'https://example.com';

// Required to get a correctly-typed `Request` to pass to `worker.fetch()`.
const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

function addUrl(text: string, password = PASSWORD): string {
	const url = new URL('/', BASE);
	url.searchParams.set('password', password);
	url.searchParams.set('text', text);
	return url.toString();
}

function csvUrl(params: Record<string, string> = {}): string {
	const url = new URL('/csv', BASE);
	url.searchParams.set('password', PASSWORD);
	for (const [key, value] of Object.entries(params)) {
		url.searchParams.set(key, value);
	}
	return url.toString();
}

async function addEntry(text: string): Promise<number> {
	const response = await SELF.fetch(addUrl(text));
	expect(response.status).toBe(200);
	const body = await response.json<{ timestamp: number }>();
	return body.timestamp;
}

async function readCsv(params: Record<string, string> = {}): Promise<string> {
	const response = await SELF.fetch(csvUrl(params));
	expect(response.status).toBe(200);
	return await response.text();
}

/** Seed an entry object directly in R2 so tests can control timestamps. */
async function seedEntry(timestamp: number, text: string, suffix = 'aaaaaaaa'): Promise<void> {
	const key = `${env.ENTRIES_PREFIX}${String(timestamp).padStart(12, '0')}-${suffix}`;
	await env.JOURNAL_BUCKET.put(key, text);
}

describe('request validation', () => {
	it('rejects non-GET requests with 405', async () => {
		for (const method of ['POST', 'PUT', 'DELETE']) {
			const response = await SELF.fetch(addUrl('hello'), { method });
			expect(response.status).toBe(405);
		}
	});

	it('rejects a missing password with 401', async () => {
		const response = await SELF.fetch(`${BASE}/?text=hello`);
		expect(response.status).toBe(401);
		expect(await response.text()).toBe('');
	});

	it('rejects a wrong password with 401', async () => {
		const response = await SELF.fetch(addUrl('hello', 'wrong-password'));
		expect(response.status).toBe(401);
	});

	it('requires auth before revealing whether a route exists', async () => {
		const response = await SELF.fetch(`${BASE}/nope?password=wrong-password`);
		expect(response.status).toBe(401);
	});

	it('returns 404 for unknown routes when authenticated', async () => {
		const response = await SELF.fetch(`${BASE}/nope?password=${PASSWORD}`);
		expect(response.status).toBe(404);
	});

	it('rejects a missing text parameter with 400', async () => {
		const response = await SELF.fetch(`${BASE}/?password=${PASSWORD}`);
		expect(response.status).toBe(400);
	});

	it('rejects invalid since/limit values with 400', async () => {
		const invalid: Record<string, string>[] = [{ since: 'abc' }, { since: '-1' }, { since: '1.5' }, { limit: '0' }, { limit: 'ten' }];
		for (const params of invalid) {
			const response = await SELF.fetch(csvUrl(params));
			expect(response.status).toBe(400);
		}
	});
});

describe('rate limiting', () => {
	it('returns 429 when the rate limiter denies the request', async () => {
		const request = new IncomingRequest(addUrl('hello'));
		const limitedEnv = {
			...env,
			RATE_LIMITER: { limit: async () => ({ success: false }) } as RateLimit,
		};
		const response = await worker.fetch(request, limitedEnv);
		expect(response.status).toBe(429);
	});

	it('checks the rate limit before authentication', async () => {
		const request = new IncomingRequest(addUrl('hello', 'wrong-password'));
		let limited = false;
		const limitedEnv = {
			...env,
			RATE_LIMITER: {
				limit: async () => {
					limited = true;
					return { success: false };
				},
			} as RateLimit,
		};
		const response = await worker.fetch(request, limitedEnv);
		expect(limited).toBe(true);
		expect(response.status).toBe(429);
	});
});

describe('writing and reading entries', () => {
	it('round-trips an entry through / and /csv', async () => {
		const timestamp = await addEntry('Hello World!');
		expect(timestamp).toBeGreaterThan(0);
		expect(await readCsv()).toBe(`${timestamp},Hello World!\n`);
	});

	it('stores each entry as its own R2 object', async () => {
		await addEntry('first');
		await addEntry('second');
		const listed = await env.JOURNAL_BUCKET.list({ prefix: env.ENTRIES_PREFIX });
		expect(listed.objects.length).toBe(2);
	});

	it('does not double-decode percent-encoded text', async () => {
		// `50%25 done` in the URL decodes once to `50% done`; a second
		// decodeURIComponent would throw on the bare `%`.
		const response = await SELF.fetch(`${BASE}/?password=${PASSWORD}&text=50%25%20done`);
		expect(response.status).toBe(200);
		expect(await readCsv()).toMatch(/,50% done\n$/);
	});

	it('escapes commas, quotes, and newlines in CSV output', async () => {
		const timestamp = await addEntry('a,b "quoted"\nsecond line');
		expect(await readCsv()).toBe(`${timestamp},"a,b ""quoted""\nsecond line"\n`);
	});

	it('returns entries sorted by timestamp', async () => {
		await seedEntry(300, 'third', 'cccccccc');
		await seedEntry(100, 'first', 'aaaaaaaa');
		await seedEntry(200, 'second', 'bbbbbbbb');
		expect(await readCsv()).toBe('100,first\n200,second\n300,third\n');
	});

	it('serves /csv with a text/csv content type', async () => {
		const response = await SELF.fetch(csvUrl());
		expect(response.headers.get('Content-Type')).toBe('text/csv; charset=utf-8');
	});

	it('returns an empty body when there are no entries', async () => {
		expect(await readCsv()).toBe('');
	});
});

describe('since and limit filters', () => {
	it('filters entries newer than the since timestamp (exclusive)', async () => {
		await seedEntry(100, 'first');
		await seedEntry(200, 'second', 'bbbbbbbb');
		await seedEntry(300, 'third', 'cccccccc');
		expect(await readCsv({ since: '200' })).toBe('300,third\n');
		expect(await readCsv({ since: '99' })).toBe('100,first\n200,second\n300,third\n');
	});

	it('limits the number of returned entries, oldest first', async () => {
		await seedEntry(100, 'first');
		await seedEntry(200, 'second', 'bbbbbbbb');
		await seedEntry(300, 'third', 'cccccccc');
		expect(await readCsv({ limit: '2' })).toBe('100,first\n200,second\n');
		expect(await readCsv({ since: '100', limit: '1' })).toBe('200,second\n');
	});
});

describe('legacy journal.txt compatibility', () => {
	it('merges legacy single-file entries into /csv output', async () => {
		await env.JOURNAL_BUCKET.put(env.LEGACY_JOURNAL_KEY, '100,old entry\n200,another old entry\n');
		await seedEntry(300, 'new entry');
		expect(await readCsv()).toBe('100,old entry\n200,another old entry\n300,new entry\n');
	});

	it('re-escapes legacy text and applies since to legacy entries', async () => {
		await env.JOURNAL_BUCKET.put(env.LEGACY_JOURNAL_KEY, '100,plain\n200,has "quotes"\n');
		expect(await readCsv({ since: '100' })).toBe('200,"has ""quotes"""\n');
	});
});

describe('/count', () => {
	it('counts legacy and per-object entries', async () => {
		await env.JOURNAL_BUCKET.put(env.LEGACY_JOURNAL_KEY, '100,old\n');
		await seedEntry(200, 'newer');
		await seedEntry(300, 'newest', 'bbbbbbbb');

		const all = await SELF.fetch(`${BASE}/count?password=${PASSWORD}`);
		expect(all.status).toBe(200);
		expect(await all.json()).toEqual({ count: 3 });

		const since = await SELF.fetch(`${BASE}/count?password=${PASSWORD}&since=200`);
		expect(await since.json()).toEqual({ count: 1 });
	});
});
