export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		try {
			const url = new URL(request.url);
			
			// Only handle GET requests to root path
			if (request.method !== 'GET' || url.pathname !== '/') {
				return new Response('Not Found', { status: 404 });
			}

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

		} catch (error) {
			console.error('Error processing journal entry:', error);
			return new Response('Internal Server Error', { status: 500 });
		}
	},
} satisfies ExportedHandler<Env>;