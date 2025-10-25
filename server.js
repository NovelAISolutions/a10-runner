// ================================================
// 🌟 A10 Runner — Backend with Formatted Timestamp
// ================================================

import express from "express";
import bodyParser from "body-parser";
import fetch from "node-fetch";
import dotenv from "dotenv";
import { Octokit } from "@octokit/rest";

dotenv.config();
const app = express();
app.use(bodyParser.json());

const PORT = process.env.PORT || 10000;

// Initialize Octokit for GitHub access
const octokit = new Octokit({
  auth: process.env.GITHUB_TOKEN,
});

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// ----------------------------------------------------
// Helper: update a GitHub file directly
// ----------------------------------------------------
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

// ----------------------------------------------------
// ✅ ROUTES
// ----------------------------------------------------

// Health check endpoint
app.get("/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// Primary orchestrator route
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

    // 2️⃣ OPENAI EDIT AND COMMIT (with backend formatted timestamp)
    else if (action === "openai.edit-and-commit") {
      const { model, instruction, owner, repo, path, branch, message, commit } = payload;

      // Fetch the current file from GitHub
      const { data: file } = await octokit.repos.getContent({ owner, repo, path, ref: branch });
      const currentContent = Buffer.from(file.content, "base64").toString("utf8");

      // Generate backend timestamp (formatted)
      const date = new Date();
      const formattedTimestamp = date.toLocaleString("en-US", {
        timeZone: "UTC",
        year: "numeric",
        month: "short",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: true,
      }) + " UTC";

      // Append timestamp into GPT instruction
      const updatedInstruction = `${instruction}\nInclude this deployment timestamp: ${formattedTimestamp}. 
Return valid HTML only (no markdown, no code fences). 
The HTML must include the motivational message and a <p> tag showing the timestamp below it. 
Center the content with minimal inline CSS (font: Arial).`;

      // Send request to OpenAI
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
                "You are a precise HTML generator. Always return valid, minimal HTML with a motivational quote and a formatted timestamp. No markdown.",
            },
            {
              role: "user",
              content: `${updatedInstruction}\n\nCurrent file:\n${currentContent}`,
            },
          ],
        }),
      });

      const aiData = await aiResponse.json();
      const newHtml = aiData.choices?.[0]?.message?.content || currentContent;

      // Commit new HTML to GitHub
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
        timestamp: formattedTimestamp,
      });
    }

    // 3️⃣ DIRECT COMMIT — write HTML directly (no OpenAI)
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

    // ❌ Unknown action
    else {
      return res.status(400).json({ ok: false, error: `Unknown action: ${action}` });
    }
  } catch (err) {
    console.error("Server error:", err);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// ----------------------------------------------------
// Start server
// ----------------------------------------------------
app.listen(PORT, () => console.log(`🚀 A10 Runner listening on port ${PORT}`));
