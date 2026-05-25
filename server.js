import 'dotenv/config';
import express from 'express';
import { createServer } from 'http';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 8765;

app.use(express.json({ limit: '1mb' }));
app.use((req, res, next) => {
  const blocked = ['.env', 'server.js', 'package.json', 'package-lock.json', '.gitignore'];
  const file = req.path.split('/').pop();
  if (blocked.includes(file)) return res.status(404).end();
  next();
});
app.use(express.static(__dirname));

// ─── Voice rules (layer 1 of system prompt) ───
const VOICE_RULES = `you are eva's mirror — a second-person voice that reflects her constellation back to her.

rules:
- always speak in second person ("you", never "I" or "Eva")
- lowercase only, no exclamation marks
- short, warm, precise. one thought per message when possible.
- you don't advise. you reflect, notice, and ask.
- when you surface a connection between pieces of the constellation, name both pieces.
- if she shares something new, hold it gently — ask one follow-up before placing it.
- never invent memories or facts. only work with what's in the constellation or what she tells you.
- when you're uncertain, say so simply.`;

// ─── Build constellation snapshot (layer 2) ───
function buildSnapshot(constellation) {
  const lines = [];

  if (constellation.anchors?.length) {
    lines.push('anchors (formative):');
    constellation.anchors.forEach(a => {
      lines.push(`  - ${a.label} [${a.color}] — ${a.memoryCount} memories, grounds: ${(a.groundsValues || []).join(', ')}`);
    });
  }

  if (constellation.memories?.length) {
    lines.push('\nmemories:');
    constellation.memories.forEach(m => {
      if (m.content && !m.content.startsWith('[placeholder')) {
        lines.push(`  - "${m.label}" (${m.anchorId}) — ${m.content.slice(0, 120)}`);
      } else {
        lines.push(`  - "${m.label}" (${m.anchorId}) — [not yet filled]`);
      }
    });
  }

  if (constellation.knownPieces?.length) {
    lines.push('\nknown pieces (intentional):');
    constellation.knownPieces.forEach(kp => {
      const summary = kp.content ? kp.content.split('\n')[0].replace(/^#+\s*/, '').slice(0, 100) : '';
      lines.push(`  - "${kp.label}" [${kp.kind}] — ${summary}`);
    });
  }

  if (constellation.values?.length) {
    lines.push('\nvalues (rim):');
    constellation.values.forEach(v => {
      const stateLabel = v.state === 'rooted' ? 'rooted' : v.state === 'forming' ? 'forming' : `open — ${v.quietNoticing || 'gap'}`;
      lines.push(`  - ${v.name}: ${stateLabel} (confidence ${v.confidence})`);
    });
  }

  if (constellation.quietNoticings?.length) {
    lines.push('\nquiet noticings (things worth surfacing):');
    constellation.quietNoticings.forEach(n => {
      lines.push(`  - ${n.text.slice(0, 150)}`);
    });
  }

  const signalCount = constellation.signals?.length || 0;
  const renderedSignals = constellation.signals?.filter(s => s.visualizationHint)?.length || 0;
  if (signalCount) {
    lines.push(`\nsignals: ${signalCount} total (${renderedSignals} rendered, ${signalCount - renderedSignals} aggregate)`);
  }

  return lines.join('\n');
}

// ─── Build system prompt ───
function buildSystemPrompt(constellation, context) {
  const snapshot = buildSnapshot(constellation);

  let contextBlock = '';
  if (context.surface) contextBlock += `\ncurrent surface: ${context.surface}`;
  if (context.anchorId) contextBlock += `\nfocused anchor: ${context.anchorId}`;
  if (context.memoryId) contextBlock += `\nfocused memory: ${context.memoryId}`;
  if (context.gapValue) contextBlock += `\nopen value being explored: ${context.gapValue}`;
  if (context.nodeId) contextBlock += `\nfocused node: ${context.nodeId}`;

  return `${VOICE_RULES}

--- constellation snapshot ---
${snapshot}

--- conversation context ---${contextBlock}`;
}

// ─── Chat endpoint (SSE streaming) ───
app.post('/api/chat', async (req, res) => {
  const { messages, constellation, context } = req.body;

  if (!messages?.length) {
    return res.status(400).json({ error: 'messages required' });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey || apiKey === 'your-api-key-here') {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });
  }

  const systemPrompt = buildSystemPrompt(constellation || {}, context || {});

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1024,
        system: systemPrompt,
        messages: messages.map(m => ({
          role: m.role,
          content: m.content,
        })),
        stream: true,
      }),
    });

    if (!response.ok) {
      const errBody = await response.text();
      res.write(`data: ${JSON.stringify({ type: 'error', error: errBody })}\n\n`);
      res.end();
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = line.slice(6);
          if (data === '[DONE]') {
            res.write('data: [DONE]\n\n');
            continue;
          }
          try {
            const event = JSON.parse(data);
            if (event.type === 'content_block_delta' && event.delta?.text) {
              res.write(`data: ${JSON.stringify({ type: 'text', text: event.delta.text })}\n\n`);
            } else if (event.type === 'message_stop') {
              res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
            }
          } catch {}
        }
      }
    }

    res.end();
  } catch (err) {
    res.write(`data: ${JSON.stringify({ type: 'error', error: err.message })}\n\n`);
    res.end();
  }
});

const server = createServer(app);
server.listen(PORT, () => {
  console.log(`constellation server running on http://localhost:${PORT}`);
});
