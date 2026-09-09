// Deterministic protocol peer for receipt, tool visibility and live steering tests.
import { createInterface } from 'node:readline';
import { writeFileSync } from 'node:fs';
let cwd, delivery, prompts = 0;
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
createInterface({ input: process.stdin }).on('line', line => {
  const m = JSON.parse(line);
  const reply = result => send({ jsonrpc: '2.0', id: m.id, result });
  if (m.method === 'initialize') { cwd = m.params.cwd; reply({ serverInfo: { name: 'deepseek-harness-sdk-runtime', version: 'fixture' } }); }
  if (m.method === 'shutdown') { reply({}); setTimeout(() => process.exit(), 10); }
  if (m.method !== 'session/prompt') return;
  const { sessionId, contentBlocks } = m.params;
  const text = contentBlocks.map(b => b.text ?? '').join('');
  const messageId = `message-${++prompts}`;
  const notify = (method, params) => send({ jsonrpc: '2.0', method, params });
  const event = (type, data) => notify('session.event', { sessionId, event: { type, data } });
  reply({ messageId });
  setTimeout(() => {
    event('agent/inbox/spliced', { inserted: [{ id: messageId }] });
    event('user/message', { id: messageId, content: [{ type: 'text', text }] });
    if (prompts === 1) {
      delivery = JSON.parse(text.split('shape (no fences):\n')[1].split('\nUse outcome')[0]);
      notify('session.status', { sessionId, status: 'running' });
      event('turn/start', { turn: 1 });
      event('tool/call', { callId: 'read-1', name: 'read_file', arguments: JSON.stringify({ path: 'source.txt' }) });
    } else {
      writeFileSync(cwd + '/source.txt', 'implemented\n');
      event('tool/result', { turn: 1, step: 1, message: { source: { kind: 'tool', callId: 'read-1' }, content: [{ type: 'tool-result', toolCallId: 'read-1', content: [{ type: 'text', text: 'baseline' }], isError: false }], role: 'user', id: 'tool-result-1' } });
      event('assistant/message', { message: { role: 'assistant', content: [{ type: 'text', text: JSON.stringify(delivery) }] } });
      event('turn/end', { reason: { kind: 'completed' } });
      notify('session.status', { sessionId, status: 'idle' });
    }
  }, 30);
});
process.stdin.on('end', () => process.exit());
