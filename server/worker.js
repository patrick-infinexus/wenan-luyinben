// Cloudflare Worker for 文案录音本.
// It keeps the GitHub token away from the page and stores the shared notebook in a
// private GitHub repository: lines/<id>.json for each entry, audio/<file> for recordings.
//
// Settings (Cloudflare dashboard → this Worker → Settings → Variables and secrets):
//   GITHUB_TOKEN    secret. Fine-grained token with Contents: Read and write on DATA_REPO only.
//   ADMIN_KEY       secret. The owner's passphrase; it unlocks editing and deleting.
//   DATA_REPO       text, e.g. "patrick-infinexus/wenan-luyinben-data".
//   ALLOWED_ORIGIN  text, e.g. "https://patrick-infinexus.github.io". Leave unset to allow any site.

const BRANCH = "main";
const MAX_AUDIO_BYTES = 15 * 1024 * 1024;
const MAX_TEXT = 5000;
const MAX_AUTHOR = 40;
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
    "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
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
    if (m === "GET") return json({ lines: await listLines(env) });
    if (m === "POST") return json({ line: await createLine(env, await body(request), isAdmin(request, env)) }, 201);
  }
  if (parts[1] === "lines" && parts.length === 3) {
    const id = checkId(parts[2]);
    requireAdmin(request, env);
    if (m === "PATCH") return json({ line: await updateLine(env, id, await body(request)) });
    if (m === "DELETE") { await deleteLine(env, id); return json({ ok: true }); }
  }
  if (parts[1] === "audio" && parts.length === 3 && m === "GET") return audio(request, env, ctx, parts[2]);
  if (parts[1] === "admin" && parts.length === 2 && m === "GET") { requireAdmin(request, env); return json({ ok: true }); }
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

async function listLines(env) {
  const [owner, name] = env.DATA_REPO.split("/");
  const res = await gh(env, "/graphql", {
    method: "POST",
    body: JSON.stringify({
      query: "query($owner:String!,$name:String!,$expr:String!){repository(owner:$owner,name:$name){object(expression:$expr){... on Tree{entries{name object{... on Blob{text}}}}}}}",
      variables: { owner, name, expr: BRANCH + ":lines" },
    }),
  });
  if (!res.ok) await ghFail(res, "list");
  const data = await res.json();
  if (data.errors && !data.data?.repository) throw new HttpError(502, "读取数据仓库失败，请检查 DATA_REPO 和密钥权限。");
  const tree = data.data?.repository?.object;
  if (!tree || !tree.entries) return [];
  const lines = [];
  for (const e of tree.entries) {
    if (!e.name.endsWith(".json") || !e.object || typeof e.object.text !== "string") continue;
    try { lines.push(JSON.parse(e.object.text)); } catch (_) {}
  }
  return lines.sort((a, b) => (a.no || 0) - (b.no || 0));
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
  // Only the owner may carry over ids, numbers and dates, when importing a backup.
  const id = admin && typeof input.id === "string" && /^[a-z0-9]{6,40}$/.test(input.id) ? input.id : randomId();
  const existing = await listLines(env);
  if (existing.some((l) => l.id === id)) throw new HttpError(409, "这一条已经在本子里了。");
  const no = admin && Number.isInteger(input.no) && input.no > 0 && !existing.some((l) => l.no === input.no)
    ? input.no
    : existing.reduce((mx, l) => Math.max(mx, l.no || 0), 0) + 1;
  const createdAt = admin && Number.isFinite(input.createdAt) ? input.createdAt : Date.now();
  const voice = input.voice ? await storeAudio(env, id, input.voice, no) : null;
  const line = { id, no, text, author, createdAt, voice };
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
}

// ---- audio ----
// Recordings never change under a file name, so they are cached for good. Byte ranges are
// answered here because Safari will not play audio from a server that ignores them.
async function audio(request, env, ctx, file) {
  const mt = /^([a-z0-9]{6,40}-[a-z0-9]{6})\.([a-z0-9]{2,4})$/.exec(file);
  if (!mt || !AUDIO_TYPES[mt[2]]) throw new HttpError(404, "没有这段录音。");
  const cache = typeof caches !== "undefined" ? caches.default : null;
  const key = new Request(new URL(request.url).origin + "/api/audio/" + file);
  let full = cache ? await cache.match(key) : null;
  if (!full) {
    const res = await gh(env, repoPath(env, "audio/" + file) + "?ref=" + BRANCH, { headers: { Accept: "application/vnd.github.raw" } });
    if (res.status === 404) throw new HttpError(404, "没有这段录音。");
    if (!res.ok) await ghFail(res, "audio " + file);
    full = new Response(await res.arrayBuffer(), {
      headers: { "Content-Type": AUDIO_TYPES[mt[2]], "Cache-Control": "public, max-age=31536000, immutable" },
    });
    if (cache) ctx.waitUntil(cache.put(key, full.clone()));
  }
  const bytes = new Uint8Array(await full.arrayBuffer());
  const headers = {
    "Content-Type": AUDIO_TYPES[mt[2]],
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
