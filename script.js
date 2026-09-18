const EXAMPLE_PROMPTS = [
  'A cat astronaut floating in space',
  'Neon-lit cyberpunk city at night',
  'Cozy cabin in a snowy forest'
];

const CODE_EXTENSIONS = {
  python: 'py', py: 'py', javascript: 'js', js: 'js', typescript: 'ts', ts: 'ts',
  bash: 'sh', sh: 'sh', shell: 'sh', json: 'json', html: 'html', css: 'css',
  java: 'java', 'c++': 'cpp', cpp: 'cpp', c: 'c', go: 'go', rust: 'rs',
  ruby: 'rb', php: 'php', sql: 'sql'
};

let currentChatId = null;
let chats = [];
let selectedDirHandle = null;
let projectContext = '';

// ---- Reading a project folder as context for Nemotron ----
const IGNORED_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', 'out', '__pycache__',
  'venv', '.venv', 'target', 'bin', 'obj', '.cache', 'coverage', '.vscode', '.idea'
]);
const IGNORED_FILES = new Set(['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml']);
const TEXT_EXTENSIONS = new Set([
  'js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'py', 'java', 'c', 'cpp', 'h', 'hpp',
  'cs', 'go', 'rs', 'rb', 'php', 'html', 'htm', 'css', 'scss', 'sass', 'json',
  'md', 'markdown', 'txt', 'yml', 'yaml', 'sh', 'bash', 'sql', 'vue', 'svelte',
  'xml', 'ini', 'toml', 'env'
]);
const MAX_FILE_CHARS = 50_000;
const MAX_TOTAL_CHARS = 120_000;
const MAX_FILES = 200;

async function* walkDirectory(dirHandle, prefix = '') {
  for await (const [name, handle] of dirHandle.entries()) {
    const relPath = prefix ? `${prefix}/${name}` : name;
    if (handle.kind === 'directory') {
      if (IGNORED_DIRS.has(name) || name.startsWith('.')) continue;
      yield* walkDirectory(handle, relPath);
    } else {
      yield { name, relPath, handle };
    }
  }
}

async function readProjectFiles(dirHandle) {
  let totalChars = 0;
  let fileCount = 0;
  let skipped = 0;
  const parts = [];

  for await (const { name, relPath, handle } of walkDirectory(dirHandle)) {
    if (IGNORED_FILES.has(name)) continue;
    const ext = name.includes('.') ? name.split('.').pop().toLowerCase() : '';
    if (!TEXT_EXTENSIONS.has(ext)) continue;

    if (fileCount >= MAX_FILES || totalChars >= MAX_TOTAL_CHARS) {
      skipped++;
      continue;
    }

    try {
      const file = await handle.getFile();
      let text = await file.text();
      if (text.length > MAX_FILE_CHARS) text = text.slice(0, MAX_FILE_CHARS) + '\n...(truncated)';
      if (totalChars + text.length > MAX_TOTAL_CHARS) {
        text = text.slice(0, MAX_TOTAL_CHARS - totalChars) + '\n...(truncated)';
      }
      parts.push(`--- File: ${relPath} ---\n${text}`);
      totalChars += text.length;
      fileCount++;
    } catch (error) {
      skipped++; // unreadable (likely binary or a permission issue) — skip silently
    }
  }

  return { context: parts.join('\n\n'), fileCount, skipped };
}

// ---- Theme: defaults to following the OS's own light/dark (day/night) setting ----
function applyTheme(theme) {
  const root = document.documentElement;
  const icon = document.getElementById('theme-toggle');
  if (theme === 'auto') {
    root.removeAttribute('data-theme');
    icon.innerText = '🖥️';
    icon.title = 'Theme: Auto (follows system)';
  } else {
    root.setAttribute('data-theme', theme);
    icon.innerText = theme === 'dark' ? '🌙' : '☀️';
    icon.title = `Theme: ${theme === 'dark' ? 'Dark' : 'Light'}`;
  }
  localStorage.setItem('theme', theme);
}

function cycleTheme() {
  const current = localStorage.getItem('theme') || 'auto';
  const next = current === 'auto' ? 'light' : current === 'light' ? 'dark' : 'auto';
  applyTheme(next);
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.innerText = str;
  return div.innerHTML;
}

function useExample(text) {
  const input = document.getElementById('prompt-input');
  input.value = text;
  input.focus();
}

function downloadImage(url) {
  const link = document.createElement('a');
  link.href = url;
  link.download = 'flux-generated-image.png';
  link.click();
}

const messageTexts = {};

function copyText(id, btn) {
  const text = messageTexts[id] || '';
  navigator.clipboard.writeText(text).then(() => {
    const original = btn.innerText;
    btn.innerText = 'Copied!';
    setTimeout(() => { btn.innerText = original; }, 1500);
  });
}

async function chooseFolder() {
  if (!window.showDirectoryPicker) {
    alert('Choosing a folder requires a Chromium-based browser (Chrome or Edge).');
    return;
  }
  const label = document.getElementById('folder-label');
  try {
    selectedDirHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
    label.innerText = `📁 Reading ${selectedDirHandle.name}...`;

    const { context, fileCount, skipped } = await readProjectFiles(selectedDirHandle);
    projectContext = context;

    const skippedNote = skipped ? ` (${skipped} skipped)` : '';
    label.innerText = fileCount > 0
      ? `📁 ${selectedDirHandle.name} — ${fileCount} files loaded${skippedNote}`
      : `📁 ${selectedDirHandle.name} — no readable source files found`;
  } catch (error) {
    if (error.name === 'AbortError') return; // user cancelled the picker, no-op
    console.error('Folder picker failed:', error);
    label.innerText = '📁 No folder selected';
    alert(`Couldn't read that folder: ${error.message}`);
  }
}

function detectFilename(text) {
  const match = text.match(/```(\w+)/);
  const ext = match && CODE_EXTENSIONS[match[1].toLowerCase()] ? CODE_EXTENSIONS[match[1].toLowerCase()] : 'txt';
  return `nemotron-code-${Date.now()}.${ext}`;
}

async function saveToFolder(id, btn) {
  if (!selectedDirHandle) {
    await chooseFolder();
    if (!selectedDirHandle) return;
  }

  const text = messageTexts[id] || '';
  const filename = detectFilename(text);

  try {
    const fileHandle = await selectedDirHandle.getFileHandle(filename, { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(text);
    await writable.close();

    const original = btn.innerText;
    btn.innerText = `Saved as ${filename}`;
    setTimeout(() => { btn.innerText = original; }, 2000);
  } catch (error) {
    alert(`Could not save file: ${error.message}`);
  }
}

async function loadModels() {
  const select = document.getElementById('model-select');
  try {
    const response = await fetch('/api/models');
    const models = await response.json();
    select.innerHTML = models.map(m => `<option value="${m.id}">${m.label}</option>`).join('');
  } catch (error) {
    console.error('Failed to load models:', error);
    select.innerHTML = '<option value="">Default</option>';
  }
  updateComposerForModel();
}

function updateComposerForModel() {
  const model = document.getElementById('model-select').value;
  const isCode = model === 'nemotron-3-ultra';
  document.getElementById('folder-row').classList.toggle('visible', isCode);
  document.querySelector('.hint').innerText = isCode
    ? 'Code generation can take up to a minute for detailed answers.'
    : 'Image generation typically takes 5–10 seconds.';
  document.getElementById('prompt-input').placeholder = isCode
    ? 'Describe the code you want...'
    : 'Describe what you want...';
}

function renderChatList() {
  const list = document.getElementById('chat-list');
  list.innerHTML = chats.map(c => `
    <div class="chat-item ${c.id === currentChatId ? 'active' : ''}" onclick="selectChat(${c.id})">
      <span class="chat-item-title">${escapeHtml(c.title)}</span>
      <button class="chat-item-delete" title="Delete chat" onclick="deleteChat(event, ${c.id})">×</button>
    </div>
  `).join('');
}

let chatIdPendingDelete = null;

function deleteChat(event, id) {
  event.stopPropagation();
  chatIdPendingDelete = id;
  document.getElementById('modal-overlay').classList.remove('hidden');
}

function closeDeleteModal() {
  chatIdPendingDelete = null;
  document.getElementById('modal-overlay').classList.add('hidden');
}

async function confirmDeleteChat() {
  const id = chatIdPendingDelete;
  closeDeleteModal();
  if (!id) return;

  await fetch(`/api/chats/${id}`, { method: 'DELETE' });
  chats = chats.filter(c => c.id !== id);

  if (id !== currentChatId) {
    renderChatList();
  } else if (chats.length > 0) {
    await selectChat(chats[0].id); // also re-renders the list
  } else {
    await createNewChat(); // also re-renders the list
  }
}

async function loadChats() {
  const response = await fetch('/api/chats');
  chats = await response.json();

  if (chats.length === 0) {
    await createNewChat();
    return;
  }

  renderChatList();
  await selectChat(chats[0].id);
}

async function createNewChat() {
  const response = await fetch('/api/chats', { method: 'POST' });
  const chat = await response.json();
  chats.unshift(chat);
  await selectChat(chat.id);
}

async function selectChat(id) {
  currentChatId = id;
  renderChatList();

  const chat = chats.find(c => c.id === id);
  document.getElementById('chat-title').innerText = chat ? chat.title : 'New chat';

  const response = await fetch(`/api/chats/${id}/messages`);
  const messages = await response.json();
  renderThread(messages);
}

function renderThread(messages) {
  const thread = document.getElementById('thread');

  if (messages.length === 0) {
    thread.innerHTML = `
      <div class="empty-state">
        <h1>What should we create?</h1>
        <p>Pick a model below, describe what you want, or try one of these:</p>
        <div class="examples">
          ${EXAMPLE_PROMPTS.map(p => `<div class="example-chip" onclick="useExample('${p.replace(/'/g, "\\'")}')">${escapeHtml(p)}</div>`).join('')}
        </div>
      </div>
    `;
    return;
  }

  thread.innerHTML = messages.map(messageHtml).join('');
  thread.scrollTop = thread.scrollHeight;
}

function messageHtml(m) {
  let assistant;
  if (m.image_data) {
    const dataUrl = `data:image/png;base64,${m.image_data}`;
    assistant = `
      <img class="result-image" src="${dataUrl}" alt="Generated image">
      <div class="result-actions">
        <button onclick="downloadImage('${dataUrl}')">Download</button>
      </div>
    `;
  } else if (m.response_text) {
    if (m.id) messageTexts[m.id] = m.response_text;
    assistant = `
      <pre class="code-block"><code>${escapeHtml(m.response_text)}</code></pre>
      <div class="result-actions">
        <button onclick="copyText(${m.id}, this)">Copy</button>
        <button onclick="saveToFolder(${m.id}, this)">Save to Folder</button>
      </div>
    `;
  } else if (m.error) {
    assistant = `<div class="error-text">${escapeHtml(m.error)}</div>`;
  } else {
    assistant = `<div class="spinner"></div>`;
  }

  return `
    <div class="turn">
      <div class="bubble-user">${escapeHtml(m.prompt)}</div>
      <div class="bubble-assistant">
        <span class="model-tag">${escapeHtml(m.model || '')}</span>
        ${assistant}
      </div>
    </div>
  `;
}

const ICON_SEND = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="19" x2="12" y2="5"></line><polyline points="5 12 12 5 19 12"></polyline></svg>`;
const ICON_STOP = `<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><rect x="4" y="4" width="16" height="16" rx="3"></rect></svg>`;

let isGenerating = false;
let activeAbortController = null;

function handlePrimaryAction() {
  if (isGenerating) {
    activeAbortController?.abort();
  } else {
    handleGeneration();
  }
}

function setGeneratingState(generating) {
  isGenerating = generating;
  const btn = document.getElementById('gen-btn');
  btn.innerHTML = generating ? ICON_STOP : ICON_SEND;
  btn.classList.toggle('is-stop', generating);
  btn.title = generating ? 'Stop' : 'Generate';
}

async function handleGeneration() {
  const promptInput = document.getElementById('prompt-input');
  const prompt = promptInput.value;
  const selectedModel = document.getElementById('model-select').value;
  const thread = document.getElementById('thread');

  if (isGenerating) return;
  if (!prompt.trim()) return alert('Please enter a prompt!');
  if (!currentChatId) return alert('No active chat.');

  promptInput.value = '';
  setGeneratingState(true);
  activeAbortController = new AbortController();

  // Optimistically render the user's message with a loading indicator.
  const pendingMessage = { prompt, model: selectedModel, image_data: null, error: null };
  const existingEmptyState = thread.querySelector('.empty-state');
  if (existingEmptyState) thread.innerHTML = '';
  thread.insertAdjacentHTML('beforeend', messageHtml(pendingMessage));
  thread.scrollTop = thread.scrollHeight;

  try {
    const response = await fetch('/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt,
        model: selectedModel,
        chatId: currentChatId,
        projectContext: selectedModel === 'nemotron-3-ultra' ? projectContext : ''
      }),
      signal: activeAbortController.signal
    });

    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `Status ${response.status}`);

    // Re-render the whole thread from the server so it stays in sync.
    const messagesResponse = await fetch(`/api/chats/${currentChatId}/messages`);
    const messages = await messagesResponse.json();
    renderThread(messages);

    // Refresh the sidebar in case this was the first message (title changed).
    const chatsResponse = await fetch('/api/chats');
    chats = await chatsResponse.json();
    renderChatList();
    const chat = chats.find(c => c.id === currentChatId);
    if (chat) document.getElementById('chat-title').innerText = chat.title;
  } catch (error) {
    const lastAssistant = thread.querySelector('.turn:last-child .bubble-assistant');
    if (error.name === 'AbortError') {
      if (lastAssistant) lastAssistant.innerHTML = `<div class="error-text">Cancelled.</div>`;
    } else {
      console.error(error);
      if (lastAssistant) lastAssistant.innerHTML = `<div class="error-text">${escapeHtml(error.message)}</div>`;
    }
  } finally {
    setGeneratingState(false);
    activeAbortController = null;
  }
}

document.addEventListener('DOMContentLoaded', () => {
  applyTheme(localStorage.getItem('theme') || 'auto');

  loadModels();
  loadChats();

  document.getElementById('model-select').addEventListener('change', updateComposerForModel);

  const input = document.getElementById('prompt-input');
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleGeneration();
    }
  });
});
