import express from "express";
import bodyParser from "body-parser";
import fetch from "node-fetch";
import dotenv from "dotenv";
import { Octokit } from "@octokit/rest";

dotenv.config();
const app = express();
app.use(bodyParser.json());

const PORT = process.env.PORT || 10000;

const octokit = new Octokit({
  auth: process.env.GITHUB_TOKEN,
});

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// Helper: update GitHub file
async function updateGitHubFile({ owner, repo, path, branch, message, content }) {
  const { data: file } = await octokit.repos.getContent({ owner, repo, path, ref: branch });
  const sha = file.sha;

  await octokit.repos.createOrUpdateFileContents({
    owner,
    repo,
    path,
    message,
    content: Buffer.from(content).toString("base64"),
    sha,
    branch,
  });

  return { ok: true };
}

// ========== ROUTES ==========

// ✅ Health check
app.get("/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// ✅ Primary runner route
app.post("/run", async (req, res) => {
  try {
    const { action, payload } = req.body;

    // 1️⃣ OPENAI CHAT
    if (action === "openai.chat") {
      const { model, messages } = payload;
      const response = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${OPENAI_API_KEY}`,
        },
        body: JSON.stringify({ model, messages }),
      });
      const data = await response.json();
      return res.json({ ok: true, action, result: data });
    }

    // 2️⃣ OPENAI EDIT + COMMIT
    else if (action === "openai.edit-and-commit") {
      const { model, instruction, owner, repo, path, branch, message, commit } = payload;

      // Get current file content
      const { data: file } = await octokit.repos.getContent({ owner, repo, path, ref: branch });
      const currentContent = Buffer.from(file.content, "base64").toString("utf8");

      // Ask GPT to edit
      const aiResponse = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${OPENAI_API_KEY}`,
        },
        body: JSON.stringify({
          model,
          messages: [
            {
              role: "system",
              content:
                "You are a precise code editor. Always output pure HTML only, never explanations.",
            },
            {
              role: "user",
              content: `${instruction}\n\nCurrent file:\n${currentContent}`,
            },
          ],
        }),
      });

      const aiData = await aiResponse.json();
      const newHtml = aiData.choices?.[0]?.message?.content || currentContent;

      if (commit) {
        const { data: file } = await octokit.repos.getContent({ owner, repo, path, ref: branch });
        const sha = file.sha;

        await octokit.repos.createOrUpdateFileContents({
          owner,
          repo,
          path,
          message,
          content: Buffer.from(newHtml).toString("base64"),
          sha,
          branch,
        });
      }

      return res.json({
        ok: true,
        action,
        result: { ok: true, contentPreview: newHtml.slice(0, 200) },
      });
    }

    // 3️⃣ DIRECT COMMIT — no GPT involved
    else if (action === "direct.commit") {
      const { owner, repo, path, branch, message, commit, content } = payload;

      if (!content) {
        return res.status(400).json({ ok: false, error: "Missing content for direct.commit" });
      }

      await updateGitHubFile({ owner, repo, path, branch, message, content });
      return res.json({
        ok: true,
        action,
        result: { ok: true, committed: true, path },
      });
    }

    // 🚫 Unknown action
    else {
      return res.status(400).json({ ok: false, error: `Unknown action: ${action}` });
    }
  } catch (err) {
    console.error("Server error:", err);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

app.listen(PORT, () => console.log(`🚀 A10 Runner listening on port ${PORT}`));
