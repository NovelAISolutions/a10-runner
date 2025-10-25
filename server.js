// ================================================
// A10 Runner — Hardened backend for n8n workflow
// - Robust GitHub commit (create or update)
// - Clear errors back to n8n
// - Accepts flat or payload-nested bodies
// - Fixed validation for undefined payloads
// ================================================

import express from "express";
import bodyParser from "body-parser";
import dotenv from "dotenv";
import { Octokit } from "@octokit/rest";

dotenv.config();

const app = express();

// ✅ Unified JSON parser (10 MB limit) — replaces older bodyParser
app.use(express.json({ limit: "10mb" }));
app.use(bodyParser.json()); // optional redundancy for legacy n8n formats

// ---------- Simple Request Logger ----------
app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// ---------- Environment ----------
const PORT = process.env.PORT || 10000;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

if (!GITHUB_TOKEN) {
  console.warn("⚠️  GITHUB_TOKEN missing. GitHub writes will fail.");
}

const octokit = new Octokit({ auth: GITHUB_TOKEN });

// ---------- Utilities ----------

// Normalize body to handle flat JSON or { payload: {...} } structure
function getPayload(req) {
  if (!req.body) return {};
  if (req.body.payload && typeof req.body.payload === "object") {
    return { action: req.body.action, ...req.body.payload };
  }
  return req.body;
}

// Get SHA if file exists (needed for updates)
async function getFileShaOrNull({ owner, repo, path, ref }) {
  try {
    const { data } = await octokit.repos.getContent({ owner, repo, path, ref });
    if (Array.isArray(data)) return null;
    return data.sha || null;
  } catch (err) {
    const status = err?.status || err?.response?.status;
    if (status === 404) return null;
    throw err;
  }
}

// Create or update file on GitHub
async function createOrUpdateFile({
  owner,
  repo,
  path,
  message,
  contentUtf8,
  branch,
  tryMainFallback = true,
}) {
  const contentB64 = Buffer.from(contentUtf8, "utf8").toString("base64");
  let ref = branch || "main";
  let sha = await getFileShaOrNull({ owner, repo, path, ref });

  try {
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
  } catch (err) {
    const status = err?.status || err?.response?.status;
    const msg = err?.response?.data?.message || err.message;
    if (tryMainFallback && ref !== "main" && /branch.*not.*found|no.*ref/i.test(msg)) {
      ref = "main";
      sha = await getFileShaOrNull({ owner, repo, path, ref });
      await octokit.repos.createOrUpdateFileContents({
        owner,
        repo,
        path,
        message,
        content: contentB64,
        branch: ref,
        ...(sha ? { sha } : {}),
      });
      return { ok: true, branch: ref, created: !sha, updated: !!sha, note: "fallback_to_main" };
    }
    throw err;
  }
}

// ---------- Routes ----------

// Health check
app.get("/health", (_req, res) => {
  res.json({ ok: true, message: "runner is alive", timestamp: new Date().toISOString() });
});

// Debug echo route
app.post("/echo", (req, res) => {
  res.json({ received: req.body });
});

// Architect route — already working
app.post("/run/architect", async (_req, res) => {
  res.json({ ok: true, agent: "architect", note: "runner is alive" });
});

// ✅ Coder Agent — fixed to gracefully handle undefined or malformed payloads
app.post("/run/coder", async (req, res) => {
  try {
    // Graceful parsing with fallback
    const body = req.body || {};
    const payload = body.payload || body || {};
    const {
      action = body.action || "direct.commit",
      owner,
      repo,
      branch = "main",
      path = "index.html",
      message = "Automated commit",
      content,
      plan,
    } = payload;

    if (!owner || !repo) {
      return res.status(400).json({
        ok: false,
        reason: "bad_request",
        details: "Missing owner or repo",
        received: payload,
      });
    }

    // Decide what to commit
    let html = content;
    if (!html) {
      if (action === "plan.commit" && plan) {
        html = `<!doctype html>
<html><head><meta charset="utf-8"><title>Plan</title></head>
<body style="font-family: Arial; display:flex; align-items:center; justify-content:center; min-height:100vh;">
  <div>
    <h1>Generated Plan</h1>
    <pre style="white-space: pre-wrap; max-width: 800px;">${plan}</pre>
  </div>
</body></html>`;
      } else {
        return res.status(400).json({
          ok: false,
          reason: "bad_request",
          details: "No content provided (expected .content or .plan)",
          received: payload,
        });
      }
    }

    const result = await createOrUpdateFile({
      owner,
      repo,
      path,
      message,
      contentUtf8: html,
      branch,
      tryMainFallback: true,
    });

    res.json({
      ok: true,
      agent: "coder",
      action,
      result,
      inputs: { owner, repo, branch: result.branch, path },
    });
  } catch (error) {
    console.error("Coder error:", error?.response?.data || error);
    res.status(500).json({
      ok: false,
      reason: "github_error",
      details: error?.response?.data || { message: error.message },
    });
  }
});

// Tester stub
app.post("/run/tester", async (_req, res) => {
  res.json({ ok: true, agent: "tester", result: "tests_passed" });
});

// Quality stub
app.post("/run/quality", async (_req, res) => {
  res.json({ ok: true, status: "pass" });
});

// Integrator stub
app.post("/run/integrator", async (_req, res) => {
  res.json({ ok: true, integrator: "done" });
});

// Supervisor stub
app.post("/run/supervisor", async (_req, res) => {
  res.json({ ok: true, supervisor: "done" });
});

// ---------- Server Start ----------
app.listen(PORT, () => {
  console.log(`🚀 A10 Runner listening on port ${PORT}`);
});
