// Cloudflare Worker for 文案录音本.
// It keeps the GitHub token away from the page and stores the shared notebook in a
// private GitHub repository: lines/<id>.json for each entry, audio/<file> for recordings.
//
// Settings (Cloudflare dashboard → this Worker → Settings → Variables and secrets):
//   GITHUB_TOKEN    secret. Fine-grained token with Contents: Read and write on DATA_REPO only.
//   ADMIN_KEY       secret. The owner's passphrase; it unlocks editing and deleting.
//   DATA_REPO       text, e.g. "patrick-infinexus/wenan-luyinben-data".
//   ALLOWED_ORIGIN  text, e.g. "https://patrick-infinexus.github.io". Leave unset to allow any site.
// Bindings (Settings → Bindings):
//   AI              Workers AI. Turns recordings into text, so phones need no model of their own.

const BRANCH = "main";
const MAX_AUDIO_BYTES = 15 * 1024 * 1024;
const MAX_TEXT = 5000;
const MAX_AUTHOR = 40;
const DEFAULT_CATEGORIES = ["文案", "工作", "生活复盘", "读书笔记", "其他"];
const MAX_CATEGORIES = 20;
const MAX_CATEGORY = 12;
const AUDIO_TYPES = {
  m4a: "audio/mp4", webm: "audio/webm", ogg: "audio/ogg", mp3: "audio/mpeg",
  wav: "audio/wav", aac: "audio/aac", caf: "audio/x-caf",
};

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export default {
  async fetch(request, env, ctx) {
    const cors = corsHeaders(request, env);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    let res;
    try {
      if (!env.GITHUB_TOKEN || !env.DATA_REPO) throw new HttpError(500, "服务器还没设置好 GITHUB_TOKEN 或 DATA_REPO。");
      res = await route(request, env, ctx);
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      const message = e instanceof HttpError ? e.message : "服务器出错了，请稍后再试。";
      if (status >= 500) console.error(e && e.stack || e);
      res = json({ error: message }, status);
    }
    const out = new Response(res.body, res);
    for (const [k, v] of Object.entries(cors)) out.headers.set(k, v);
    return out;
  },
};

function corsHeaders(request, env) {
  const origin = request.headers.get("Origin") || "";
  const allowed = (env.ALLOWED_ORIGIN || "").split(",").map((s) => s.trim()).filter(Boolean);
  return {
    "Access-Control-Allow-Origin": !allowed.length ? "*" : allowed.includes(origin) ? origin : allowed[0],
    "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Admin-Key, Range",
    "Access-Control-Expose-Headers": "Content-Range, Content-Length, Accept-Ranges",
    "Access-Control-Max-Age": "86400",
    "Cross-Origin-Resource-Policy": "cross-origin",
    "Vary": "Origin",
  };
}

async function route(request, env, ctx) {
  const url = new URL(request.url);
  const parts = url.pathname.replace(/\/+$/, "").split("/").filter(Boolean);
  if (parts[0] !== "api") throw new HttpError(404, "没有这个地址。");
  const m = request.method;

  if (parts[1] === "lines" && parts.length === 2) {
    if (m === "GET") return json(await listAll(env));
    if (m === "POST") return json({ line: await createLine(env, await body(request), isAdmin(request, env)) }, 201);
  }
  if (parts[1] === "lines" && parts.length === 4 && parts[3] === "ai" && m === "POST") {
    return json({ line: await aiForLine(env, checkId(parts[2]), await body(request), isAdmin(request, env)) });
  }
  if (parts[1] === "lines" && parts.length === 3) {
    const id = checkId(parts[2]);
    requireAdmin(request, env);
    if (m === "PATCH") return json({ line: await updateLine(env, id, await body(request)) });
    if (m === "DELETE") { await deleteLine(env, id); return json({ ok: true }); }
  }
  if (parts[1] === "audio" && parts.length === 3 && m === "GET") return stored(request, env, ctx, "audio", parts[2]);
  if (parts[1] === "image" && parts.length === 3 && m === "GET") return stored(request, env, ctx, "images", parts[2]);
  if (parts[1] === "transcribe" && parts.length === 2 && m === "POST") return json(await transcribe(env, await body(request)));
  if (parts[1] === "probe" && parts.length === 2 && m === "POST") return json(await probe(request, env, await body(request)));
  if (parts[1] === "admin" && parts.length === 2 && m === "GET") { requireAdmin(request, env); return json({ ok: true }); }
  if (parts[1] === "categories" && parts.length === 2 && m === "PUT") {
    requireAdmin(request, env);
    return json({ categories: await saveCategories(env, await body(request)) });
  }
  throw new HttpError(404, "没有这个地址。");
}

// ---- access ----
function isAdmin(request, env) {
  const given = request.headers.get("X-Admin-Key") || "";
  const want = env.ADMIN_KEY || "";
  if (!want || given.length !== want.length) return false;
  let diff = 0;
  for (let i = 0; i < want.length; i++) diff |= given.charCodeAt(i) ^ want.charCodeAt(i);
  return diff === 0;
}
function requireAdmin(request, env) {
  if (!isAdmin(request, env)) throw new HttpError(403, "管理口令不对，只有本子的主人能编辑和删除。");
}
function checkId(id) {
  if (!/^[a-z0-9]{6,40}$/.test(id)) throw new HttpError(400, "编号格式不对。");
  return id;
}
async function body(request) {
  try { return await request.json(); } catch (_) { throw new HttpError(400, "请求内容看不懂。"); }
}

// ---- GitHub ----
function gh(env, path, init = {}) {
  return fetch("https://api.github.com" + path, {
    ...init,
    headers: {
      Authorization: "Bearer " + env.GITHUB_TOKEN,
      "User-Agent": "wenan-luyinben",
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(init.headers || {}),
    },
  });
}
async function ghFail(res, what) {
  const text = await res.text().catch(() => "");
  console.error(what, res.status, text.slice(0, 500));
  if (res.status === 401 || res.status === 403) throw new HttpError(502, "GitHub 拒绝了服务器的密钥，请检查 GITHUB_TOKEN 的权限。");
  if (res.status === 404) throw new HttpError(502, "找不到数据仓库，请检查 DATA_REPO。");
  throw new HttpError(502, "GitHub 暂时出错了（" + res.status + "），请稍后再试。");
}
const repoPath = (env, path) => "/repos/" + env.DATA_REPO + "/contents/" + path;

async function listAll(env) {
  const [owner, name] = env.DATA_REPO.split("/");
  const res = await gh(env, "/graphql", {
    method: "POST",
    body: JSON.stringify({
      query: "query($owner:String!,$name:String!,$expr:String!,$cfg:String!){repository(owner:$owner,name:$name){object(expression:$expr){... on Tree{entries{name object{... on Blob{text}}}}} config:object(expression:$cfg){... on Blob{text}}}}",
      variables: { owner, name, expr: BRANCH + ":lines", cfg: BRANCH + ":config/categories.json" },
    }),
  });
  if (!res.ok) await ghFail(res, "list");
  const data = await res.json();
  if (data.errors && !data.data?.repository) throw new HttpError(502, "读取数据仓库失败，请检查 DATA_REPO 和密钥权限。");
  let categories = DEFAULT_CATEGORIES;
  try {
    const parsed = JSON.parse(data.data?.repository?.config?.text || "null");
    if (parsed && Array.isArray(parsed.categories) && parsed.categories.length) categories = parsed.categories;
  } catch (_) {}
  const tree = data.data?.repository?.object;
  const lines = [];
  for (const e of (tree && tree.entries) || []) {
    if (!e.name.endsWith(".json") || !e.object || typeof e.object.text !== "string") continue;
    try { lines.push(JSON.parse(e.object.text)); } catch (_) {}
  }
  return { lines: lines.sort((a, b) => (a.no || 0) - (b.no || 0)), categories };
}
async function listLines(env) {
  return (await listAll(env)).lines;
}

async function saveCategories(env, input) {
  const seen = new Set();
  const categories = [];
  for (const raw of Array.isArray(input.categories) ? input.categories : []) {
    const c = typeof raw === "string" ? raw.trim() : "";
    if (!c || seen.has(c)) continue;
    if (c.length > MAX_CATEGORY) throw new HttpError(400, "分类名“" + c + "”太长了（最多 " + MAX_CATEGORY + " 个字）。");
    seen.add(c);
    categories.push(c);
  }
  if (!categories.length) throw new HttpError(400, "至少要留一个分类。");
  if (categories.length > MAX_CATEGORIES) throw new HttpError(400, "分类太多了（最多 " + MAX_CATEGORIES + " 个）。");
  const path = "config/categories.json";
  const sha = await shaOf(env, path);
  await putFile(env, path, b64FromUtf8(JSON.stringify({ categories }, null, 2) + "\n"), "更新分类：" + categories.join("、"), sha || undefined);
  return categories;
}

async function readJson(env, path) {
  const res = await gh(env, repoPath(env, path) + "?ref=" + BRANCH);
  if (res.status === 404) return null;
  if (!res.ok) await ghFail(res, "read " + path);
  const file = await res.json();
  return { sha: file.sha, data: JSON.parse(utf8FromB64(file.content.replace(/\n/g, ""))) };
}
async function shaOf(env, path) {
  const res = await gh(env, repoPath(env, path) + "?ref=" + BRANCH, { headers: { Accept: "application/vnd.github.object+json" } });
  if (res.status === 404) return null;
  if (!res.ok) await ghFail(res, "sha " + path);
  return (await res.json()).sha;
}
// Several people may save at once; GitHub answers 409 when the branch moved underneath a write.
async function putFile(env, path, b64, message, sha) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await gh(env, repoPath(env, path), {
      method: "PUT",
      body: JSON.stringify({ message, content: b64, branch: BRANCH, ...(sha ? { sha } : {}) }),
    });
    if (res.ok) return;
    if (res.status === 409 && attempt < 3) { await sleep(300 * (attempt + 1)); continue; }
    await ghFail(res, "put " + path);
  }
}
async function deleteFile(env, path, message) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const sha = await shaOf(env, path);
    if (!sha) return;
    const res = await gh(env, repoPath(env, path), {
      method: "DELETE",
      body: JSON.stringify({ message, sha, branch: BRANCH }),
    });
    if (res.ok || res.status === 404) return;
    if (res.status === 409 && attempt < 3) { await sleep(300 * (attempt + 1)); continue; }
    await ghFail(res, "delete " + path);
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- lines ----
const pad = (n) => String(n).padStart(3, "0");
const randomId = () => crypto.randomUUID().replace(/-/g, "").slice(0, 16);
function cleanText(s, max, what) {
  const t = typeof s === "string" ? s.trim() : "";
  if (t.length > max) throw new HttpError(400, what + "太长了（最多 " + max + " 个字）。");
  return t;
}

async function storeAudio(env, id, voice, no) {
  if (!voice || typeof voice.data !== "string") throw new HttpError(400, "录音内容缺失。");
  const type = String(voice.type || "").split(";")[0].toLowerCase();
  const ext = Object.keys(AUDIO_TYPES).find((k) => AUDIO_TYPES[k] === type) || (type === "audio/x-m4a" ? "m4a" : null);
  if (!ext) throw new HttpError(400, "这种录音格式存不了。");
  const bytes = Math.floor(voice.data.length * 3 / 4);
  if (bytes > MAX_AUDIO_BYTES) throw new HttpError(413, "录音太大了（最多 15MB）。");
  const file = id + "-" + randomId().slice(0, 6) + "." + ext;
  await putFile(env, "audio/" + file, voice.data, "第 " + pad(no) + " 条的录音");
  return {
    file,
    type: AUDIO_TYPES[ext],
    dur: Number.isFinite(voice.dur) ? Math.round(voice.dur * 1000) / 1000 : null,
    text: cleanText(voice.text, MAX_TEXT, "录音文字"),
  };
}

async function createLine(env, input, admin) {
  const text = cleanText(input.text, MAX_TEXT, "文案");
  if (!text) throw new HttpError(400, "先写一句话再收下。");
  const author = cleanText(input.author, MAX_AUTHOR, "名字");
  if (!author && !admin) throw new HttpError(400, "请先填上你的名字。");
  const category = cleanText(input.category, MAX_CATEGORY, "分类") || DEFAULT_CATEGORIES[0];
  // Only the owner may carry over ids, numbers and dates, when importing a backup.
  const id = admin && typeof input.id === "string" && /^[a-z0-9]{6,40}$/.test(input.id) ? input.id : randomId();
  const existing = await listLines(env);
  if (existing.some((l) => l.id === id)) throw new HttpError(409, "这一条已经在本子里了。");
  const no = admin && Number.isInteger(input.no) && input.no > 0 && !existing.some((l) => l.no === input.no)
    ? input.no
    : existing.reduce((mx, l) => Math.max(mx, l.no || 0), 0) + 1;
  const createdAt = admin && Number.isFinite(input.createdAt) ? input.createdAt : Date.now();
  const voice = input.voice ? await storeAudio(env, id, input.voice, no) : null;
  const line = { id, no, text, author, category, createdAt, voice };
  await putFile(env, "lines/" + id + ".json", b64FromUtf8(JSON.stringify(line, null, 2) + "\n"),
    "新增第 " + pad(no) + " 条" + (author ? "（" + author + "）" : ""));
  return line;
}

async function updateLine(env, id, input) {
  const cur = await readJson(env, "lines/" + id + ".json");
  if (!cur) throw new HttpError(404, "这一条已经不在了。");
  const line = cur.data;
  const oldFile = line.voice && line.voice.file;
  if (typeof input.text === "string") {
    line.text = cleanText(input.text, MAX_TEXT, "文案");
    if (!line.text) throw new HttpError(400, "文案不能是空的。");
  }
  if (typeof input.category === "string") line.category = cleanText(input.category, MAX_CATEGORY, "分类") || DEFAULT_CATEGORIES[0];
  if ("voice" in input) line.voice = input.voice ? await storeAudio(env, id, input.voice, line.no) : null;
  if (typeof input.voiceText === "string" && line.voice) line.voice.text = cleanText(input.voiceText, MAX_TEXT, "录音文字");
  await putFile(env, "lines/" + id + ".json", b64FromUtf8(JSON.stringify(line, null, 2) + "\n"), "修改第 " + pad(line.no) + " 条", cur.sha);
  if (oldFile && (!line.voice || line.voice.file !== oldFile)) await deleteFile(env, "audio/" + oldFile, "删除第 " + pad(line.no) + " 条的旧录音");
  return line;
}

async function deleteLine(env, id) {
  const cur = await readJson(env, "lines/" + id + ".json");
  if (!cur) return;
  await deleteFile(env, "lines/" + id + ".json", "删除第 " + pad(cur.data.no) + " 条");
  if (cur.data.voice && cur.data.voice.file) await deleteFile(env, "audio/" + cur.data.voice.file, "删除第 " + pad(cur.data.no) + " 条的录音");
  const img = cur.data.ai && cur.data.ai.image && cur.data.ai.image.file;
  if (img) await deleteFile(env, "images/" + img, "删除第 " + pad(cur.data.no) + " 条的配图");
}

// ---- speech to text ----
// The page sends 16 kHz WAV pieces of at most ~25 s. The prompt keeps the output in simplified
// Chinese with punctuation; when the model just echoes it back (silence), nothing was said.
const STT_MODEL = "@cf/openai/whisper-large-v3-turbo";
const STT_PROMPT = "以下是普通话的句子，使用简体中文和标点符号。";
const MAX_PIECE_B64 = 2 * 1024 * 1024;
async function transcribe(env, input) {
  if (!env.AI) throw new HttpError(501, "服务器还没开语音识别。");
  const audio = typeof input.audio === "string" ? input.audio : "";
  if (!audio) throw new HttpError(400, "没收到录音。");
  if (audio.length > MAX_PIECE_B64) throw new HttpError(413, "这一段录音太长了。");
  let out;
  try {
    out = await env.AI.run(STT_MODEL, { audio, task: "transcribe", language: "zh", initial_prompt: STT_PROMPT });
  } catch (e) {
    console.error("stt", e && e.stack || e);
    throw new HttpError(502, "语音识别暂时出错了，请稍后再试。");
  }
  let text = String((out && out.text) || "").trim();
  if (text === STT_PROMPT || STT_PROMPT.includes(text)) text = "";
  return { text };
}

// ---- AI ----
// Text comes from gpt-oss-120b (fast, the best Chinese in our tests) with llama-4-scout as a
// fallback; pictures from flux-1-schnell. Results are stored on the line so everyone sees them.
const TEXT_MODEL = "@cf/openai/gpt-oss-120b";
const FALLBACK_TEXT_MODEL = "@cf/meta/llama-4-scout-17b-16e-instruct";
const IMAGE_MODEL = "@cf/black-forest-labs/flux-1-schnell";
const AI_KINDS = {
  summary: "用两三句话概括下面这段内容的核心意思。只输出概括本身，用简体中文。",
  minutes: "把下面这段录音内容整理成会议纪要，用简体中文。分“要点”“决定”“待办”三部分，每部分用短横线列表；待办尽量写清负责人和时间，原文没有的就不写，不要编造。只输出纪要本身。",
  prompt: "下面是一段口述的想法。把它整理成一份可以直接交给 AI 使用的提示词，用简体中文，包含：角色、背景、任务、具体要求、输出格式。保留原意，补全必要的约束，不要编造事实。只输出提示词本身。",
  copy: "下面是一段文案或想法。保留原意，改写出 3 个不同风格的短文案（适合发朋友圈或做视频口播），每个不超过 60 字，用“1.”“2.”“3.”编号。只输出这 3 条。",
};
const MAX_AI_SOURCE = 8000;

function sourceText(line) {
  const parts = [line.text || ""];
  const heard = line.voice && line.voice.text;
  if (heard && heard.trim() !== (line.text || "").trim()) parts.push("录音原话：" + heard);
  return parts.join("\n\n").slice(0, MAX_AI_SOURCE);
}

async function chat(env, system, user) {
  try {
    const res = await env.AI.run(TEXT_MODEL, {
      input: [{ role: "system", content: system }, { role: "user", content: user }],
      reasoning: { effort: "low" },
    });
    const msg = (res && Array.isArray(res.output) ? res.output : []).find((o) => o.type === "message");
    const text = (res && res.output_text) || (msg ? (msg.content || []).map((c) => c.text || "").join("") : "");
    if (text.trim()) return text.trim();
  } catch (e) {
    console.error("chat", TEXT_MODEL, e && e.stack || e);
  }
  const res = await env.AI.run(FALLBACK_TEXT_MODEL, {
    messages: [{ role: "system", content: system }, { role: "user", content: user }],
    max_tokens: 1500,
  });
  return String((res && (res.response || res.choices?.[0]?.message?.content)) || "").trim();
}

async function writeAi(env, kind, text) {
  if (!AI_KINDS[kind]) throw new HttpError(400, "不认识这种整理方式。");
  if (!text.trim()) throw new HttpError(400, "这一条没有可以整理的文字。");
  const out = await chat(env, "你是一个细心的中文写作助手。" + AI_KINDS[kind], text);
  if (!out) throw new HttpError(502, "AI 没有写出内容，请再试一次。");
  return out;
}

async function makeImage(env, text) {
  if (!text.trim()) throw new HttpError(400, "这一条没有可以配图的文字。");
  let prompt = await chat(env,
    "You write prompts for an image model. Read the Chinese text and describe ONE picture that fits its mood. " +
    "English, under 60 words, concrete scene, lighting and style; no words, letters or captions in the picture. Output the prompt only.",
    text.slice(0, 2000));
  prompt = prompt.replace(/^["'\s]+|["'\s]+$/g, "").slice(0, 600) || "a calm minimal illustration, soft light";
  const res = await env.AI.run(IMAGE_MODEL, { prompt, steps: 6 });
  const b64 = res && typeof res.image === "string" ? res.image : "";
  if (!b64) throw new HttpError(502, "配图没有生成出来，请再试一次。");
  return { prompt, b64 };
}

async function aiForLine(env, id, input, admin) {
  if (!env.AI) throw new HttpError(501, "服务器还没开 AI。");
  const kind = String(input.kind || "");
  if (kind !== "image" && !AI_KINDS[kind]) throw new HttpError(400, "不认识这种整理方式。");
  const cur = await readJson(env, "lines/" + id + ".json");
  if (!cur) throw new HttpError(404, "这一条已经不在了。");
  const line = cur.data;
  line.ai = line.ai || {};
  // Anyone can fill in a missing result; replacing one is for the owner.
  if (line.ai[kind] && !admin) throw new HttpError(403, "已经整理过了，只有本子的主人能重新生成。");
  const old = line.ai[kind];
  let label;
  try {
    if (kind === "image") {
      const pic = await makeImage(env, sourceText(line));
      const file = id + "-" + randomId().slice(0, 6) + ".jpg";
      await putFile(env, "images/" + file, pic.b64, "第 " + pad(line.no) + " 条的配图");
      line.ai.image = { file, prompt: pic.prompt, at: Date.now() };
      label = "配图";
    } else {
      line.ai[kind] = { text: await writeAi(env, kind, sourceText(line)), at: Date.now() };
      label = { summary: "总结", minutes: "会议纪要", prompt: "提示词", copy: "改写文案" }[kind];
    }
  } catch (e) {
    if (e instanceof HttpError) throw e;
    console.error("ai", kind, e && e.stack || e);
    throw new HttpError(502, "AI 暂时出错了，请稍后再试。");
  }
  // Re-read so a save made meanwhile (an edit, another AI result) is not lost.
  const fresh = await readJson(env, "lines/" + id + ".json");
  if (!fresh) throw new HttpError(404, "这一条已经不在了。");
  fresh.data.ai = Object.assign({}, fresh.data.ai, { [kind]: line.ai[kind] });
  await putFile(env, "lines/" + id + ".json", b64FromUtf8(JSON.stringify(fresh.data, null, 2) + "\n"), "第 " + pad(line.no) + " 条：AI " + label, fresh.sha);
  if (kind === "image" && old && old.file) await deleteFile(env, "images/" + old.file, "删除第 " + pad(line.no) + " 条的旧配图");
  return fresh.data;
}

// ---- checks ----
// Lets the "Check site" workflow try Workers AI models from inside this Worker. It only works
// while that workflow has set a one-off PROBE_KEY secret, which it deletes right after.
async function probe(request, env, input) {
  const key = request.headers.get("X-Probe-Key") || "";
  if (!env.PROBE_KEY || key !== env.PROBE_KEY) throw new HttpError(404, "没有这个地址。");
  if (!env.AI) throw new HttpError(501, "服务器还没开 Workers AI。");
  const out = [];
  for (const t of (Array.isArray(input.tasks) ? input.tasks : []).slice(0, 6)) {
    const started = Date.now();
    try {
      if (t.kind === "image") {
        const pic = await makeImage(env, String(t.text || ""));
        out.push({ model: "task:image", ok: true, ms: Date.now() - started, result: { prompt: pic.prompt, image_b64_len: pic.b64.length } });
      } else {
        out.push({ model: "task:" + t.kind, ok: true, ms: Date.now() - started, result: await writeAi(env, t.kind, String(t.text || "")) });
      }
    } catch (e) {
      out.push({ model: "task:" + t.kind, ok: false, ms: Date.now() - started, error: String(e && e.message || e).slice(0, 300) });
    }
  }
  for (const r of (Array.isArray(input.runs) ? input.runs : []).slice(0, 8)) {
    const t = Date.now();
    try {
      const res = await env.AI.run(String(r.model), r.input || {});
      let shown;
      if (res instanceof ReadableStream) shown = { stream: true, bytes: (await new Response(res).arrayBuffer()).byteLength };
      else if (res && typeof res.image === "string") shown = { image_b64_len: res.image.length };
      else shown = JSON.stringify(res).slice(0, 1500);
      out.push({ model: r.model, ok: true, ms: Date.now() - t, result: shown });
    } catch (e) {
      out.push({ model: r.model, ok: false, ms: Date.now() - t, error: String(e && e.message || e).slice(0, 300) });
    }
  }
  return { results: out };
}

// ---- audio ----
// Recordings never change under a file name, so they are cached for good. Byte ranges are
// answered here because Safari will not play audio from a server that ignores them.
const FILE_TYPES = { ...AUDIO_TYPES, jpg: "image/jpeg", png: "image/png" };
async function stored(request, env, ctx, dir, file) {
  const mt = /^([a-z0-9]{6,40}-[a-z0-9]{6})\.([a-z0-9]{2,4})$/.exec(file);
  const type = mt && FILE_TYPES[mt[2]];
  if (!type || (dir === "audio") !== Boolean(AUDIO_TYPES[mt[2]])) throw new HttpError(404, "没有这个文件。");
  const cache = typeof caches !== "undefined" ? caches.default : null;
  const key = new Request(new URL(request.url).origin + "/api/" + (dir === "audio" ? "audio" : "image") + "/" + file);
  let full = cache ? await cache.match(key) : null;
  if (!full) {
    const res = await gh(env, repoPath(env, dir + "/" + file) + "?ref=" + BRANCH, { headers: { Accept: "application/vnd.github.raw" } });
    if (res.status === 404) throw new HttpError(404, "没有这个文件。");
    if (!res.ok) await ghFail(res, dir + " " + file);
    full = new Response(await res.arrayBuffer(), {
      headers: { "Content-Type": type, "Cache-Control": "public, max-age=31536000, immutable" },
    });
    if (cache) ctx.waitUntil(cache.put(key, full.clone()));
  }
  const bytes = new Uint8Array(await full.arrayBuffer());
  const headers = {
    "Content-Type": type,
    "Cache-Control": "public, max-age=31536000, immutable",
    "Accept-Ranges": "bytes",
  };
  const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.get("Range") || "");
  if (range && (range[1] || range[2])) {
    let start = range[1] ? Number(range[1]) : Math.max(0, bytes.length - Number(range[2]));
    let end = range[1] && range[2] ? Math.min(Number(range[2]), bytes.length - 1) : bytes.length - 1;
    if (start >= bytes.length || start > end) {
      return new Response(null, { status: 416, headers: { ...headers, "Content-Range": "bytes */" + bytes.length } });
    }
    return new Response(bytes.slice(start, end + 1), {
      status: 206,
      headers: { ...headers, "Content-Range": "bytes " + start + "-" + end + "/" + bytes.length, "Content-Length": String(end - start + 1) },
    });
  }
  return new Response(bytes, { headers: { ...headers, "Content-Length": String(bytes.length) } });
}

// ---- helpers ----
function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } });
}
function b64FromUtf8(s) {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
function utf8FromB64(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}
