// Turns recordings into text with SenseVoice (FunAudioLLM, Alibaba), running in the browser
// through the official sherpa-onnx WebAssembly build that the "Fetch SenseVoice runtime"
// workflow stores in asr/. The model package is downloaded once and kept in the Cache API.
const BASE = "asr/";
const RATE = 16000;
let ready = null;
let recognizer = null;

async function fetchPart(cache, name, onBytes) {
  const url = new URL(BASE + name, self.location.href).href;
  if (cache) {
    try {
      const hit = await cache.match(url);
      if (hit) {
        const buf = await hit.arrayBuffer();
        onBytes(buf.byteLength);
        return new Uint8Array(buf);
      }
    } catch (_) {}
  }
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error("download " + res.status);
  const reader = res.body.getReader();
  const chunks = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    got += value.byteLength;
    onBytes(value.byteLength);
  }
  const out = new Uint8Array(got);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.byteLength; }
  if (cache) { try { await cache.put(url, new Response(out)); } catch (_) {} }
  return out;
}

function init() {
  if (ready) return ready;
  ready = (async () => {
    if (!self.crossOriginIsolated) throw new Error("NOT_ISOLATED");
    const manifest = await (await fetch(BASE + "manifest.json", { cache: "no-cache" })).json();
    const cacheName = "sensevoice-" + manifest.asset;
    let cache = null;
    try {
      cache = await caches.open(cacheName);
      for (const k of await caches.keys()) if (k.startsWith("sensevoice-") && k !== cacheName) caches.delete(k);
    } catch (_) {}

    const data = new Uint8Array(manifest.size);
    let offset = 0, loaded = 0, lastPost = 0;
    for (const part of manifest.parts) {
      const bytes = await fetchPart(cache, part, (n) => {
        loaded += n;
        const now = Date.now();
        if (now - lastPost > 200) { lastPost = now; self.postMessage({ type: "progress", loaded, total: manifest.size }); }
      });
      data.set(bytes, offset);
      offset += bytes.byteLength;
    }
    if (offset !== manifest.size) throw new Error("模型文件不完整");
    self.postMessage({ type: "loading" });

    await new Promise((resolve, reject) => {
      self.Module = {
        locateFile: (path) => BASE + path,
        // Thread workers must load the sherpa-onnx script, not this worker.
        mainScriptUrlOrBlob: new URL(BASE + "sherpa-onnx-wasm-main-vad-asr.js", self.location.href).href,
        getPreloadedPackage: () => data.buffer,
        onRuntimeInitialized: resolve,
        onAbort: (what) => reject(new Error("转写程序启动失败：" + what)),
        print: () => {},
        printErr: () => {},
        setStatus: () => {},
      };
      try { importScripts(BASE + "sherpa-onnx-wasm-main-vad-asr.js"); } catch (e) { reject(e); }
    });
    importScripts(BASE + "sherpa-onnx-asr.js");
    recognizer = new OfflineRecognizer({
      modelConfig: {
        debug: 0,
        tokens: "./tokens.txt",
        senseVoice: { model: "./sense-voice.onnx", language: "zh", useInverseTextNormalization: 1 },
      },
    }, self.Module);
  })();
  ready.catch(() => { ready = null; });
  return ready;
}

// SenseVoice works best on clips under ~30 s: cut long recordings at the quietest moment
// between 15 s and 25 s, and pad each piece with a little silence so short phrases are heard.
function pieces(x) {
  const MAX = 25 * RATE, MIN = 15 * RATE, WIN = RATE / 10;
  const out = [];
  let start = 0;
  while (x.length - start > MAX) {
    let best = start + 20 * RATE, bestE = Infinity;
    for (let p = start + MIN; p + WIN < start + MAX; p += WIN / 2) {
      let e = 0;
      for (let i = p; i < p + WIN; i++) e += x[i] * x[i];
      if (e < bestE) { bestE = e; best = p + WIN / 2; }
    }
    out.push(x.subarray(start, best));
    start = best;
  }
  out.push(x.subarray(start));
  return out;
}
function padded(x) {
  const pad = Math.round(0.3 * RATE);
  const out = new Float32Array(x.length + 2 * pad);
  out.set(x, pad);
  return out;
}

function transcribe(samples) {
  let text = "";
  for (const piece of pieces(samples)) {
    const stream = recognizer.createStream();
    stream.acceptWaveform(RATE, padded(piece));
    recognizer.decode(stream);
    const result = recognizer.getResult(stream);
    stream.free();
    text += (result && result.text) || "";
  }
  return text.trim();
}

self.onmessage = async (ev) => {
  const { id, audio } = ev.data;
  try {
    const first = !recognizer;
    await init();
    if (first) self.postMessage({ type: "ready" });
    self.postMessage({ type: "working", id });
    self.postMessage({ type: "done", id, text: transcribe(audio) });
  } catch (e) {
    self.postMessage({ type: "error", id, message: String((e && e.message) || e) });
  }
};
