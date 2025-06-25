export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		try {
			const url = new URL(request.url);
			
			// Only handle GET requests
			if (request.method !== 'GET') {
				return new Response('Method Not Allowed', { status: 405 });
			}

			// Handle /csv route
			if (url.pathname === '/csv') {
				return await handleCsvRequest(url, env);
			}

			// Handle root route
			if (url.pathname === '/') {
				return await handleJournalRequest(url, env);
			}

			return new Response('Not Found', { status: 404 });

		} catch (error) {
			console.error('Error processing request:', error);
			return new Response('Internal Server Error', { status: 500 });
		}
	},
} satisfies ExportedHandler<Env>;

async function handleJournalRequest(url: URL, env: Env): Promise<Response> {
	// Extract query parameters
	const password = url.searchParams.get('password');
	const text = url.searchParams.get('text');

	// Check for missing parameters
	if (!password || !text) {
		return new Response('', { status: 400 });
	}

	// Authenticate password
	if (password !== env.SECRET_PASSWORD) {
		return new Response('', { status: 401 });
	}

	// URL decode the text and create journal entry
	const decodedText = decodeURIComponent(text);
	const timestamp = Math.floor(Date.now() / 1000);
	const entry = `${timestamp},${decodedText}\n`;

	// Append to R2 bucket
	const key = 'journal.txt';
	
	// Get existing content to append to it
	let existingContent = '';
	try {
		const existingObject = await env.JOURNAL_BUCKET.get(key);
		if (existingObject) {
			existingContent = await existingObject.text();
		}
	} catch (error) {
		// If file doesn't exist, that's fine - we'll create it
		console.log('File does not exist yet, creating new journal.txt');
	}

	// Append new entry and save
	const newContent = existingContent + entry;
	await env.JOURNAL_BUCKET.put(key, newContent);

	return new Response('', { status: 200 });
}

async function handleCsvRequest(url: URL, env: Env): Promise<Response> {
	// Extract password parameter
	const password = url.searchParams.get('password');

	// Check for missing password
	if (!password) {
		return new Response('', { status: 400 });
	}

	// Authenticate password
	if (password !== env.SECRET_PASSWORD) {
		return new Response('', { status: 401 });
	}

	// Get journal contents from R2
	const key = 'journal.txt';
	try {
		const journalObject = await env.JOURNAL_BUCKET.get(key);
		if (!journalObject) {
			// Return empty CSV if no journal exists
			return new Response('', {
				status: 200,
				headers: {
					'Content-Type': 'text/plain',
				},
			});
		}

		const content = await journalObject.text();
		return new Response(content, {
			status: 200,
			headers: {
				'Content-Type': 'text/plain',
			},
		});
	} catch (error) {
		console.error('Error retrieving journal contents:', error);
		return new Response('Internal Server Error', { status: 500 });
	}
}