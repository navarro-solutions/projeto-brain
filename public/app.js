// Brain — frontend (sem build, JavaScript puro)
const $ = (sel) => document.querySelector(sel);

const state = {
  token: safeGet("brain-token"),
  conversationId: null,
  pendingFiles: [], // {id, name, mime_type, uploading}
  sending: false,
  recorder: null,
};

function safeGet(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}
function safeSet(key, value) {
  try { value == null ? localStorage.removeItem(key) : localStorage.setItem(key, value); } catch { /* ignora */ }
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: { ...(options.headers || {}), Authorization: `Bearer ${state.token}` },
  });
  if (res.status === 401) { logout(); throw new Error("Não autorizado"); }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Erro ${res.status}`);
  }
  return res;
}

function renderMarkdown(text) {
  if (window.marked && window.DOMPurify) return DOMPurify.sanitize(marked.parse(text));
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML.replace(/\n/g, "<br>");
}

// ---------------------------------------------------------------------------
// Login
// ---------------------------------------------------------------------------
function showApp() {
  $("#login").classList.add("hidden");
  $("#app").classList.remove("hidden");
  loadConversations();
}
function logout() {
  state.token = null;
  safeSet("brain-token", null);
  $("#app").classList.add("hidden");
  $("#login").classList.remove("hidden");
}
$("#login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  state.token = $("#token-input").value.trim();
  try {
    await api("/api/profile");
    safeSet("brain-token", state.token);
    showApp();
  } catch {
    alert("Senha inválida.");
  }
});
$("#logout").addEventListener("click", logout);

// ---------------------------------------------------------------------------
// Conversas
// ---------------------------------------------------------------------------
async function loadConversations() {
  const list = await (await api("/api/conversations")).json();
  const nav = $("#conversation-list");
  nav.innerHTML = "";
  for (const conv of list) {
    const item = document.createElement("div");
    item.className = "conversation-item" + (conv.id === state.conversationId ? " active" : "");
    const title = document.createElement("span");
    title.textContent = conv.title;
    const del = document.createElement("button");
    del.textContent = "🗑";
    del.title = "Apagar conversa";
    del.onclick = async (ev) => {
      ev.stopPropagation();
      if (!confirm("Apagar esta conversa? (as memórias aprendidas continuam)")) return;
      await api(`/api/conversations/${conv.id}`, { method: "DELETE" });
      if (state.conversationId === conv.id) newChat();
      loadConversations();
    };
    item.append(title, del);
    item.onclick = () => openConversation(conv.id, conv.title);
    nav.append(item);
  }
}

function newChat() {
  state.conversationId = null;
  $("#conversation-title").textContent = "Nova conversa";
  $("#messages").innerHTML = `<div class="empty"><h3>O que está na sua cabeça?</h3><p>Escreva, grave um áudio ou envie qualquer arquivo. Tudo fica guardado e eu vou aprendendo como você pensa.</p></div>`;
  $("#sidebar").classList.remove("open");
  document.querySelectorAll(".conversation-item.active").forEach((el) => el.classList.remove("active"));
}
$("#new-chat").addEventListener("click", newChat);
$("#toggle-sidebar").addEventListener("click", () => $("#sidebar").classList.toggle("open"));

async function openConversation(id, title) {
  state.conversationId = id;
  $("#conversation-title").textContent = title;
  $("#sidebar").classList.remove("open");
  const msgs = await (await api(`/api/conversations/${id}/messages`)).json();
  const box = $("#messages");
  box.innerHTML = "";
  for (const m of msgs) addMessage(m.role, m.content, m.attachments);
  box.scrollTop = box.scrollHeight;
  loadConversations();
}

function addMessage(role, text, attachments = []) {
  const box = $("#messages");
  box.querySelector(".empty")?.remove();
  const wrap = document.createElement("div");
  wrap.className = `msg ${role}`;
  if (attachments?.length) {
    const chips = document.createElement("div");
    chips.className = "chips";
    for (const a of attachments) {
      const chip = document.createElement("span");
      chip.className = "chip";
      chip.innerHTML = `📄 <span></span>`;
      chip.querySelector("span").textContent = a.name;
      chips.append(chip);
    }
    wrap.append(chips);
  }
  const bubble = document.createElement("div");
  bubble.className = "bubble";
  if (role === "user") bubble.textContent = text;
  else bubble.innerHTML = renderMarkdown(text);
  if (text || role === "assistant") wrap.append(bubble);
  box.append(wrap);
  box.scrollTop = box.scrollHeight;
  return bubble;
}

// ---------------------------------------------------------------------------
// Anexos
// ---------------------------------------------------------------------------
function renderAttachments() {
  const box = $("#attachments");
  box.innerHTML = "";
  state.pendingFiles.forEach((f, i) => {
    const chip = document.createElement("span");
    chip.className = "chip";
    chip.innerHTML = `${f.uploading ? "⏳" : "📄"} <span></span> <button type="button" title="Remover">✕</button>`;
    chip.querySelector("span").textContent = f.name;
    chip.querySelector("button").onclick = () => { state.pendingFiles.splice(i, 1); renderAttachments(); };
    box.append(chip);
  });
}

async function uploadFiles(fileList) {
  const files = [...fileList];
  if (!files.length) return;
  const placeholders = files.map((f) => ({ name: f.name, uploading: true }));
  state.pendingFiles.push(...placeholders);
  renderAttachments();
  const form = new FormData();
  for (const f of files) form.append("files", f);
  if (state.conversationId) form.append("conversationId", state.conversationId);
  try {
    const saved = await (await api("/api/files", { method: "POST", body: form })).json();
    state.pendingFiles = state.pendingFiles.filter((p) => !placeholders.includes(p)).concat(saved);
  } catch (err) {
    state.pendingFiles = state.pendingFiles.filter((p) => !placeholders.includes(p));
    alert(`Falha ao enviar arquivo: ${err.message}`);
  }
  renderAttachments();
}

$("#file-input").addEventListener("change", (e) => { uploadFiles(e.target.files); e.target.value = ""; });
const main = document.querySelector(".main");
main.addEventListener("dragover", (e) => { e.preventDefault(); main.classList.add("drag-over"); });
main.addEventListener("dragleave", () => main.classList.remove("drag-over"));
main.addEventListener("drop", (e) => { e.preventDefault(); main.classList.remove("drag-over"); uploadFiles(e.dataTransfer.files); });
document.addEventListener("paste", (e) => { if (e.clipboardData?.files?.length) uploadFiles(e.clipboardData.files); });

// ---------------------------------------------------------------------------
// Gravação de áudio
// ---------------------------------------------------------------------------
$("#mic").addEventListener("click", async () => {
  const btn = $("#mic");
  if (state.recorder) { state.recorder.stop(); return; }
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch {
    alert("Não foi possível acessar o microfone.");
    return;
  }
  const chunks = [];
  const recorder = new MediaRecorder(stream);
  recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  recorder.onstop = async () => {
    stream.getTracks().forEach((t) => t.stop());
    state.recorder = null;
    btn.classList.remove("recording");
    btn.textContent = "⏳";
    const type = recorder.mimeType || "audio/webm";
    const ext = type.includes("mp4") ? "m4a" : type.includes("ogg") ? "ogg" : "webm";
    const blob = new Blob(chunks, { type });
    const form = new FormData();
    form.append("audio", new File([blob], `audio.${ext}`, { type }));
    try {
      const { text } = await (await api("/api/transcribe", { method: "POST", body: form })).json();
      const input = $("#input");
      input.value = (input.value ? input.value + "\n" : "") + text;
      autoGrow();
      input.focus();
    } catch (err) {
      alert(`Falha na transcrição: ${err.message}`);
    }
    btn.textContent = "🎙️";
  };
  recorder.start();
  state.recorder = recorder;
  btn.classList.add("recording");
  btn.textContent = "⏹";
});

// ---------------------------------------------------------------------------
// Envio + streaming da resposta
// ---------------------------------------------------------------------------
const input = $("#input");
function autoGrow() { input.style.height = "auto"; input.style.height = `${Math.min(input.scrollHeight, 200)}px`; }
input.addEventListener("input", autoGrow);
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing && window.matchMedia("(pointer: fine)").matches) {
    e.preventDefault();
    $("#composer").requestSubmit();
  }
});

const STATUS_LABEL = { thinking: "pensando…", searching: "pesquisando na web…", writing: "" };

$("#composer").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (state.sending) return;
  if (state.pendingFiles.some((f) => f.uploading)) { alert("Aguarde o envio dos arquivos."); return; }
  const text = input.value.trim();
  const files = state.pendingFiles.filter((f) => f.id);
  if (!text && !files.length) return;

  state.sending = true;
  $("#send").disabled = true;
  input.value = "";
  autoGrow();
  state.pendingFiles = [];
  renderAttachments();

  addMessage("user", text, files);
  const bubble = addMessage("assistant", "");
  const status = document.createElement("div");
  status.className = "status";
  status.textContent = "lembrando…";
  bubble.parentElement.insertBefore(status, bubble);

  let answer = "";
  try {
    const res = await api("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ conversationId: state.conversationId, message: text, fileIds: files.map((f) => f.id) }),
    });
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buffer.indexOf("\n\n")) !== -1) {
        const raw = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        let event = "message";
        let data = "";
        for (const line of raw.split("\n")) {
          if (line.startsWith("event:")) event = line.slice(6).trim();
          else if (line.startsWith("data:")) data += line.slice(5).trim();
        }
        if (!data) continue;
        const payload = JSON.parse(data);
        if (event === "meta") {
          const isNew = !state.conversationId;
          state.conversationId = payload.conversationId;
          if (isNew) loadConversations();
        } else if (event === "status") {
          status.textContent = STATUS_LABEL[payload.status] ?? "";
        } else if (event === "text") {
          answer += payload.text;
          status.textContent = "";
          bubble.innerHTML = renderMarkdown(answer);
          $("#messages").scrollTop = $("#messages").scrollHeight;
        } else if (event === "error") {
          status.textContent = "";
          bubble.innerHTML = `<p class="error"></p>`;
          bubble.querySelector(".error").textContent = payload.message;
        } else if (event === "done") {
          status.remove();
          // O título é gerado em segundo plano; atualiza a lista em alguns segundos
          setTimeout(loadConversations, 6000);
        }
      }
    }
  } catch (err) {
    status.textContent = "";
    bubble.innerHTML = `<p class="error"></p>`;
    bubble.querySelector(".error").textContent = err.message;
  } finally {
    state.sending = false;
    $("#send").disabled = false;
    input.focus();
  }
});

// ---------------------------------------------------------------------------
// Painéis: memória/perfil e arquivos
// ---------------------------------------------------------------------------
function openPanel(title) {
  $("#panel-title").textContent = title;
  $("#panel-body").innerHTML = "<p class='status'>Carregando…</p>";
  $("#panel").classList.remove("hidden");
  $("#sidebar").classList.remove("open");
}
$("#panel-close").addEventListener("click", () => $("#panel").classList.add("hidden"));
$("#panel").addEventListener("click", (e) => { if (e.target.id === "panel") $("#panel").classList.add("hidden"); });

$("#open-memory").addEventListener("click", async () => {
  openPanel("Memória e perfil");
  const [{ summary }, memories] = await Promise.all([
    api("/api/profile").then((r) => r.json()),
    api("/api/memories").then((r) => r.json()),
  ]);
  const body = $("#panel-body");
  body.innerHTML = `
    <label><strong>Seu perfil (como o Brain enxerga você)</strong></label>
    <textarea id="profile-text"></textarea>
    <button id="save-profile" class="btn-primary">Salvar perfil</button>
    <strong>Memórias (${memories.length})</strong>`;
  $("#profile-text").value = summary;
  $("#save-profile").onclick = async () => {
    await api("/api/profile", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ summary: $("#profile-text").value }),
    });
    $("#save-profile").textContent = "Salvo ✓";
  };
  for (const m of memories) {
    const row = document.createElement("div");
    row.className = "memory-item";
    row.innerHTML = `<span class="tag"></span><p></p><button title="Esquecer">✕</button>`;
    row.querySelector(".tag").textContent = m.category;
    row.querySelector("p").textContent = m.content;
    row.querySelector("button").onclick = async () => {
      await api(`/api/memories/${m.id}`, { method: "DELETE" });
      row.remove();
    };
    body.append(row);
  }
});

$("#open-files").addEventListener("click", async () => {
  openPanel("Arquivos guardados");
  const files = await (await api("/api/files")).json();
  const body = $("#panel-body");
  body.innerHTML = files.length ? "" : "<p class='status'>Nenhum arquivo ainda.</p>";
  for (const f of files) {
    const row = document.createElement("div");
    row.className = "file-item";
    row.innerHTML = `<a></a><small></small><small></small>`;
    row.querySelector("a").textContent = f.name;
    row.querySelector("a").onclick = async () => {
      const { url } = await (await api(`/api/files/${f.id}/url`)).json();
      if (url) window.open(url, "_blank");
    };
    const [meta, summary] = row.querySelectorAll("small");
    meta.textContent = `${f.kind} · ${(f.size_bytes / 1024).toFixed(0)} KB · ${new Date(f.created_at).toLocaleString("pt-BR")}`;
    summary.textContent = f.summary ? f.summary.slice(0, 240) : "";
    body.append(row);
  }
});

// ---------------------------------------------------------------------------
if (state.token) showApp(); else $("#login").classList.remove("hidden");
