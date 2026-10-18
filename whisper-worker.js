// Runs Whisper in the browser with transformers.js, off the main thread.
// The model is downloaded once, then cached by the browser and used offline.
import { pipeline, env } from "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1";

const MODEL = "Xenova/whisper-base";
// huggingface.co first; hf-mirror.com when it cannot be reached (e.g. from mainland China).
const HOSTS = ["https://huggingface.co/", "https://hf-mirror.com/"];

env.allowLocalModels = false;
let asr = null;

async function load() {
  const files = {};
  const progress = (p) => {
    if (p.status === "progress" && p.file) {
      files[p.file] = { loaded: p.loaded || 0, total: p.total || 0 };
      let loaded = 0, total = 0;
      for (const f of Object.values(files)) { loaded += f.loaded; total += f.total; }
      self.postMessage({ type: "progress", loaded, total });
    }
  };
  let lastErr = null;
  for (const host of HOSTS) {
    env.remoteHost = host;
    try {
      return await pipeline("automatic-speech-recognition", MODEL, { progress_callback: progress });
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

self.onmessage = async (ev) => {
  const { id, audio } = ev.data;
  try {
    if (!asr) {
      self.postMessage({ type: "loading" });
      asr = await load();
      self.postMessage({ type: "ready" });
    }
    self.postMessage({ type: "working", id });
    const out = await asr(audio, { language: "chinese", task: "transcribe", chunk_length_s: 30, stride_length_s: 5 });
    self.postMessage({ type: "done", id, text: (out && out.text || "").trim() });
  } catch (e) {
    self.postMessage({ type: "error", id, message: String(e && e.message || e) });
  }
};
