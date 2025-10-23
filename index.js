// index.js
import express from "express";
import crypto from "crypto";
import rawBody from "raw-body";
import { Octokit } from "@octokit/rest";
import { createAppAuth } from "@octokit/auth-app";
import fetch from "node-fetch";
import dotenv from "dotenv";

dotenv.config();

const {
  APP_ID,
  PRIVATE_KEY,
  WEBHOOK_SECRET,
  POLLINATIONS_BASE = "https://enter.pollinations.ai/api/generate/openai",
  POLLINATIONS_API_KEY = "",
  DEFAULT_BASE_BRANCH = "main"
} = process.env;

if (!APP_ID || !PRIVATE_KEY || !WEBHOOK_SECRET) {
  console.error("Missing required env vars: APP_ID, PRIVATE_KEY, WEBHOOK_SECRET");
  process.exit(1);
}

const app = express();

// parse raw body for GitHub webhook signature verification
app.use(async (req, res, next) => {
  if (req.headers["x-github-event"]) {
    try {
      req.rawBody = await rawBody(req);
      req.body = JSON.parse(req.rawBody.toString());
    } catch (err) {
      console.error("Failed to parse raw body:", err);
      return res.status(400).send("Invalid payload");
    }
    next();
  } else {
    express.json()(req, res, next);
  }
});

function verifySignature(rawBodyBuffer, signatureHeader) {
  if (!signatureHeader) return false;
  const hmac = crypto.createHmac("sha256", WEBHOOK_SECRET);
  hmac.update(rawBodyBuffer);
  const expected = `sha256=${hmac.digest("hex")}`;
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signatureHeader));
}

function getInstallationOctokit(installationId) {
  return new Octokit({
    authStrategy: createAppAuth,
    auth: {
      appId: Number(APP_ID),
      privateKey: PRIVATE_KEY,
      installationId: Number(installationId)
    }
  });
}

async function createBranch(octokit, owner, repo, branchName, baseBranch = DEFAULT_BASE_BRANCH) {
  const { data: baseRef } = await octokit.rest.git.getRef({
    owner,
    repo,
    ref: `heads/${baseBranch}`
  });
  await octokit.rest.git.createRef({
    owner,
    repo,
    ref: `refs/heads/${branchName}`,
    sha: baseRef.object.sha
  });
}

async function commitFile(octokit, owner, repo, path, content, message, branch) {
  const encoded = Buffer.from(content, "utf8").toString("base64");
  await octokit.rest.repos.createOrUpdateFileContents({
    owner,
    repo,
    path,
    message,
    content: encoded,
    branch
  });
}

// --- new multi-file Pollinations generator ---
async function generateProject(prompt, options = {}) {
  // Instruct AI to output only JSON array of files
  const messages = [
    { role: "system", content: "You are an AI that outputs ONLY JSON arrays of files. Each file should have 'path' and 'content'." },
    { role: "user", content: prompt }
  ];

  const body = {
    messages,
    model: options.model || "openai-large",
    temperature: typeof options.temperature === "number" ? options.temperature : 0.7,
    max_tokens: options.max_tokens || 2000,
    n: 1,
    response_format: { type: "text" },
    stream: false
  };

  const headers = { "Content-Type": "application/json" };
  if (POLLINATIONS_API_KEY) headers["x-api-key"] = POLLINATIONS_API_KEY;

  const res = await fetch(POLLINATIONS_BASE, {
    method: "POST",
    headers,
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Pollinations API error ${res.status}: ${txt}`);
  }

  const data = await res.json();

  if (!data.choices || !data.choices.length) throw new Error("Pollinations returned no choices");

  const message = data.choices[0].message || {};
  let textOutput = "";

  if (message.content && typeof message.content === "string" && message.content.trim()) {
    textOutput = message.content;
  } else if (Array.isArray(message.content_blocks) && message.content_blocks.length) {
    textOutput = message.content_blocks.map(b => b.text).join("\n\n");
  } else {
    throw new Error("Couldn't extract text from Pollinations response");
  }

  // Parse JSON array of files
  let files;
  try {
    files = JSON.parse(textOutput);
    if (!Array.isArray(files)) throw new Error("AI output is not an array");
  } catch (err) {
    // fallback: wrap as single file
    files = [{ path: "generated/auto.txt", content: textOutput }];
  }

  return files;
}

function extractGenerateCommand(text) {
  if (!text) return null;
  const lines = text.split("\n");
  for (const l of lines) {
    const t = l.trim();
    if (t.toLowerCase().startsWith("/generate")) return t.replace(/\/generate/i, "").trim();
  }
  return null;
}

// --- webhook endpoint ---
app.post("/api/webhook", async (req, res) => {
  try {
    if (!verifySignature(req.rawBody, req.headers["x-hub-signature-256"])) {
      return res.status(401).send("Invalid signature");
    }

    const event = req.headers["x-github-event"];
    const payload = req.body;

    let commandText = null, issue = null, repo = null, installationId = null;

    if (event === "issues") {
      issue = payload.issue;
      repo = payload.repository;
      installationId = payload.installation?.id;
      if (["opened","edited"].includes(payload.action)) commandText = extractGenerateCommand(issue.body);
    } else if (event === "issue_comment") {
      issue = payload.issue;
      repo = payload.repository;
      installationId = payload.installation?.id;
      if (["created","edited"].includes(payload.action)) commandText = extractGenerateCommand(payload.comment.body);
    } else return res.status(200).send("ignored");

    if (!commandText || !installationId) return res.status(200).send("no command or missing installation");

    const octokit = getInstallationOctokit(installationId);
    const owner = repo.owner.login;
    const repoName = repo.name;
    const issueNumber = issue.number;

    // comment initial reply
    await octokit.rest.issues.createComment({
      owner, repo: repoName, issue_number: issueNumber,
      body: `🤖 Generating project for: \`${commandText}\`...`
    });

    // generate files
    const files = await generateProject(commandText);

    // create branch
    const branch = `auto/${Date.now()}`;
    await createBranch(octokit, owner, repoName, branch);

    // commit all files
    for (const f of files) {
      if (f.path && f.content) {
        await commitFile(octokit, owner, repoName, f.path, f.content, `chore: add AI-generated file ${f.path}`, branch);
      }
    }

    // create PR
    const pr = await octokit.rest.pulls.create({
      owner, repo: repoName,
      title: `Auto-generated project: ${commandText}`,
      head: branch,
      base: DEFAULT_BASE_BRANCH,
      body: `This PR was automatically created from issue #${issueNumber}.`
    });

    await octokit.rest.issues.createComment({
      owner, repo: repoName, issue_number: issueNumber,
      body: `✅ PR created: ${pr.data.html_url}`
    });

    return res.status(200).send("ok");

  } catch (err) {
    console.error("Webhook handler error:", err);
    return res.status(500).send("server error");
  }
});

// basic health check
app.get("/api/health", (req,res)=>res.send("ok"));

const port = process.env.PORT || 3000;
app.listen(port,()=>console.log(`🚀 Listening on port ${port}`));
