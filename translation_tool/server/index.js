import "dotenv/config";
import express from "express";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const toolRoot = path.resolve(__dirname, "..");
const projectRoot = path.resolve(toolRoot, "..");
const backupsRoot = path.join(toolRoot, "backups");
const port = Number(process.env.PORT || 5173);
const isProduction = process.env.NODE_ENV === "production" || process.argv.includes("--production");
const textProfiles = ["vanilla", "apostrophe-patched"];
const exeSignatureOffset = 0x72f61;
const originalExeSignature = Buffer.from("80fb270f8446020000", "hex");
const patchedExeSignature = Buffer.from("80fb27909090909090", "hex");
const exeSourceCandidates = ["main.exe.before-apostrophe-test", "main.org", "main.exe"];
const localeEmulatorPathCandidates = [
  process.env.LOCALE_EMULATOR_PATH,
  process.env.LEPROC_PATH,
  path.join(projectRoot, "LEProc.exe"),
  path.join(projectRoot, "Locale Emulator", "LEProc.exe"),
  path.join(projectRoot, "tools", "Locale Emulator", "LEProc.exe"),
  path.join(process.env.ProgramFiles || "C:\\Program Files", "Locale Emulator", "LEProc.exe"),
  path.join(process.env.ProgramFiles || "C:\\Program Files", "Locale.Emulator", "LEProc.exe"),
  path.join(process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "Locale Emulator", "LEProc.exe"),
  path.join(process.env.LOCALAPPDATA || "", "Locale Emulator", "LEProc.exe"),
  ...(process.env.PATH || "")
    .split(path.delimiter)
    .filter(Boolean)
    .map((dir) => path.join(dir, "LEProc.exe")),
].filter(Boolean);

function isInside(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

function projectPath(...parts) {
  const resolved = path.resolve(projectRoot, ...parts);
  if (!isInside(projectRoot, resolved)) {
    throw new Error(`Path escapes project root: ${resolved}`);
  }
  return resolved;
}

function backupPath(backupId, relativePath) {
  const resolved = path.resolve(backupsRoot, backupId, relativePath);
  if (!isInside(path.resolve(backupsRoot, backupId), resolved)) {
    throw new Error(`Path escapes backup root: ${resolved}`);
  }
  return resolved;
}

function timestampId() {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-");
}

function profileSlug(profile) {
  return profile === "apostrophe-patched" ? "apostrophes" : "vanilla";
}

function summarizeOverflowReport(report, relativePath) {
  const overflowPages = Array.isArray(report?.overflow_pages) ? report.overflow_pages : [];
  const wrappedLines = Array.isArray(report?.wrapped_lines) ? report.wrapped_lines : [];
  const insertedWindows = overflowPages.reduce((total, page) => total + Number(page.inserted_windows || 0), 0);
  return {
    exists: Boolean(report),
    path: relativePath,
    overflowPages: overflowPages.length,
    insertedWindows,
    wrappedLines: wrappedLines.length,
    pages: overflowPages.map((page) => ({
      page_id: page.page_id,
      line_start: page.line_start,
      line_end: page.line_end,
      used_lines: page.used_lines,
      max_lines: page.max_lines,
      inserted_windows: page.inserted_windows,
    })),
  };
}

function safeSuggestionName(lineId) {
  return lineId.replace(/[^A-Za-z0-9_.-]+/g, "_");
}

function safeStem(stem) {
  const value = String(stem || "");
  if (!/^[A-Za-z0-9_.-]+$/.test(value)) {
    const error = new Error(`Invalid file stem: ${value}`);
    error.status = 400;
    throw error;
  }
  return value;
}

function safeBackupId(backupId) {
  const value = String(backupId || "");
  if (!/^[0-9]{8}-[0-9]{6}$/.test(value)) {
    const error = new Error(`Invalid backup id: ${value}`);
    error.status = 400;
    throw error;
  }
  return value;
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function findLocaleEmulator() {
  const seen = new Set();
  for (const candidate of localeEmulatorPathCandidates) {
    const resolved = path.resolve(candidate);
    const key = resolved.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    if (await exists(resolved)) return resolved;
  }
  return null;
}

async function readJson(filePath, fallback = null) {
  if (!(await exists(filePath))) return fallback;
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

async function readJsonl(filePath) {
  if (!(await exists(filePath))) return [];
  const text = await fs.readFile(filePath, "utf8");
  return text
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

async function writeJsonl(filePath, rows) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const payload = rows.map((row) => JSON.stringify(row)).join("\n");
  await fs.writeFile(filePath, payload ? `${payload}\n` : "", "utf8");
}

async function appendJsonl(filePath, row) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.appendFile(filePath, `${JSON.stringify(row)}\n`, "utf8");
}

async function copyWithParents(from, to) {
  await fs.mkdir(path.dirname(to), { recursive: true });
  await fs.copyFile(from, to);
}

async function backupFile(absPath, backupId) {
  if (!(await exists(absPath))) return null;
  const relative = path.relative(projectRoot, absPath);
  const target = backupPath(backupId, relative);
  await copyWithParents(absPath, target);
  return { relative, backupPath: path.relative(projectRoot, target) };
}

async function listFilesRecursive(root) {
  if (!(await exists(root))) return [];
  const out = [];
  async function walk(dir) {
    for (const item of await fs.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, item.name);
      if (item.isDirectory()) await walk(full);
      else out.push(full);
    }
  }
  await walk(root);
  return out;
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd || projectRoot,
      shell: false,
      windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: "utf-8" },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("close", (exitCode) => {
      resolve({
        command: [command, ...args].join(" "),
        exitCode,
        stdout,
        stderr,
      });
    });
  });
}

function hexBytes(buffer) {
  return [...buffer].map((byte) => byte.toString(16).padStart(2, "0").toUpperCase()).join(" ");
}

async function inspectExe(relativePath) {
  const absPath = projectPath(relativePath);
  if (!(await exists(absPath))) return { file: relativePath, exists: false, state: "missing" };
  const handle = await fs.open(absPath, "r");
  try {
    const buffer = Buffer.alloc(originalExeSignature.length);
    await handle.read(buffer, 0, buffer.length, exeSignatureOffset);
    const state = buffer.equals(originalExeSignature) ? "original" : buffer.equals(patchedExeSignature) ? "patched" : "unknown";
    return {
      file: relativePath,
      exists: true,
      state,
      offset: `0x${exeSignatureOffset.toString(16).toUpperCase()}`,
      bytes: hexBytes(buffer),
    };
  } finally {
    await handle.close();
  }
}

async function inspectExeCandidates() {
  const candidates = [];
  for (const candidate of exeSourceCandidates) candidates.push(await inspectExe(candidate));
  return candidates;
}

async function findOriginalExeSource() {
  const candidates = await inspectExeCandidates();
  return {
    candidates,
    source: candidates.find((candidate) => candidate.state === "original") || null,
    current: candidates.find((candidate) => candidate.file === "main.exe") || null,
  };
}

async function loadCorpus(stem) {
  stem = safeStem(stem);
  const pagesPath = projectPath("work", "corpus", `${stem}.pages.jsonl`);
  const batchesPath = projectPath("work", "corpus", `${stem}.batches.jsonl`);
  const scenesPath = projectPath("work", "corpus", `${stem}.scenes.json`);
  const sceneSummaryPath = projectPath("translations", "context", "scene_summaries", `${stem}.scenes.json`);
  const pages = await readJsonl(pagesPath);
  const batches = await readJsonl(batchesPath);
  const scenes = await readJson(scenesPath, []);
  const sceneSummaries = await readJson(sceneSummaryPath, []);
  const batchByLine = new Map();
  for (const batch of batches) {
    for (const page of batch.pages || []) {
      for (const entry of page.entries || []) {
        if (entry.translatable && !entry.auto) batchByLine.set(entry.line_id, batch.batch_id);
      }
    }
  }
  return { pages, batches, scenes, sceneSummaries, batchByLine };
}

async function loadTranslationRecords(stem) {
  stem = safeStem(stem);
  const approvedPath = projectPath("translations", "approved", `${stem}.approved.jsonl`);
  const records = await readJsonl(approvedPath);
  const translations = new Map();
  for (const record of records) {
    if (Array.isArray(record.translations)) {
      for (const item of record.translations) {
        if (item.line_id) translations.set(String(item.line_id), item);
      }
    } else if (record.line_id) {
      translations.set(String(record.line_id), record);
    }
  }
  return { approvedPath, records, translations };
}

async function loadTranslationPrompts(stem) {
  stem = safeStem(stem);
  const promptPath = projectPath("qa", "reports", `${stem}_translation_prompts.jsonl`);
  const records = await readJsonl(promptPath);
  return records
    .filter((record) => record.batch_id && record.prompt)
    .map((record) => ({
      batch_id: String(record.batch_id),
      prompt: String(record.prompt),
      status: record.status || null,
      created_at: record.created_at || null,
      model: record.model || null,
    }));
}

function buildRows(corpus, translations) {
  const rows = [];
  for (const page of corpus.pages) {
    for (const entry of page.entries || []) {
      const current = translations.get(entry.line_id);
      rows.push({
        line_id: entry.line_id,
        file: entry.file,
        line_number: entry.line_number,
        page_id: page.page_id,
        page_index: page.page_index,
        scene_id: page.scene_id,
        scene_title_jp: page.scene_title_jp,
        role: entry.role,
        kind: entry.kind,
        speaker_jp: entry.speaker_jp,
        speaker_en: entry.speaker_en,
        jp: entry.jp,
        source_line: entry.source_line,
        source_hash: entry.source_hash,
        render_prefix: entry.render_prefix || "",
        max_chars: entry.max_chars || page.textbox?.max_chars_per_line || 50,
        textbox: page.textbox,
        auto: Boolean(entry.auto),
        editable: Boolean(entry.translatable && !entry.auto),
        batch_id: corpus.batchByLine.get(entry.line_id) || null,
        en: current?.en ?? entry.en ?? "",
        notes: current?.notes ?? "",
        metadata: current || {},
      });
    }
  }
  return rows;
}

function summarizeRows(rows) {
  const editable = rows.filter((row) => row.editable);
  return {
    totalRows: rows.length,
    editable: editable.length,
    translated: editable.filter((row) => row.en.trim()).length,
    untranslated: editable.filter((row) => !row.en.trim()).length,
    auto: rows.filter((row) => row.auto).length,
  };
}

function ensureTranslationRecord(records, batchId) {
  let record = records.find((row) => row.batch_id === batchId);
  if (!record) {
    record = { batch_id: batchId, translations: [] };
    records.push(record);
  }
  if (!Array.isArray(record.translations)) record.translations = [];
  return record;
}

function applyChangesToRecords(records, changes, corpus) {
  const existing = new Map();
  for (const record of records) {
    if (!Array.isArray(record.translations)) continue;
    for (const item of record.translations) existing.set(String(item.line_id), item);
  }

  for (const change of changes) {
    const lineId = String(change.line_id || "");
    if (!lineId) continue;
    let item = existing.get(lineId);
    if (!item) {
      const batchId = corpus.batchByLine.get(lineId) || `${corpus.batches[0]?.file || "manual"}:manual`;
      const record = ensureTranslationRecord(records, batchId);
      item = { line_id: lineId, en: "", notes: "" };
      record.translations.push(item);
      existing.set(lineId, item);
    }
    if (Object.prototype.hasOwnProperty.call(change, "en")) item.en = String(change.en);
    if (Object.prototype.hasOwnProperty.call(change, "notes")) item.notes = String(change.notes);
    item.edited_at = new Date().toISOString();
    item.edited_by = "translation_tool";
  }
}

function lineIssues(row, textProfile) {
  const issues = [];
  const lines = String(row.en || "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n")
    .filter((line) => line.trim());
  if (row.editable && !String(row.en || "").trim()) issues.push("empty");
  for (const line of lines) {
    if (line.trim().length > row.max_chars) issues.push("line_too_long");
  }
  if (textProfile === "vanilla" && String(row.en || "").includes("'")) issues.push("apostrophe");
  return [...new Set(issues)];
}

async function buildDeepSeekPrompt(stem, lineId, instruction, textProfile) {
  const corpus = await loadCorpus(stem);
  const { translations } = await loadTranslationRecords(stem);
  const pages = corpus.pages;
  const pageIndex = pages.findIndex((page) => (page.entries || []).some((entry) => entry.line_id === lineId));
  if (pageIndex === -1) throw new Error(`Unknown line_id: ${lineId}`);
  const page = pages[pageIndex];
  const entry = page.entries.find((row) => row.line_id === lineId);
  const current = translations.get(lineId);
  const glossary = await readJson(projectPath("translations", "context", "glossary.json"), {});
  const globalStyle = (await fs.readFile(projectPath("translations", "context", "global_style.md"), "utf8")).slice(0, 5000);
  const sceneSummary = Array.isArray(corpus.sceneSummaries)
    ? corpus.sceneSummaries.find((row) => row.scene_id === page.scene_id)
    : null;

  let characterCard = "";
  const profile = glossary.characters?.find((row) => row.jp === entry.speaker_jp)?.profile;
  if (profile) {
    const cardPath = projectPath("translations", "context", "characters", `${profile}.md`);
    if (await exists(cardPath)) characterCard = await fs.readFile(cardPath, "utf8");
  }

  const pageForPrompt = (p) => ({
    page_id: p?.page_id,
    page_role: p?.page_role,
    speaker_en: p?.speaker_en,
    entries: (p?.entries || []).map((row) => ({
      line_id: row.line_id,
      role: row.role,
      speaker_en: row.speaker_en,
      jp: row.jp,
      current_en: translations.get(row.line_id)?.en || "",
    })),
  });

  const profileRule =
    textProfile === "apostrophe-patched"
      ? "ASCII apostrophes and contractions are allowed. Do not use curly quotes, em dashes, en dashes, or ellipsis characters."
      : "Do not use apostrophes or contractions. Use ASCII punctuation and three periods for ellipses.";

  return `Retranslate one visual novel line from Japanese to natural English.

Return JSON only with this schema:
{"en":"...","notes":"..."}

Rules:
- Keep each physical line at or below ${entry.max_chars || 50} visible characters.
- Preserve character voice and page rhythm.
- ${profileRule}
- If the current translation is awkward, improve it rather than paraphrasing mechanically.

Optional user instruction:
${instruction || "(none)"}

Global style:
${globalStyle}

Glossary:
${JSON.stringify(glossary, null, 2)}

Character card:
${characterCard || "(none)"}

Scene summary:
${JSON.stringify(sceneSummary || {}, null, 2)}

Previous page:
${JSON.stringify(pageForPrompt(pages[pageIndex - 1]), null, 2)}

Current page:
${JSON.stringify(pageForPrompt(page), null, 2)}

Next page:
${JSON.stringify(pageForPrompt(pages[pageIndex + 1]), null, 2)}

Target:
${JSON.stringify(
  {
    line_id: entry.line_id,
    role: entry.role,
    speaker_en: entry.speaker_en,
    jp: entry.jp,
    current_en: current?.en || "",
  },
  null,
  2,
)}`;
}

async function callDeepSeek(prompt, model, temperature) {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    const error = new Error("Missing DEEPSEEK_API_KEY in translation_tool/.env or environment");
    error.status = 400;
    throw error;
  }
  const response = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      temperature,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: "You are a careful Japanese-to-English visual novel translator. Output JSON only." },
        { role: "user", content: prompt },
      ],
    }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error?.message || `DeepSeek HTTP ${response.status}`);
  }
  return JSON.parse(payload.choices[0].message.content);
}

const app = express();
app.use(express.json({ limit: "20mb" }));

app.get("/api/health", async (_req, res, next) => {
  try {
    const localeEmulatorPath = await findLocaleEmulator();
    res.json({
      ok: true,
      projectRoot,
      toolRoot,
      deepseekConfigured: Boolean(process.env.DEEPSEEK_API_KEY),
      localeEmulatorConfigured: Boolean(localeEmulatorPath),
      localeEmulatorPath,
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/files", async (_req, res, next) => {
  try {
    const corpusDir = projectPath("work", "corpus");
    const files = [];
    if (await exists(corpusDir)) {
      for (const name of await fs.readdir(corpusDir)) {
        if (!name.endsWith(".pages.jsonl")) continue;
        const stem = name.replace(/\.pages\.jsonl$/, "");
        const approvedPath = projectPath("translations", "approved", `${stem}.approved.jsonl`);
        const cleanPath = projectPath("work", "clean_source", `${stem}.adx`);
        files.push({
          stem,
          file: `${stem}.adx`,
          approvedExists: await exists(approvedPath),
          cleanSourceExists: await exists(cleanPath),
        });
      }
    }
    res.json({ files });
  } catch (error) {
    next(error);
  }
});

app.get("/api/files/:stem", async (req, res, next) => {
  try {
    const stem = safeStem(req.params.stem);
    const textProfile = textProfiles.includes(req.query.textProfile) ? req.query.textProfile : "apostrophe-patched";
    const slug = profileSlug(textProfile);
    const corpus = await loadCorpus(stem);
    const { approvedPath, records, translations } = await loadTranslationRecords(stem);
    const translationPrompts = await loadTranslationPrompts(stem);
    const overflowReportRelative = path.join("patch_jobs", `${stem}_translated_jobs.${slug}.overflow_report.json`);
    const overflowReport = await readJson(projectPath(overflowReportRelative), null);
    const rows = buildRows(corpus, translations).map((row) => ({
      ...row,
      issues: lineIssues(row, textProfile),
    }));
    res.json({
      stem,
      file: `${stem}.adx`,
      textProfile,
      approvedPath: path.relative(projectRoot, approvedPath),
      approvedExists: records.length > 0,
      cleanSourceExists: await exists(projectPath("work", "clean_source", `${stem}.adx`)),
      scenes: corpus.scenes,
      sceneSummaries: Array.isArray(corpus.sceneSummaries) ? corpus.sceneSummaries : [],
      translationPrompts,
      overflowReport: summarizeOverflowReport(overflowReport, overflowReportRelative),
      batches: corpus.batches.map((batch) => ({
        batch_id: batch.batch_id,
        batch_index: batch.batch_index,
        scene_id: batch.scene_id,
        scene_title_jp: batch.scene_title_jp,
        page_start: batch.page_start,
        page_end: batch.page_end,
        line_start: batch.line_start,
        line_end: batch.line_end,
      })),
      rows,
      stats: summarizeRows(rows),
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/files/:stem/save", async (req, res, next) => {
  try {
    const stem = safeStem(req.params.stem);
    const changes = Array.isArray(req.body.changes) ? req.body.changes : [];
    if (!changes.length) return res.json({ ok: true, saved: 0 });
    const corpus = await loadCorpus(stem);
    const { approvedPath, records } = await loadTranslationRecords(stem);
    const backupId = timestampId();
    const backup = await backupFile(approvedPath, backupId);
    applyChangesToRecords(records, changes, corpus);
    await writeJsonl(approvedPath, records);
    res.json({ ok: true, saved: changes.length, backupId, backup });
  } catch (error) {
    next(error);
  }
});

app.post("/api/files/:stem/retranslate", async (req, res, next) => {
  try {
    const stem = safeStem(req.params.stem);
    const { lineId, instruction = "", textProfile = "apostrophe-patched", model = "deepseek-v4-flash" } = req.body;
    if (!lineId) {
      const error = new Error("lineId is required");
      error.status = 400;
      throw error;
    }
    const prompt = await buildDeepSeekPrompt(stem, lineId, instruction, textProfile);
    const result = await callDeepSeek(prompt, model, Number(req.body.temperature ?? 0.2));
    const row = {
      created_at: new Date().toISOString(),
      stem,
      line_id: lineId,
      text_profile: textProfile,
      model,
      instruction,
      prompt,
      suggestion: result,
    };
    await appendJsonl(projectPath("translations", "suggestions", stem, `${safeSuggestionName(lineId)}.jsonl`), row);
    res.json({ ok: true, ...row });
  } catch (error) {
    next(error);
  }
});

app.post("/api/workflows/validate", async (req, res, next) => {
  try {
    const { textProfile = "apostrophe-patched" } = req.body;
    const stem = safeStem(req.body.stem);
    const result = await runCommand("python", [
      "tools/validate_translations.py",
      "--file",
      `${stem}.adx`,
      "--translations",
      `translations/approved/${stem}.approved.jsonl`,
      "--text-profile",
      textProfile,
      "--allow-window-overflow",
      "--strict",
    ]);
    const report = await readJson(projectPath("qa", "reports", `${stem}_validation.json`), null);
    res.json({ ...result, report });
  } catch (error) {
    next(error);
  }
});

app.post("/api/workflows/build-jobs", async (req, res, next) => {
  try {
    const { textProfile = "apostrophe-patched" } = req.body;
    const stem = safeStem(req.body.stem);
    const slug = profileSlug(textProfile);
    const jobs = `patch_jobs/${stem}_translated_jobs.${slug}.json`;
    const result = await runCommand("python", [
      "tools/build_patch_jobs_from_translations.py",
      "--file",
      `${stem}.adx`,
      "--translations",
      `translations/approved/${stem}.approved.jsonl`,
      "--jobs",
      jobs,
      "--include-auto-speakers",
      "--auto-window-overflow",
    ]);
    const overflowReportRelative = path.join("patch_jobs", `${stem}_translated_jobs.${slug}.overflow_report.json`);
    const overflowReport = await readJson(projectPath(overflowReportRelative), null);
    res.json({ ...result, jobs, overflowReport: summarizeOverflowReport(overflowReport, overflowReportRelative) });
  } catch (error) {
    next(error);
  }
});

app.post("/api/workflows/reinsert", async (req, res, next) => {
  try {
    const { textProfile = "apostrophe-patched", mode = "variable" } = req.body;
    const stem = safeStem(req.body.stem);
    const slug = profileSlug(textProfile);
    const cleanSource = projectPath("work", "clean_source", `${stem}.adx`);
    if (!(await exists(cleanSource))) {
      const error = new Error(`Missing clean source: ${path.relative(projectRoot, cleanSource)}`);
      error.status = 400;
      throw error;
    }
    const jobs = `patch_jobs/${stem}_translated_jobs.${slug}.json`;
    const outDir = `patched_adx_${slug}`;
    const result = await runCommand("python", [
      "tools/game_management.py",
      "reinsert",
      "--source-dir",
      "work/clean_source",
      "--file",
      `${stem}.adx`,
      "--jobs",
      jobs,
      "--out-dir",
      outDir,
      "--mode",
      mode,
    ]);
    const report = await readJson(projectPath(outDir, "patch_report.json"), null);
    res.json({ ...result, jobs, outDir, reportRows: Array.isArray(report) ? report.length : 0 });
  } catch (error) {
    next(error);
  }
});

app.post("/api/workflows/exe/verify", async (_req, res, next) => {
  try {
    const { candidates, source, current } = await findOriginalExeSource();
    if (!source) {
      res.json({
        command: "inspect executable patch state",
        exitCode: current?.state === "patched" ? 0 : 1,
        stdout: current?.state === "patched" ? "Current main.exe already has the apostrophe patch.\n" : "",
        stderr: current?.state === "patched" ? "" : "No original executable source was found.\n",
        current,
        candidates,
      });
      return;
    }
    const result = await runCommand("python", [
      "tools/patch_main_apostrophe.py",
      "--source",
      source.file,
      "--output",
      "patched_exe/main_apostrophe.exe",
      "--dry-run",
    ]);
    res.json({ ...result, current, candidates, source: source.file });
  } catch (error) {
    next(error);
  }
});

app.post("/api/workflows/exe/build", async (_req, res, next) => {
  try {
    const { candidates, source, current } = await findOriginalExeSource();
    if (!source) {
      const error = new Error("No original executable source was found. Expected main.exe.before-apostrophe-test or main.org.");
      error.status = 400;
      throw error;
    }
    const result = await runCommand("python", [
      "tools/patch_main_apostrophe.py",
      "--source",
      source.file,
      "--output",
      "patched_exe/main_apostrophe.exe",
    ]);
    res.json({ ...result, current, candidates, source: source.file, output: "patched_exe/main_apostrophe.exe" });
  } catch (error) {
    next(error);
  }
});

app.post("/api/install", async (req, res, next) => {
  try {
    const { textProfile = "apostrophe-patched", installExe = true, installAdx = true } = req.body;
    const stem = safeStem(req.body.stem);
    const slug = profileSlug(textProfile);
    const backupId = timestampId();
    const backups = [];
    if (installExe) backups.push(await backupFile(projectPath("main.exe"), backupId));
    if (installAdx) backups.push(await backupFile(projectPath(`${stem}.adx`), backupId));
    if (installExe) {
      await copyWithParents(projectPath("patched_exe", "main_apostrophe.exe"), projectPath("main.exe"));
    }
    if (installAdx) {
      await copyWithParents(projectPath(`patched_adx_${slug}`, "variable", `${stem}.adx`), projectPath(`${stem}.adx`));
    }
    res.json({
      ok: true,
      backupId,
      installFolder: projectRoot,
      installedFiles: [
        installExe ? path.join(projectRoot, "main.exe") : null,
        installAdx ? path.join(projectRoot, `${stem}.adx`) : null,
      ].filter(Boolean),
      backups: backups.filter(Boolean),
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/launch", async (req, res, next) => {
  try {
    const exe = projectPath("main.exe");
    const useLocaleEmulator = req.body?.useLocaleEmulator !== false;
    const localeEmulator = useLocaleEmulator ? await findLocaleEmulator() : null;
    const command = localeEmulator || exe;
    const args = localeEmulator ? [exe] : [];
    const child = spawn(command, args, { cwd: projectRoot, detached: true, stdio: "ignore", windowsHide: false });
    child.unref();
    res.json({
      ok: true,
      pid: child.pid,
      launcher: localeEmulator ? "Locale Emulator" : "direct",
      locale: localeEmulator ? "ja-JP" : "system",
      localeEmulatorPath: localeEmulator,
      executable: exe,
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/backups", async (_req, res, next) => {
  try {
    const ids = (await exists(backupsRoot) ? await fs.readdir(backupsRoot, { withFileTypes: true }) : [])
      .filter((item) => item.isDirectory())
      .map((item) => item.name)
      .sort()
      .reverse();
    const backups = [];
    for (const id of ids) {
      const root = path.join(backupsRoot, id);
      const files = (await listFilesRecursive(root)).map((file) => path.relative(root, file));
      backups.push({ id, files });
    }
    res.json({ backups });
  } catch (error) {
    next(error);
  }
});

app.post("/api/restore", async (req, res, next) => {
  try {
    const { files = [] } = req.body;
    const backupId = safeBackupId(req.body.backupId);
    if (!backupId) {
      const error = new Error("backupId is required");
      error.status = 400;
      throw error;
    }
    const root = path.join(backupsRoot, backupId);
    if (!(await exists(root))) {
      const error = new Error(`Backup not found: ${backupId}`);
      error.status = 404;
      throw error;
    }
    const selected = files.length ? files : (await listFilesRecursive(root)).map((file) => path.relative(root, file));
    for (const relative of selected) {
      const source = backupPath(backupId, relative);
      const target = projectPath(relative);
      await copyWithParents(source, target);
    }
    res.json({ ok: true, restored: selected });
  } catch (error) {
    next(error);
  }
});

app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(error.status || 500).json({ error: error.message || "Internal server error" });
});

if (isProduction) {
  app.use(express.static(path.join(toolRoot, "dist")));
  app.get("*", (_req, res) => res.sendFile(path.join(toolRoot, "dist", "index.html")));
} else {
  const { createServer } = await import("vite");
  const vite = await createServer({
    root: toolRoot,
    server: { middlewareMode: true },
    appType: "spa",
  });
  app.use(vite.middlewares);
}

app.listen(port, "127.0.0.1", () => {
  console.log(`Megami translation tool: http://127.0.0.1:${port}`);
});
