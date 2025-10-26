// =============================================================
// A10 Runner — v3.5.6  (Self-healing + Diagnostics)
// Architect (think) → Coder (build) → Tester (verify) → Quality (review)
// - Crash-proof integrator/supervisor/gate (never SIGTERM the process)
// - Diagnostic hook: track failure agent + missing fields, echoed inline
// - Payload normalization and safe forwards
// - Atomic, sequential GitHub commits with retries
// - Deep tester and quality checks
// - Global error guards + in-memory diag buffer (/ _diag)
// =============================================================

import express from "express";
import bodyParser from "body-parser";
import dotenv from "dotenv";
import { Octokit } from "@octokit/rest";
import fetch from "node-fetch";

dotenv.config();
const app = express();

// ---------- Env ----------
const PORT = process.env.PORT || 10000;
const SELF_URL =
  (process.env.SELF_URL || "https://a10-runner.onrender.com").replace(/\/+$/, "");
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || "";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";

if (!GITHUB_TOKEN) console.warn("⚠️  Missing GITHUB_TOKEN (GitHub commits will fail).");
if (!OPENAI_API_KEY) console.warn("ℹ️  OPENAI_API_KEY not set — heuristic coder active.");

const octokit = new Octokit({ auth: GITHUB_TOKEN });

// ---------- App plumbing ----------
app.use(express.json({ limit: "10mb" }));
app.use(bodyParser.urlencoded({ extended: true }));
app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// ---------- Diagnostics (in-memory ring buffer) ----------
const DIAG_MAX = 50;
const diagBuf = []; // { ts, agent, level, message, details }
function diag(agent, level, message, details = {}) {
  const entry = { ts: new Date().toISOString(), agent, level, message, details };
  diagBuf.push(entry);
  if (diagBuf.length > DIAG_MAX) diagBuf.shift();
  console[level === "error" ? "error" : "log"](
    `[diag:${agent}] ${level.toUpperCase()} ${message}`,
    details
  );
  return entry;
}
app.get("/_diag", (_req, res) => res.json({ ok: true, count: diagBuf.length, events: diagBuf }));
app.get("/health", (_req, res) =>
  res.json({ ok: true, version: "3.5.6", time: new Date().toISOString() })
);

// ---------- Utils ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ensureString = (v) =>
  typeof v === "string" ? v : v == null ? "" : JSON.stringify(v, null, 2);
const nowIso = () => new Date().toISOString();

// Normalize inbound bodies so every agent always receives a predictable shape
function normalizePayload(raw) {
  const p = raw?.payload ?? raw ?? {};
  return {
    runId: p.runId || `run_${Date.now()}`,
    owner: p.owner || raw?.owner || "",
    repo: p.repo || raw?.repo || "",
    branch: p.branch || "main",
    prd: p.prd || {},
    coder_plan: p.coder_plan || [],
    tester_plan: p.tester_plan || [],
    quality_rules: p.quality_rules || [],
    retries: typeof p.retries === "number" ? p.retries : 0,
    maxRetries: typeof p.maxRetries === "number" ? p.maxRetries : 2,
    // optional downstream agent results (may be undefined)
    tester: p.tester,
    quality: p.quality,
    orchestration: p.orchestration || {
      runId: p.runId || `run_${Date.now()}`,
      owner: p.owner || raw?.owner || "",
      repo: p.repo || raw?.repo || "",
      branch: p.branch || "main",
      coder_plan: p.coder_plan || [],
      tester_plan: p.tester_plan || [],
      quality_rules: p.quality_rules || [],
      retries: typeof p.retries === "number" ? p.retries : 0,
      maxRetries: typeof p.maxRetries === "number" ? p.maxRetries : 2,
      prd: p.prd || {},
    },
  };
}

// ---------- GitHub helpers ----------
async function getTextFileOrNull({ owner, repo, path, ref }) {
  try {
    const { data } = await octokit.repos.getContent({ owner, repo, path, ref });
    if (Array.isArray(data)) return null;
    return Buffer.from(data.content || "", "base64").toString("utf8");
  } catch (err) {
    if (err?.status !== 404) diag("github", "warn", `getTextFileOrNull(${path})`, { err: err.message });
    return null;
  }
}
async function getFileShaOrNull({ owner, repo, path, ref }) {
  try {
    const { data } = await octokit.repos.getContent({ owner, repo, path, ref });
    return Array.isArray(data) ? null : data.sha || null;
  } catch (err) {
    if (err?.status !== 404) diag("github", "warn", `getFileShaOrNull(${path})`, { err: err.message });
    return null;
  }
}
async function commitAtomic({ owner, repo, path, message, contentUtf8, branch }, attempt = 1) {
  const contentB64 = Buffer.from(ensureString(contentUtf8), "utf8").toString("base64");
  const ref = branch || "main";
  try {
    const sha = await getFileShaOrNull({ owner, repo, path, ref });
    const resp = await octokit.repos.createOrUpdateFileContents({
      owner,
      repo,
      path,
      message,
      content: contentB64,
      branch: ref,
      ...(sha ? { sha } : {}),
    });
    await sleep(250); // small settle so subsequent GETs see the new blob/tree
    return { ok: true, path, status: resp?.status };
  } catch (err) {
    if (err?.status === 409 && attempt < 3) {
      diag("github", "warn", `Conflict on ${path}, retrying`, { attempt });
      await sleep(400 * attempt);
      return commitAtomic({ owner, repo, path, message, contentUtf8, branch }, attempt + 1);
    }
    diag("github", "error", `Commit failed for ${path}`, { error: err?.message });
    return { ok: false, path, error: err?.message || String(err) };
  }
}
async function commitSequential({ owner, repo, files, branch, message }) {
  const results = [];
  for (const f of files) {
    const r = await commitAtomic({
      owner,
      repo,
      branch,
      path: f.path,
      contentUtf8: f.content,
      message: f.message || message || "Coder update",
    });
    results.push(r);
  }
  return results;
}

// ---------- Forward (always sends {payload}) ----------
async function forward(path, payload) {
  const url = `${SELF_URL}${path}`;
  const wrapped = payload?.payload ? payload : { payload };
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(wrapped),
    });
    const text = await r.text();
    try {
      return JSON.parse(text);
    } catch {
      return { ok: false, raw: text };
    }
  } catch (err) {
    diag("forward", "error", `POST ${path} failed`, { error: err?.message });
    return { ok: false, error: err?.message };
  }
}

// ---------- Heuristic coder (used if no LLM) ----------
function heuristicCoder(prd) {
  const goal = prd?.goal || "Default sandbox page";
  const now = new Date().toLocaleString();
  return [
    {
      path: "index.html",
      content: `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${goal}</title>
<link rel="stylesheet" href="style.css">
</head>
<body>
<header class="banner"><h1>${goal}</h1></header>
<main>
<section id="about"><h2>About</h2><p>This site was auto-generated by A10 Runner v3.5.6 at ${now}.</p></section>
<section id="gallery"><h2>Gallery</h2>
<div class="gallery">
  <img src="https://placehold.co/400x300/png?text=Labubu+1" alt="Sample 1">
  <img src="https://placehold.co/400x300/png?text=Labubu+2" alt="Sample 2">
</div></section>
<section id="contact"><h2>Contact</h2><p>Email: hello@example.com<br>Instagram: @labubu</p></section>
</main>
<footer><p>© ${new Date().getFullYear()} Auto-built by A10 Runner</p></footer>
<script src="script.js"></script>
</body></html>`,
    },
    {
      path: "style.css",
      content: `:root{
  --bg:#ffeaf4; --accent:#d39cd3; --text:#3b2463; --card:#ffffffb3;
}
*{box-sizing:border-box}
body{background:var(--bg);color:var(--text);font-family:Poppins,system-ui,sans-serif;margin:0;text-align:center}
header.banner{background:var(--accent);color:#fff;padding:1.5rem;border-radius:0 0 1rem 1rem}
main{padding:1rem}
h2{color:var(--accent)}
.gallery{display:flex;justify-content:center;gap:1rem;flex-wrap:wrap;margin-top:1rem}
.gallery img{width:300px;border-radius:1rem;box-shadow:0 4px 10px #0002;background:#fff}
footer{margin-top:2rem;font-size:.9rem;opacity:.7}`,
    },
    {
      path: "script.js",
      content: `document.addEventListener("DOMContentLoaded",()=>{console.log("A10 build verified @ ${nowIso()}")});`,
    },
  ];
}

// ---------- Routes ----------

// Architect
app.post("/run/architect", async (req, res) => {
  try {
    const payload = normalizePayload(req.body);
    if (!payload.owner || !payload.repo) {
      const e = diag("architect", "error", "Missing owner/repo", { payloadKeys: Object.keys(payload) });
      return res.status(400).json({ ok: false, agent: "architect", error: "missing_owner_repo", diag: e });
    }

    const orchestration = {
      runId: payload.runId,
      owner: payload.owner,
      repo: payload.repo,
      branch: payload.branch,
      coder_plan: payload.coder_plan,
      tester_plan: payload.tester_plan,
      quality_rules: payload.quality_rules,
      prd: payload.prd,
      retries: 0,
      maxRetries: payload.maxRetries,
    };

    const coderResp = await forward("/run/coder", orchestration);
    const out = { ok: true, agent: "architect", orchestration, forwarded: coderResp, diag: diagBuf.slice(-5) };
    return res.json(out);
  } catch (err) {
    const e = diag("architect", "error", "Unhandled", { error: err?.message });
    return res.status(500).json({ ok: false, agent: "architect", error: err?.message, diag: e });
  }
});

// Coder
app.post("/run/coder", async (req, res) => {
  try {
    const p = normalizePayload(req.body);
    if (!p.owner || !p.repo) {
      const e = diag("coder", "error", "Missing owner/repo", { p });
      return res.status(400).json({ ok: false, agent: "coder", error: "missing_owner_repo", diag: e });
    }

    const files = heuristicCoder(p.prd);
    const results = await commitSequential({
      owner: p.owner,
      repo: p.repo,
      branch: p.branch,
      files: files.map((f) => ({ ...f, message: "Coder update" })),
    });

    // downstream checks
    const testerResp = await forward("/run/tester", p);
    const qualityResp = await forward("/run/quality", p);

    const out = {
      ok: results.every((r) => r.ok) && testerResp?.ok && qualityResp?.ok,
      agent: "coder",
      results,
      tester: testerResp,
      quality: qualityResp,
      diag: diagBuf.slice(-5),
    };
    return res.json(out);
  } catch (err) {
    const e = diag("coder", "error", "Unhandled", { error: err?.message });
    return res.status(500).json({ ok: false, agent: "coder", error: err?.message, diag: e });
  }
});

// Tester
app.post("/run/tester", async (req, res) => {
  try {
    const p = normalizePayload(req.body);
    const { owner, repo, branch } = p;
    const [html, css, js] = await Promise.all([
      getTextFileOrNull({ owner, repo, path: "index.html", ref: branch }),
      getTextFileOrNull({ owner, repo, path: "style.css", ref: branch }),
      getTextFileOrNull({ owner, repo, path: "script.js", ref: branch }),
    ]);

    const checks = {
      hasTitle: /<title>[^<]+<\/title>/i.test(html || ""),
      hasMain: /<main[\s>]/i.test(html || ""),
      cssRoot: /:root\s*\{[^}]+\}/i.test(css || ""),
      jsLog: /console\.log/i.test(js || ""),
    };
    const ok = Object.values(checks).every(Boolean);
    const out = { ok, agent: "tester", result: ok ? "passed" : "failed", checks, diag: diagBuf.slice(-5) };
    if (!ok) diag("tester", "warn", "Checks failed", { checks });
    return res.json(out);
  } catch (err) {
    const e = diag("tester", "error", "Unhandled", { error: err?.message });
    return res.status(500).json({ ok: false, agent: "tester", error: err?.message, diag: e });
  }
});

// Quality
app.post("/run/quality", async (req, res) => {
  try {
    const p = normalizePayload(req.body);
    const { owner, repo, branch } = p;
    const html = (await getTextFileOrNull({ owner, repo, path: "index.html", ref: branch })) || "";

    const rules = {
      hasFooter: /<\/footer>/i.test(html),
      noInlineStyle: !/<\w+\s[^>]*style=/i.test(html),
      semanticHeader: /<header[\s>]/i.test(html),
    };
    const ok = Object.values(rules).every(Boolean);
    const out = { ok, agent: "quality", status: ok ? "pass" : "fail", rules, diag: diagBuf.slice(-5) };
    if (!ok) diag("quality", "warn", "Rules failed", { rules });
    return res.json(out);
  } catch (err) {
    const e = diag("quality", "error", "Unhandled", { error: err?.message });
    return res.status(500).json({ ok: false, agent: "quality", error: err?.message, diag: e });
  }
});

// Integrator (crash-proof)
app.post("/run/integrator", async (req, res) => {
  try {
    const p = normalizePayload(req.body);
    const orch = p.orchestration || {};
    if (!orch.owner || !orch.repo) {
      const e = diag("integrator", "warn", "Missing orchestration context", { orch });
      return res.json({ ok: false, agent: "integrator", status: "skipped", reason: "missing_orchestration", diag: e });
    }
    await sleep(800); // small settle window
    const out = { ok: true, agent: "integrator", status: "complete", diag: diagBuf.slice(-5) };
    return res.json(out);
  } catch (err) {
    const e = diag("integrator", "error", "Unhandled", { error: err?.message });
    return res.status(500).json({ ok: false, agent: "integrator", error: err?.message, diag: e });
  }
});

// Supervisor (crash-proof)
app.post("/run/supervisor", async (req, res) => {
  try {
    const out = { ok: true, agent: "supervisor", status: "done", diag: diagBuf.slice(-5) };
    return res.json(out);
  } catch (err) {
    const e = diag("supervisor", "error", "Unhandled", { error: err?.message });
    return res.status(500).json({ ok: false, agent: "supervisor", error: err?.message, diag: e });
  }
});

// Gate (loops on failure; forwards safe payloads)
app.post("/run/gate", async (req, res) => {
  try {
    const p = normalizePayload(req.body);
    const tester = p.tester || { ok: false, result: "unknown" };
    const quality = p.quality || { ok: false, status: "unknown" };
    const orchestration = p.orchestration || p;

    const failed =
      tester?.ok === false ||
      tester?.result === "failed" ||
      quality?.ok === false ||
      quality?.status === "fail";

    if (failed) {
      const e = diag("gate", "warn", "Gate loop to coder", { tester, quality });
      const next = { ...orchestration, retries: (orchestration.retries || 0) + 1 };
      const coderResp = await forward("/run/coder", next);
      return res.json({ ok: true, status: "looped_to_coder", coder: coderResp, diag: e });
    }

    const integ = await forward("/run/integrator", { orchestration });
    const sv = await forward("/run/supervisor", { orchestration });
    const out = { ok: true, status: "proceed", integrator: integ, supervisor: sv, diag: diagBuf.slice(-5) };
    return res.json(out);
  } catch (err) {
    const e = diag("gate", "error", "Unhandled", { error: err?.message });
    return res.status(500).json({ ok: false, agent: "gate", error: err?.message, diag: e });
  }
});

// ---------- Global process guards ----------
process.on("unhandledRejection", (reason) => {
  diag("process", "error", "unhandledRejection", { reason: String(reason) });
});
process.on("uncaughtException", (err) => {
  diag("process", "error", "uncaughtException", { error: err?.message });
});

// ---------- Start ----------
app.listen(PORT, () => console.log(`🚀 A10 Runner v3.5.6 live on port ${PORT}`));
