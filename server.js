// ================================================
// A10 Runner — Hardened backend for n8n workflow
// - Robust GitHub commit (create or update)
// - Clear errors back to n8n
// - Accepts flat or payload-nested bodies
// ================================================

import express from "express";
import bodyParser from "body-parser";
import dotenv from "dotenv";
import { Octokit } from "@octokit/rest";

dotenv.config();

const app = express();
app.use(bodyParser.json());

// Simple request logger (method + path)
app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

const PORT = process.env.PORT || 10000;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

if (!GITHUB_TOKEN) {
  console.warn("⚠️  GITHUB_TOKEN missing. GitHub writes will fail.");
}

const octokit = new Octokit({ auth: GITHUB_TOKEN });

// ---------- Utilities -------------------------------------------------

// Normalize body to allow both flat and { payload: {...} } shapes
function getPayload(req) {
  return req.body?.payload && typeof req.body.payload === "object"
    ? { action: req.body.action, ...req.body.payload }
    : req.body || {};
}

// Get SHA if file exists; if it doesn't, return null (so we can create)
async function getFileShaOrNull({ owner, repo, path, ref }) {
  try {
    const { data } = await octokit.repos.getContent({ owner, repo, path, ref });
    // data can be object or array; ensure object with sha
    if (Array.isArray(data)) {
      // path points to a directory; we want a file
      return null;
    }
    return data.sha || null;
  } catch (err) {
    const status = err?.status || err?.response?.status;
    if (status === 404) return null;
    throw err;
  }
}

// Create or update a file content, auto-handling SHA/new-file case.
// Optionally tries fallback to main if branch is missing.
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

  // If branch is undefined or empty, default to main
  let ref = branch || "main";

  // If file exists, we need SHA; otherwise null
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
    // If branch problem and allowed, fallback to main once
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

// ---------- Routes ----------------------------------------------------

app.get("/health", (_req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// Debug helper to see exactly what you send
app.post("/echo", (req, res) => {
  res.json({ received: req.body });
});

// Architect example (works already for you)
app.post("/run/architect", async (_req, res) => {
  // If you need OpenAI here, you can add it back. For now we just echo.
  res.json({ ok: true, agent: "architect", note: "runner is alive" });
});

// Coder: supports two actions for simplicity:
// - direct.commit (commit provided content)
// - plan.commit (wrap plan string into basic HTML and commit)
app.post("/run/coder", async (req, res) => {
  try {
    const p = getPayload(req);
    const action = p.action || "direct.commit";
    const owner = p.owner;
    const repo = p.repo;
    const branch = p.branch || "main";
    const path = p.path || "index.html";
    const message = p.message || "Automated commit";
    const plan = p.plan;
    const content = p.content;

    if (!owner || !repo) {
      return res.status(400).json({
        ok: false,
        reason: "bad_request",
        details: "Missing owner or repo",
        inputs: { owner, repo, branch, path },
      });
    }

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
      } else if (action === "direct.commit") {
        return res.status(400).json({
          ok: false,
          reason: "bad_request",
          details: "content is required for direct.commit",
          inputs: { owner, repo, branch, path, hasContent: !!content },
        });
      } else {
        return res.status(400).json({
          ok: false,
          reason: "bad_request",
          details: "Provide content (direct.commit) or plan (plan.commit)",
          inputs: { owner, repo, branch, path, action },
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

    res.json({ ok: true, action, result, inputs: { owner, repo, branch: result.branch, path } });
  } catch (error) {
    console.error("Coder error:", error?.response?.data || error);
    res.status(500).json({
      ok: false,
      reason: "github_error",
      details: error?.response?.data || { message: error.message },
    });
  }
});

// Minimal tester route (stub)
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

// Start server
app.listen(PORT, () => {
  console.log(`🚀 A10 Runner listening on port ${PORT}`);
});
