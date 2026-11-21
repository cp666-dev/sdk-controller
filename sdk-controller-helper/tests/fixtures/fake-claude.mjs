#!/usr/bin/env node
// Stands in for Claude Code's CLI in tests: auth status, and a -p run that uses the MCP server it's given.
import { readFileSync } from 'node:fs';
const args = process.argv.slice(2);
const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
if (args[0] === 'auth' && args[1] === 'status') {
  out({ loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'max' });
  process.exit(0);
}
const flag = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const record = { args, apiKey: process.env.ANTHROPIC_API_KEY ?? null, idle: process.env.CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT };
const config = JSON.parse(readFileSync(flag('--mcp-config'), 'utf8'));
const url = config.mcpServers.sdc.url;
const rpc = async (method, params, id) => (await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', method, params, id }) })).json();
out({ type: 'system', subtype: 'init', session_id: flag('--resume') ?? 'sess-1', mcp_servers: [{ name: 'sdc', status: 'connected' }] });
await rpc('initialize', { protocolVersion: '2025-06-18' }, 1);
const { result: { tools } } = await rpc('tools/list', {}, 2);
const call = await rpc('tools/call', { name: tools[0].name, arguments: { track: 'Bass' } }, 3);
out({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Done: ' } } });
out({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', delta: { type: 'text_delta', text: call.result.content[0].text } } });
out({ type: 'result', subtype: 'success', is_error: false, result: `Done: ${call.result.content[0].text}`, session_id: flag('--resume') ?? 'sess-1', record });
