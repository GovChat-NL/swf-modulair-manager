// A small MCP server with one tool. It has no dependencies.
// Change TOOLS and call() to make your own tools.
'use strict';
const http = require('node:http');

const TOOLS = [
  {
    name: 'hello',
    description: 'Says hello to a person.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'The name of the person' } },
      required: ['name'],
    },
  },
];

// Does the work of a tool. Returns the text that the assistant gets.
async function call(tool, args) {
  if (tool === 'hello') return `Hallo, ${args.name}!`;
  throw new Error(`Unknown tool: ${tool}`);
}

async function handle(message) {
  switch (message.method) {
    case 'initialize':
      return {
        protocolVersion: message.params?.protocolVersion ?? '2025-03-26',
        capabilities: { tools: {} },
        serverInfo: { name: '__NAME__', version: '0.1.0' },
      };
    case 'ping':
      return {};
    case 'tools/list':
      return { tools: TOOLS };
    case 'tools/call':
      try {
        const text = await call(message.params.name, message.params.arguments ?? {});
        return { content: [{ type: 'text', text: String(text) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: error.message }], isError: true };
      }
    default:
      throw Object.assign(new Error('Method not found'), { code: -32601 });
  }
}

http.createServer((request, response) => {
  if (request.method !== 'POST' || request.url.split('?')[0] !== '/mcp') {
    response.writeHead(request.url.split('?')[0] === '/mcp' ? 405 : 404).end();
    return;
  }
  let body = '';
  request.on('data', (part) => { body += part; });
  request.on('end', async () => {
    let message;
    try {
      message = JSON.parse(body);
    } catch (error) {
      response.writeHead(400).end();
      return;
    }
    // A message without an id is a notification. It gets no answer.
    if (message.id === undefined) {
      response.writeHead(202).end();
      return;
    }
    let answer;
    try {
      answer = { jsonrpc: '2.0', id: message.id, result: await handle(message) };
    } catch (error) {
      answer = { jsonrpc: '2.0', id: message.id, error: { code: error.code ?? -32603, message: error.message } };
    }
    response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(answer));
  });
}).listen(8080, () => console.log('MCP server listens on port 8080, path /mcp'));
