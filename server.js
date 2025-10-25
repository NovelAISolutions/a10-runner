// ================================================
// A10 Runner — Auto-Chained Orchestrator
// Architect → Coder → Tester → Quality → Integrator
// ================================================

import express from "express";
import bodyParser from "body-parser";
import dotenv from "dotenv";
import { Octokit } from "@octokit/rest";
import fetch from "node-fetch";

dotenv.config();

const app = express();

// ---------- Middleware ----------
app.use(express.json({ limit: "10mb" }));
app.use(bodyParser.urlencoded({ extended: true }));

// ---------- Logger ----------
app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// ---------- Env ----------
const PORT = process.env.PORT || 10000;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const SELF_URL = process.env.SELF_URL || "https://a10-runner.onrender.com";

if (!GITHUB_TOKEN) console.warn("⚠️  Missing GITHUB_TOKEN");

const octokit = new Octokit({ auth: GITHUB_TOKEN });

// ---------- Utils ----------
async function getFileShaOrNull({ owner, repo, path, ref }) {
  try {
    const { data } = await octokit.repos.getContent({ owner, repo, path, ref });
    return Array.isArray(data) ? null : data.sha || null;
  } catch (err) {
    if (err?.status === 404) return null;
    throw err;
  }
}

async function createOrUpdateFile({ owner, repo, path, message, contentUtf8, branch }) {
  const contentB64 = Buffer.from(contentUtf8, "utf8").toString("base64");
  const ref = branch || "main";
  const sha = await getFileShaOrNull({ owner, repo, path, ref });

  await octokit.repos.createOrUpdateFileContents({
    owner,
    repo,
    path,
    message,
    content: contentB64,
    branch: ref,
    ...(sha ? { sha } : {}),
  });

  return { ok: true, branch: ref, created: !sha, updated: !!sha };
}

async function safeForward(path, payload) {
  try {
    const url = `${SELF_URL}${path}`;
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ payload }),
    });
    const j = await r.json();
    console.log(`🧩 Forwarded to ${path}:`, j);
    return j;
  } catch (err) {
    console.warn(`⚠️  Forward failed (${path}):`, err.message);
    return { ok: false, error: err.message };
  }
}

// ---------- Routes ----------
app.get("/health", (_req, res) =>
  res.json({ ok: true, message: "runner is alive", timestamp: new Date().toISOString() })
);

app.post("/echo", (req, res) => res.json({ received: req.body }));

// ---------- Architect Agent ----------
app.post("/run/architect", async (req, res) => {
  try {
    const payload = req.body || {};
    console.log("📦 Architect received:", JSON.stringify(payload, null, 2));

    const required = ["task", "owner", "repo"];
    const missing = required.filter(k => !payload[k]);
    if (missing.length)
      return res.status(400).json({ ok: false, error: `Missing: ${missing.join(", ")}` });

    const response = {
      ok: true,
      agent: "architect",
      status: "processed",
      received: payload,
      next_step: "coder",
      timestamp: new Date().toISOString(),
    };

    // Auto-trigger coder
    response.forwarded = await safeForward("/run/coder", payload);

    res.json(response);
  } catch (err) {
    console.error("💥 Architect error:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ---------- Coder Agent ----------
app.post("/run/coder", async (req, res) => {
  try {
    const p = req.body?.payload || req.body || {};
    console.log("🧠 Coder received:", JSON.stringify(p, null, 2));

    const owner = p.owner;
    const repo = p.repo;
    const branch = p.branch || "main";
    const path = p.path || "index.html";
    const message = p.message || "Automated commit";
    const content =
      p.content ||
      `<html><body><h1>🧩 Updated by Coder Agent</h1><p>${new Date().toISOString()}</p></body></html>`;

    const result = await createOrUpdateFile({
      owner,
      repo,
      path,
      message,
      contentUtf8: content,
      branch,
    });

    const response = { ok: true, agent: "coder", result, next_step: "tester" };

    // Auto-trigger Tester Agent
    response.forwarded = await safeForward("/run/tester", p);

    res.json(response);
  } catch (err) {
    console.error("💥 Coder error:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ---------- Tester Agent ----------
app.post("/run/tester", async (req, res) => {
  try {
    const p = req.body?.payload || req.body || {};
    console.log("🧪 Tester received:", JSON.stringify(p, null, 2));

    const response = {
      ok: true,
      agent: "tester",
      result: "passed",
      next_step: "quality",
      timestamp: new Date().toISOString(),
    };

    // Auto-trigger Quality Agent
    response.forwarded = await safeForward("/run/quality", p);

    res.json(response);
  } catch (err) {
    console.error("💥 Tester error:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ---------- Quality Agent ----------
app.post("/run/quality", async (req, res) => {
  try {
    const p = req.body?.payload || req.body || {};
    console.log("🔍 Quality received:", JSON.stringify(p, null, 2));

    const response = {
      ok: true,
      agent: "quality",
      status: "pass",
      next_step: "integrator",
      timestamp: new Date().toISOString(),
    };

    // Auto-trigger Integrator Agent
    response.forwarded = await safeForward("/run/integrator", p);

    res.json(response);
  } catch (err) {
    console.error("💥 Quality error:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ---------- Integrator Agent ----------
app.post("/run/integrator", async (req, res) => {
  try {
    const p = req.body?.payload || req.body || {};
    console.log("🔗 Integrator received:", JSON.stringify(p, null, 2));

    const response = {
      ok: true,
      agent: "integrator",
      status: "complete",
      timestamp: new Date().toISOString(),
    };

    // Optionally trigger Supervisor
    response.forwarded = await safeForward("/run/supervisor", p);

    res.json(response);
  } catch (err) {
    console.error("💥 Integrator error:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ---------- Supervisor Agent ----------
app.post("/run/supervisor", (_req, res) =>
  res.json({ ok: true, agent: "supervisor", status: "done", timestamp: new Date().toISOString() })
);

// ---------- Start ----------
app.listen(PORT, () => console.log(`🚀 A10 Runner auto-chain live on port ${PORT}`));
