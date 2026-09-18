import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { createClient } from '@libsql/client';
import { fileURLToPath } from 'node:url';

const NVIDIA_API_KEY = process.env.NVIDIA_API_KEY;

if (!NVIDIA_API_KEY) {
  console.error('❌ Missing NVIDIA_API_KEY. Set it in a .env file (see .env.example).');
  process.exit(1);
}

// Each NVIDIA-hosted image model has slightly different accepted parameters.
const MODELS = {
  'flux.2-klein-4b': {
    type: 'image',
    label: 'FLUX.2 Klein',
    endpoint: 'https://ai.api.nvidia.com/v1/genai/black-forest-labs/flux.2-klein-4b',
    timeoutMs: 45_000,
    buildBody: (prompt) => ({
      prompt, height: 1024, width: 1024, cfg_scale: 1, samples: 1, seed: 0, steps: 4
    })
  },
  'flux.1-dev': {
    type: 'image',
    label: 'FLUX.1 Dev',
    endpoint: 'https://ai.api.nvidia.com/v1/genai/black-forest-labs/flux.1-dev',
    timeoutMs: 45_000,
    buildBody: (prompt) => ({
      prompt, mode: 'base', height: 1024, width: 1024, cfg_scale: 5, samples: 1, seed: 0, steps: 50
    })
  },
  'flux.1-schnell': {
    type: 'image',
    label: 'FLUX.1 Schnell',
    endpoint: 'https://ai.api.nvidia.com/v1/genai/black-forest-labs/flux.1-schnell',
    timeoutMs: 45_000,
    buildBody: (prompt) => ({
      prompt, mode: 'base', height: 1024, width: 1024, cfg_scale: 0, samples: 1, seed: 0, steps: 4
    })
  },
  'nemotron-3-ultra': {
    type: 'chat',
    label: 'Nemotron 3 Ultra (Code)',
    endpoint: 'https://integrate.api.nvidia.com/v1/chat/completions',
    chatModel: 'nvidia/nemotron-3-ultra-550b-a55b',
    timeoutMs: 90_000
  }
};

// "Auto" lets the client skip picking a model: route code-shaped prompts to the
// chat model and everything else to the default image model.
const CODE_SIGNALS = [
  'code', 'function', 'script', 'bug', 'debug', 'error', 'refactor', 'algorithm',
  'api', 'class ', 'variable', 'component', 'regex', 'sql', 'python', 'javascript',
  'typescript', 'java ', 'c++', 'html', 'css', 'json', 'yaml', 'terminal',
  'command line', 'git ', 'compile', 'syntax', 'stack trace', 'exception',
  'unit test', 'write a program', 'endpoint', 'database', 'react', 'node'
];

function resolveAutoModel(prompt) {
  const text = prompt.toLowerCase();
  return CODE_SIGNALS.some((signal) => text.includes(signal)) ? 'nemotron-3-ultra' : 'flux.2-klein-4b';
}

// ---- Database: Turso (libSQL) in production, a local libSQL file in development ----
// Same client API either way — only the connection target changes.
const tursoDatabaseUrl = process.env.nova_ai_TURSO_DATABASE_URL ?? process.env.TURSO_DATABASE_URL;
const tursoAuthToken = process.env.nova_ai_TURSO_AUTH_TOKEN ?? process.env.TURSO_AUTH_TOKEN;

const client = createClient(
  tursoDatabaseUrl
    ? { url: tursoDatabaseUrl, authToken: tursoAuthToken }
    : { url: 'file:./data.db' }
);

await client.executeMultiple(`
  CREATE TABLE IF NOT EXISTS chats (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id INTEGER NOT NULL REFERENCES chats(id),
    prompt TEXT NOT NULL,
    model TEXT NOT NULL,
    image_data TEXT,
    response_text TEXT,
    error TEXT,
    created_at INTEGER NOT NULL
  );
`);

// Converts a libSQL ResultSet into plain objects — safer for res.json() than
// relying on the driver's Row proxy having enumerable named properties.
function rowsToObjects(result) {
  return result.rows.map((row) => {
    const obj = {};
    result.columns.forEach((col, i) => { obj[col] = row[i]; });
    return obj;
  });
}

const app = express();
const projectRoot = fileURLToPath(new URL('.', import.meta.url));
const publicRoot = fileURLToPath(new URL('./public', import.meta.url));

app.use(cors());
app.use(express.json({ limit: '10mb' })); // room for project-folder context sent to Nemotron
app.use(express.static(projectRoot));
app.use(express.static(publicRoot));

app.get('/', (_req, res) => {
  res.sendFile(fileURLToPath(new URL('./index.html', import.meta.url)));
});

app.get('/api/models', (_req, res) => {
  res.json(Object.entries(MODELS).map(([id, m]) => ({ id, label: m.label })));
});

app.get('/api/chats', async (_req, res) => {
  const result = await client.execute('SELECT * FROM chats ORDER BY updated_at DESC');
  res.json(rowsToObjects(result));
});

app.post('/api/chats', async (_req, res) => {
  const now = Date.now();
  const result = await client.execute({
    sql: 'INSERT INTO chats (title, created_at, updated_at) VALUES (?, ?, ?)',
    args: ['New chat', now, now]
  });
  res.json({ id: Number(result.lastInsertRowid), title: 'New chat', created_at: now, updated_at: now });
});

app.get('/api/chats/:id/messages', async (req, res) => {
  const result = await client.execute({
    sql: 'SELECT * FROM messages WHERE chat_id = ? ORDER BY id ASC',
    args: [req.params.id]
  });
  res.json(rowsToObjects(result));
});

app.delete('/api/chats/:id', async (req, res) => {
  const chatId = Number(req.params.id);

  await client.execute({ sql: 'DELETE FROM messages WHERE chat_id = ?', args: [chatId] });
  const result = await client.execute({ sql: 'DELETE FROM chats WHERE id = ?', args: [chatId] });

  if (Number(result.rowsAffected) === 0) {
    return res.status(404).json({ error: 'Chat not found.' });
  }
  res.status(204).end();
});

app.post('/api/generate', async (req, res) => {
  const prompt = req.body.prompt;
  const chatId = Number(req.body.chatId);
  if (!prompt || !prompt.trim()) {
    return res.status(400).json({ error: 'Prompt is required.' });
  }

  const chatExists = await client.execute({ sql: 'SELECT id FROM chats WHERE id = ?', args: [chatId] });
  if (!chatId || chatExists.rows.length === 0) {
    return res.status(400).json({ error: 'A valid chatId is required.' });
  }

  const modelId = req.body.model === 'auto'
    ? resolveAutoModel(prompt)
    : (MODELS[req.body.model] ? req.body.model : 'flux.2-klein-4b');
  const model = MODELS[modelId];

  // Abort the upstream NVIDIA request if the client disconnects (e.g. user hit Stop).
  // res.on('close') fires when the connection ends for any reason; `responseSent` tells
  // us whether that's a normal completion or a premature disconnect/cancel.
  let responseSent = false;
  const clientAbort = new AbortController();
  const onResClose = () => { if (!responseSent) clientAbort.abort(); };
  res.on('close', onResClose);
  const signal = AbortSignal.any([AbortSignal.timeout(model.timeoutMs), clientAbort.signal]);

  let imageData = null;
  let responseText = null;
  let errorText = null;

  try {
    if (model.type === 'chat') {
      // Feed prior chat-model turns in this conversation back in as context.
      const prior = rowsToObjects(await client.execute({
        sql: `SELECT prompt, response_text FROM messages
              WHERE chat_id = ? AND response_text IS NOT NULL
              ORDER BY id ASC`,
        args: [chatId]
      }));

      const messages = [];
      if (req.body.projectContext) {
        messages.push({
          role: 'system',
          content: `You are helping with a local software project. Here are the contents of its files for context. Use them to answer questions accurately about this specific codebase.\n\n${req.body.projectContext}`
        });
      }

      messages.push({
        role: 'system',
        content: 'You are continuing the current chat thread. Stay focused on the same conversation and build on the earlier messages in this chat. Only switch to a different topic or start a fresh conversation if the user explicitly asks for a new task, new topic, or a new chat.'
      });

      for (const turn of prior) {
        messages.push({ role: 'user', content: turn.prompt });
        messages.push({ role: 'assistant', content: turn.response_text });
      }
      messages.push({ role: 'user', content: prompt });

      const response = await fetch(model.endpoint, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${NVIDIA_API_KEY}`,
          'Accept': 'application/json',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: model.chatModel,
          messages,
          temperature: 0.6,
          top_p: 0.95,
          max_tokens: 4096,
          stream: false
        }),
        signal
      });

      const data = await response.json();

      if (!response.ok) {
        console.error('❌ NVIDIA Error:', data);
        errorText = data.error?.message || data.detail?.[0]?.msg || `Request failed (${response.status}).`;
      } else {
        const content = data.choices?.[0]?.message?.content;
        if (content) {
          responseText = content;
        } else {
          errorText = 'Unknown response format returned by the model.';
        }
      }
    } else {
      const response = await fetch(model.endpoint, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${NVIDIA_API_KEY}`,
          'Accept': 'application/json',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(model.buildBody(prompt)),
        signal
      });

      const data = await response.json();

      if (!response.ok) {
        console.error('❌ NVIDIA Error:', data);
        errorText = data.detail?.[0]?.msg || `Request failed (${response.status}).`;
      } else {
        const artifact = data.artifacts && data.artifacts[0];
        if (artifact && artifact.base64) {
          imageData = artifact.base64;
        } else if (artifact && artifact.finishReason && artifact.finishReason !== 'SUCCESS') {
          errorText = artifact.finishReason === 'CONTENT_FILTERED'
            ? 'This prompt was blocked by content filtering. Try rephrasing it.'
            : `Generation did not complete (${artifact.finishReason}).`;
        } else {
          errorText = 'Unknown response format returned by the model.';
        }
      }
    }
  } catch (error) {
    if (clientAbort.signal.aborted) {
      errorText = 'Cancelled.';
    } else if (error.name === 'TimeoutError') {
      errorText = `${model.label} did not respond in time. It may be overloaded — try again or pick a different model.`;
    } else {
      console.error('❌ Backend script failed:', error);
      errorText = error.message;
    }
  } finally {
    res.off('close', onResClose);
  }

  // If the client is genuinely gone (they hit Stop and navigated away/closed the tab),
  // still record the cancellation in history, but don't bother writing a response.
  const now = Date.now();
  const info = await client.execute({
    sql: 'INSERT INTO messages (chat_id, prompt, model, image_data, response_text, error, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    args: [chatId, prompt, modelId, imageData, responseText, errorText, now]
  });

  const countResult = rowsToObjects(await client.execute({
    sql: 'SELECT COUNT(*) AS c FROM messages WHERE chat_id = ?',
    args: [chatId]
  }));
  if (countResult[0].c === 1) {
    await client.execute({
      sql: 'UPDATE chats SET title = ?, updated_at = ? WHERE id = ?',
      args: [prompt.slice(0, 48), now, chatId]
    });
  } else {
    await client.execute({ sql: 'UPDATE chats SET updated_at = ? WHERE id = ?', args: [now, chatId] });
  }

  responseSent = true;
  res.json({
    id: Number(info.lastInsertRowid),
    chat_id: chatId,
    prompt,
    model: modelId,
    image_data: imageData,
    response_text: responseText,
    error: errorText,
    created_at: now
  });
});


// Vercel imports this file as a serverless function handler instead of calling listen().
if (!process.env.VERCEL) {
  app.listen(3000, () => {
    console.log('🚀 AI Proxy Engine Running at http://localhost:3000');
  });
}



export default app;
