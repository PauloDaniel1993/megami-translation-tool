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
const previousScenePromptBlockLimit = 24;
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
  const blockJobs = Array.isArray(report?.block_jobs) ? report.block_jobs : [];
  const lineOverrideBlocks = Array.isArray(report?.line_override_blocks) ? report.line_override_blocks : [];
  const unsafeBlockRanges = Array.isArray(report?.unsafe_block_ranges) ? report.unsafe_block_ranges : [];
  const insertedWindows = overflowPages.reduce((total, page) => total + Number(page.inserted_windows || 0), 0);
  const blockInsertedWindows = blockJobs.reduce((total, block) => total + Number(block.inserted_windows || 0), 0);
  return {
    exists: Boolean(report),
    path: relativePath,
    overflowPages: overflowPages.length,
    insertedWindows: insertedWindows + blockInsertedWindows,
    blockJobs: blockJobs.length,
    lineOverrideBlocks: lineOverrideBlocks.length,
    unsafeBlockRanges: unsafeBlockRanges.length,
    wrappedLines: wrappedLines.length,
    pages: overflowPages.map((page) => ({
      page_id: page.page_id,
      line_start: page.line_start,
      line_end: page.line_end,
      used_lines: page.used_lines,
      max_lines: page.max_lines,
      inserted_windows: page.inserted_windows,
    })),
    blocks: blockJobs.map((block) => ({
      block_id: block.block_id,
      page_start: block.page_start,
      page_end: block.page_end,
      line_start: block.line_start,
      line_end: block.line_end,
      body_line_count: block.body_line_count,
      window_count: block.window_count,
      inserted_windows: block.inserted_windows,
    })),
    unsafeBlocks: unsafeBlockRanges.map((block) => ({
      block_id: block.block_id,
      line_start: block.line_start,
      line_end: block.line_end,
      control_count: block.control_count,
      controls: block.controls,
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

async function requireFreshPatchedAdx(stem, slug) {
  const jobsPath = projectPath("patch_jobs", `${stem}_translated_jobs.${slug}.json`);
  const patchedPath = projectPath(`patched_adx_${slug}`, "variable", `${stem}.adx`);
  const reportPath = projectPath(`patched_adx_${slug}`, "patch_report.json");
  for (const requiredPath of [jobsPath, patchedPath, reportPath]) {
    if (!(await exists(requiredPath))) {
      const error = new Error(`Cannot install ADX because a required build artifact is missing: ${path.relative(projectRoot, requiredPath)}`);
      error.status = 400;
      throw error;
    }
  }
  const [jobsStat, patchedStat, reportStat] = await Promise.all([
    fs.stat(jobsPath),
    fs.stat(patchedPath),
    fs.stat(reportPath),
  ]);
  if (patchedStat.mtimeMs + 1000 < jobsStat.mtimeMs || reportStat.mtimeMs + 1000 < jobsStat.mtimeMs) {
    const error = new Error("Cannot install ADX because the patched output is older than the patch jobs. Run Reinsert successfully first.");
    error.status = 400;
    throw error;
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

async function loadBlockTranslationRecords(stem) {
  stem = safeStem(stem);
  const approvedPath = projectPath("translations", "approved", `${stem}.blocks.approved.jsonl`);
  const records = await readJsonl(approvedPath);
  const translations = new Map();
  for (const record of records) {
    if (record.block_id) translations.set(String(record.block_id), record);
  }
  return { approvedPath, records, translations };
}

async function loadTranslationPrompts(stem, options = {}) {
  stem = safeStem(stem);
  const includePrompt = options.includePrompt !== false;
  const onlyTargetType = options.targetType ? String(options.targetType) : null;
  const onlyTargetId = options.targetId ? String(options.targetId) : null;
  const promptPath = projectPath("qa", "reports", `${stem}_translation_prompts.jsonl`);
  const records = [];
  const normalize = (record, source) => {
    if (!record?.prompt) return null;
    const batchId = record.batch_id ? String(record.batch_id) : null;
    const lineId = record.line_id ? String(record.line_id) : null;
    const blockId = record.block_id ? String(record.block_id) : null;
    const targetType = record.target_type || (blockId ? "block" : lineId ? "line" : batchId ? "batch" : null);
    const targetId = record.target_id ? String(record.target_id) : blockId || lineId || batchId;
    if (!targetType || !targetId) return null;
    if (onlyTargetType && targetType !== onlyTargetType) return null;
    if (onlyTargetId && targetId !== onlyTargetId) return null;
    return {
      source,
      target_type: targetType,
      target_id: targetId,
      batch_id: batchId,
      line_id: lineId,
      block_id: blockId,
      has_prompt: true,
      prompt: includePrompt ? String(record.prompt) : "",
      prompt_parts: includePrompt && Array.isArray(record.prompt_parts) ? record.prompt_parts : null,
      status: record.status || null,
      created_at: record.created_at || null,
      model: record.model || null,
    };
  };

  for (const record of await readJsonl(promptPath)) {
    const normalized = normalize(record, "qa");
    if (normalized) records.push(normalized);
  }

  const suggestionsRoot = projectPath("translations", "suggestions", stem);
  const suggestionFiles = onlyTargetId
    ? [projectPath("translations", "suggestions", stem, `${safeSuggestionName(onlyTargetId)}.jsonl`)]
    : (await listFilesRecursive(suggestionsRoot)).filter((file) => file.endsWith(".jsonl"));
  for (const file of suggestionFiles) {
    for (const record of await readJsonl(file)) {
      const normalized = normalize(record, "suggestion");
      if (normalized) records.push(normalized);
    }
  }

  const timestamp = (record) => Date.parse(record.created_at || "") || 0;
  records.sort((a, b) => timestamp(a) - timestamp(b));
  const latestByTarget = new Map();
  for (const record of records) latestByTarget.set(`${record.target_type}:${record.target_id}`, record);
  return [...latestByTarget.values()].sort((a, b) => timestamp(b) - timestamp(a));
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

function applyChangesToRecords(records, changes, corpus, options = {}) {
  const existing = new Map();
  for (const record of records) {
    if (record.line_id) existing.set(String(record.line_id), record);
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
    if (options.lineOverride || change.layout_mode === "line" || change.line_override === true) {
      item.layout_mode = "line";
      item.line_override = true;
    }
    if (Object.prototype.hasOwnProperty.call(change, "block_id")) item.block_id = String(change.block_id || "");
    item.edited_at = new Date().toISOString();
    item.edited_by = "translation_tool";
  }
}

function applyBlockChangesToRecords(records, changes) {
  const existing = new Map();
  for (const record of records) {
    if (record.block_id) existing.set(String(record.block_id), record);
  }

  for (const change of changes) {
    const blockId = String(change.block_id || "");
    if (!blockId) continue;
    let item = existing.get(blockId);
    if (!item) {
      item = { block_id: blockId, en: "", notes: "" };
      records.push(item);
      existing.set(blockId, item);
    }
    if (Object.prototype.hasOwnProperty.call(change, "en")) item.en = String(change.en);
    if (Object.prototype.hasOwnProperty.call(change, "notes")) item.notes = String(change.notes);
    item.edited_at = new Date().toISOString();
    item.edited_by = "translation_tool";
  }
}

function clearLineOverridesForBlock(records, block) {
  const lineIds = new Set(block.line_ids || []);
  for (const record of records) {
    if (record.line_id && lineIds.has(String(record.line_id)) && lineOverrideEnabled(record)) {
      delete record.layout_mode;
      delete record.line_override;
    }
    if (!Array.isArray(record.translations)) continue;
    for (const item of record.translations) {
      if (!lineIds.has(String(item.line_id))) continue;
      if (lineOverrideEnabled(item)) {
        delete item.layout_mode;
        delete item.line_override;
      }
    }
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

const maxBlockPages = 8;
const maxBlockEntries = 16;

function splitTextLines(text) {
  return String(text || "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function wrapVisibleLine(line, maxChars) {
  const stripped = line.trim();
  if (!stripped) return [];
  if (stripped.length <= maxChars) return [stripped];
  const words = stripped.split(" ").filter(Boolean);
  if (words.length <= 1) {
    const chunks = [];
    for (let index = 0; index < stripped.length; index += maxChars) chunks.push(stripped.slice(index, index + maxChars));
    return chunks;
  }

  const wrapped = [];
  let current = "";
  for (let word of words) {
    while (word.length > maxChars) {
      if (current) {
        wrapped.push(current);
        current = "";
      }
      wrapped.push(word.slice(0, maxChars));
      word = word.slice(maxChars);
    }
    if (!word) continue;
    if (!current) current = word;
    else if (current.length + 1 + word.length <= maxChars) current = `${current} ${word}`;
    else {
      wrapped.push(current);
      current = word;
    }
  }
  if (current) wrapped.push(current);
  return wrapped;
}

function wrapTranslationLines(lines, maxChars) {
  return lines.flatMap((line) => wrapVisibleLine(line, maxChars));
}

function blockTranslatableEntries(pages) {
  const entries = [];
  for (const page of pages) {
    for (const entry of page.entries || []) {
      if (entry.translatable && !entry.auto) entries.push(entry);
    }
  }
  return entries;
}

function blockKey(page) {
  return [page.scene_id || "", page.page_role || "", page.speaker_en || page.speaker_jp || ""].join("|");
}

function pageSourceLines(page, includeTerminator = true) {
  const lines = (page.entries || []).map((entry) => String(entry.source_line));
  if (includeTerminator && page.terminator === "@h") lines.push("@h");
  return lines;
}

function pagesArePhysicallyContiguous(previous, current) {
  return Number(current.script_range_start) === Number(previous.script_range_end) + 1;
}

function finishBlock(pages) {
  if (!pages.length) return null;
  const entries = blockTranslatableEntries(pages);
  if (!entries.length) return null;
  const firstPage = pages[0];
  const lastPage = pages[pages.length - 1];
  const firstLine = Number(firstPage.start_line);
  const lastLine = Number(lastPage.end_line);
  const stem = String(firstPage.file).replace(/\.[^.]+$/, "");
  const sourceLines = pages.flatMap((page) => pageSourceLines(page, true));

  return {
    block_id: `${stem}:block:${String(firstLine).padStart(5, "0")}-${String(lastLine).padStart(5, "0")}`,
    file: firstPage.file,
    scene_id: firstPage.scene_id,
    scene_title_jp: firstPage.scene_title_jp,
    page_role: firstPage.page_role,
    speaker_jp: firstPage.speaker_jp,
    speaker_en: firstPage.speaker_en,
    page_start: Number(firstPage.page_index),
    page_end: Number(lastPage.page_index),
    line_start: firstLine,
    line_end: lastLine,
    script_range_start: Number(firstPage.script_range_start),
    script_range_end: Number(lastPage.script_range_end),
    textbox: firstPage.textbox || {},
    page_ids: pages.map((page) => page.page_id),
    line_ids: entries.map((entry) => entry.line_id),
    jp: entries.map((entry) => entry.jp).filter(Boolean).join("\n"),
    source_lines: sourceLines,
    pages,
  };
}

function buildBlocks(pages) {
  const blocks = [];
  let current = [];
  let currentKey = "";
  let currentEntries = 0;

  function flush() {
    const block = finishBlock(current);
    if (block) blocks.push(block);
    current = [];
    currentKey = "";
    currentEntries = 0;
  }

  for (const page of pages) {
    const entries = blockTranslatableEntries([page]);
    const safe = page.terminator === "@h" && entries.length > 0;
    const key = blockKey(page);
    const wouldExceed = current.length >= maxBlockPages || currentEntries + entries.length > maxBlockEntries;
    const crossesScriptGap = current.length && !pagesArePhysicallyContiguous(current[current.length - 1], page);

    if (!safe) {
      flush();
      continue;
    }
    if (current.length && (key !== currentKey || wouldExceed || crossesScriptGap)) flush();
    current.push(page);
    currentKey = key;
    currentEntries += entries.length;
  }
  flush();
  return blocks;
}

function blockBodyLines(block, en) {
  const maxChars = Number(block.textbox?.max_chars_per_line || 50);
  return wrapTranslationLines(splitTextLines(en), maxChars);
}

function speakerLinesForBlock(block) {
  const speaker = String(block.speaker_en || block.speaker_jp || "").trim();
  return speaker ? [speaker] : [];
}

function bodyCapacityForBlock(block) {
  const maxLines = Number(block.textbox?.max_lines_total || 4);
  if (block.page_role !== "dialogue") return maxLines;
  const capacity = maxLines - speakerLinesForBlock(block).length;
  if (capacity <= 0) return maxLines;
  return capacity;
}

function chunkLines(lines, size) {
  if (size <= 0) return [];
  const chunks = [];
  for (let index = 0; index < lines.length; index += size) chunks.push(lines.slice(index, index + size));
  return chunks;
}

function blockWindows(block, en) {
  const bodyLines = blockBodyLines(block, en);
  if (!bodyLines.length) return [];
  const chunks = chunkLines(bodyLines, bodyCapacityForBlock(block));
  if (block.page_role !== "dialogue") return chunks;
  const speakerLines = speakerLinesForBlock(block);
  return chunks.map((chunk) => [...speakerLines, ...chunk]);
}

function blockReplacementLines(block, en) {
  const windows = blockWindows(block, en);
  const lines = [];
  for (const [index, window] of windows.entries()) {
    if (index) lines.push("@h");
    lines.push(...window);
  }
  if (windows.length) lines.push("@h");
  return lines;
}

function blockPreview(block, en) {
  const windows = blockWindows(block, en);
  return {
    windows,
    window_count: windows.length,
    body_line_count: blockBodyLines(block, en).length,
    inserted_windows: Math.max(0, windows.length - 1),
    replacement_lines: blockReplacementLines(block, en),
  };
}

function lineOverrideEnabled(item) {
  return Boolean(item && (item.layout_mode === "line" || item.line_override === true));
}

function legacyLineCountForBlock(block, translations) {
  return (block.line_ids || []).filter((lineId) => String(translations.get(lineId)?.en || "").trim()).length;
}

function explicitLineOverrideCountForBlock(block, translations) {
  return (block.line_ids || []).filter((lineId) => lineOverrideEnabled(translations.get(lineId))).length;
}

function joinedLineTranslationForBlock(block, translations) {
  return (block.line_ids || [])
    .map((lineId) => String(translations.get(lineId)?.en || "").trim())
    .filter(Boolean)
    .join("\n");
}

function blockTranslationForPrompt(block, blockTranslations, lineTranslations) {
  return String(blockTranslations.get(block.block_id)?.en || joinedLineTranslationForBlock(block, lineTranslations) || "").trim();
}

function previousSceneTranslationsForPrompt(blocks, currentBlock, blockTranslations, lineTranslations) {
  const translatedBlocks = [];
  for (const block of blocks) {
    if (block.block_id === currentBlock.block_id) break;
    if (block.scene_id !== currentBlock.scene_id) continue;
    const en = blockTranslationForPrompt(block, blockTranslations, lineTranslations);
    if (!en) continue;
    translatedBlocks.push({
      block_id: block.block_id,
      page_role: block.page_role,
      speaker_en: block.speaker_en,
      jp: block.jp,
      en,
    });
  }
  const omitted = Math.max(0, translatedBlocks.length - previousScenePromptBlockLimit);
  return {
    scene_id: currentBlock.scene_id,
    omitted_earlier_translated_blocks: omitted,
    blocks: translatedBlocks.slice(-previousScenePromptBlockLimit),
  };
}

function blockEffectiveMode(block, blockRecord, translations) {
  if (explicitLineOverrideCountForBlock(block, translations)) return "lines";
  if (String(blockRecord?.en || "").trim()) return "block";
  if (legacyLineCountForBlock(block, translations)) return "legacy-lines";
  return "source";
}

function blockIssues(block, draft, textProfile) {
  const issues = new Set();
  const text = draft?.en ?? block.en ?? "";
  if (!String(text).trim()) issues.add("empty");
  if (textProfile === "vanilla" && String(text).includes("'")) issues.add("apostrophe");
  return [...issues];
}

function materializeBlockLineChanges(block, en) {
  const lineIds = block.line_ids || [];
  if (!lineIds.length) return [];
  const bodyLines = blockBodyLines(block, en);
  const buckets = lineIds.map(() => []);
  if (!bodyLines.length) {
    return lineIds.map((lineId) => ({ line_id: lineId, en: "" }));
  }
  for (const [index, line] of bodyLines.entries()) {
    const target = Math.min(index, lineIds.length - 1);
    buckets[target].push(line);
  }
  return lineIds.map((lineId, index) => ({ line_id: lineId, en: buckets[index].join("\n") }));
}

function buildBlockRows(blocks, blockTranslations, lineTranslations, textProfile) {
  return blocks.map((block) => {
    const current = blockTranslations.get(block.block_id);
    const seed = joinedLineTranslationForBlock(block, lineTranslations);
    const en = current?.en ?? seed;
    const row = {
      ...block,
      en,
      notes: current?.notes ?? "",
      metadata: current || {},
      has_block_translation: Boolean(String(current?.en || "").trim()),
      legacy_line_count: legacyLineCountForBlock(block, lineTranslations),
      line_override_count: explicitLineOverrideCountForBlock(block, lineTranslations),
      effective_mode: blockEffectiveMode(block, current, lineTranslations),
      preview: blockPreview(block, en),
    };
    row.issues = blockIssues(row, { en, notes: row.notes }, textProfile);
    return row;
  });
}

function promptPart(id, label, content, rows = 5) {
  return {
    id,
    label,
    content: String(content ?? ""),
    rows,
  };
}

function normalizePromptPart(part, index) {
  return {
    id: String(part?.id || `part-${index + 1}`),
    label: String(part?.label || part?.id || `Part ${index + 1}`),
    content: String(part?.content ?? ""),
    rows: Number(part?.rows || 5),
  };
}

function promptPartsToText(parts) {
  return (Array.isArray(parts) ? parts : [])
    .map((part, index) => normalizePromptPart(part, index))
    .map((part) => part.content.trimEnd())
    .filter((content) => content.trim())
    .join("\n\n");
}

async function buildDeepSeekPromptParts(stem, lineId, instruction, textProfile) {
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

  const parts = [
    promptPart(
      "task",
      "Task and Response Schema",
      `Retranslate one visual novel line from Japanese to natural English.

Return JSON only with this schema:
{"en":"...","notes":"..."}`,
      4,
    ),
    promptPart(
      "rules",
      "Rules",
      `Rules:
- Keep each physical line at or below ${entry.max_chars || 50} visible characters.
- Preserve character voice and page rhythm.
- ${profileRule}
- If the current translation is awkward, improve it rather than paraphrasing mechanically.`,
      6,
    ),
    promptPart(
      "instruction",
      "Optional User Instruction",
      `Optional user instruction:
${instruction || "(none)"}`,
      4,
    ),
    promptPart(
      "global_style",
      "Global Style",
      `Global style:
${globalStyle}`,
      8,
    ),
    promptPart(
      "glossary",
      "Glossary",
      `Glossary:
${JSON.stringify(glossary, null, 2)}`,
      10,
    ),
    promptPart(
      "character_card",
      "Character Card",
      `Character card:
${characterCard || "(none)"}`,
      8,
    ),
    promptPart(
      "scene_summary",
      "Scene Summary",
      `Scene summary:
${JSON.stringify(sceneSummary || {}, null, 2)}`,
      8,
    ),
    promptPart(
      "previous_page",
      "Previous Page",
      `Previous page:
${JSON.stringify(pageForPrompt(pages[pageIndex - 1]), null, 2)}`,
      10,
    ),
    promptPart(
      "current_page",
      "Current Page",
      `Current page:
${JSON.stringify(pageForPrompt(page), null, 2)}`,
      12,
    ),
    promptPart(
      "next_page",
      "Next Page",
      `Next page:
${JSON.stringify(pageForPrompt(pages[pageIndex + 1]), null, 2)}`,
      10,
    ),
    promptPart(
      "target",
      "Target",
      `Target:
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
)}`,
      8,
    ),
  ];

  return { targetType: "line", targetId: lineId, parts };
}

async function buildDeepSeekPrompt(stem, lineId, instruction, textProfile) {
  const { parts } = await buildDeepSeekPromptParts(stem, lineId, instruction, textProfile);
  return promptPartsToText(parts);
}

async function buildBlockDeepSeekPromptParts(stem, blockId, instruction, textProfile) {
  const corpus = await loadCorpus(stem);
  const { translations: lineTranslations } = await loadTranslationRecords(stem);
  const { translations: blockTranslations } = await loadBlockTranslationRecords(stem);
  const blocks = buildBlocks(corpus.pages);
  const block = blocks.find((row) => row.block_id === blockId);
  if (!block) throw new Error(`Unknown block_id: ${blockId}`);
  const firstPageIndex = corpus.pages.findIndex((page) => page.page_id === block.page_ids[0]);
  const lastPageIndex = corpus.pages.findIndex((page) => page.page_id === block.page_ids[block.page_ids.length - 1]);
  const current = blockTranslations.get(blockId);
  const glossary = await readJson(projectPath("translations", "context", "glossary.json"), {});
  const globalStyle = (await fs.readFile(projectPath("translations", "context", "global_style.md"), "utf8")).slice(0, 5000);
  const sceneSummary = Array.isArray(corpus.sceneSummaries)
    ? corpus.sceneSummaries.find((row) => row.scene_id === block.scene_id)
    : null;

  let characterCard = "";
  const profile = glossary.characters?.find((row) => row.jp === block.speaker_jp || row.en === block.speaker_en)?.profile;
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
      current_en: lineTranslations.get(row.line_id)?.en || "",
    })),
  });

  const profileRule =
    textProfile === "apostrophe-patched"
      ? "ASCII apostrophes and contractions are allowed. Do not use curly quotes, em dashes, en dashes, or ellipsis characters."
      : "Do not use apostrophes or contractions. Use ASCII punctuation and three periods for ellipses.";

  const parts = [
    promptPart(
      "task",
      "Task and Response Schema",
      `Translate one complete visual novel block from Japanese to natural English.

Return JSON only with this schema:
{"en":"...","notes":"..."}`,
      4,
    ),
    promptPart(
      "rules",
      "Rules",
      `Rules:
- Translate the block as a coherent passage, not as isolated source lines.
- Do not manually insert @h or speaker names. The tool will wrap lines and create game windows automatically.
- Preserve character voice, narrative flow, and important pauses.
- ${profileRule}
- The English may be longer or shorter than the Japanese if that improves quality.`,
      7,
    ),
    promptPart(
      "instruction",
      "Optional User Instruction",
      `Optional user instruction:
${instruction || "(none)"}`,
      4,
    ),
    promptPart(
      "global_style",
      "Global Style",
      `Global style:
${globalStyle}`,
      8,
    ),
    promptPart(
      "glossary",
      "Glossary",
      `Glossary:
${JSON.stringify(glossary, null, 2)}`,
      10,
    ),
    promptPart(
      "character_card",
      "Character Card",
      `Character card:
${characterCard || "(none)"}`,
      8,
    ),
    promptPart(
      "scene_summary",
      "Scene Summary",
      `Scene summary:
${JSON.stringify(sceneSummary || {}, null, 2)}`,
      8,
    ),
    promptPart(
      "previous_scene_translations",
      "Previous Scene Translations",
      `Previous translated blocks in this scene:
${JSON.stringify(previousSceneTranslationsForPrompt(blocks, block, blockTranslations, lineTranslations), null, 2)}`,
      10,
    ),
    promptPart(
      "previous_page",
      "Previous Page",
      `Previous page:
${JSON.stringify(pageForPrompt(corpus.pages[firstPageIndex - 1]), null, 2)}`,
      10,
    ),
    promptPart(
      "current_block",
      "Current Block",
      `Current block:
${JSON.stringify(
  {
    block_id: block.block_id,
    page_role: block.page_role,
    speaker_en: block.speaker_en,
    jp: block.jp,
    current_en: current?.en || joinedLineTranslationForBlock(block, lineTranslations),
    line_ids: block.line_ids,
  },
  null,
  2,
)}`,
      12,
    ),
    promptPart(
      "next_page",
      "Next Page",
      `Next page:
${JSON.stringify(pageForPrompt(corpus.pages[lastPageIndex + 1]), null, 2)}`,
      10,
    ),
  ];

  return { targetType: "block", targetId: blockId, parts };
}

async function buildBlockDeepSeekPrompt(stem, blockId, instruction, textProfile) {
  const { parts } = await buildBlockDeepSeekPromptParts(stem, blockId, instruction, textProfile);
  return promptPartsToText(parts);
}

async function callDeepSeek(prompt, model, temperature, signal) {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    const error = new Error("Missing DEEPSEEK_API_KEY in translation_tool/.env or environment");
    error.status = 400;
    throw error;
  }
  const response = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    signal,
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
  const content = payload?.choices?.[0]?.message?.content;
  if (!content) {
    const detail = payload.error?.message || payload.message || JSON.stringify(payload).slice(0, 800);
    throw new Error(`DeepSeek response missing message content for ${model}: ${detail}`);
  }
  try {
    return JSON.parse(content);
  } catch (error) {
    throw new Error(`DeepSeek returned invalid JSON for ${model}: ${error.message}`);
  }
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

async function listCorpusStems() {
  const corpusDir = projectPath("work", "corpus");
  const stems = [];
  if (!(await exists(corpusDir))) return stems;
  for (const name of await fs.readdir(corpusDir)) {
    if (name.endsWith(".pages.jsonl")) stems.push(name.replace(/\.pages\.jsonl$/, ""));
  }
  return stems.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

async function buildFileProgress(stem) {
  stem = safeStem(stem);
  const corpus = await loadCorpus(stem);
  const { records: lineRecords, translations: lineTranslations } = await loadTranslationRecords(stem);
  const { records: blockRecords, translations: blockTranslations } = await loadBlockTranslationRecords(stem);
  const rows = buildRows(corpus, lineTranslations);
  const blocks = buildBlockRows(buildBlocks(corpus.pages), blockTranslations, lineTranslations, "apostrophe-patched");
  const editableRows = rows.filter((row) => row.editable);
  const translatedBlocks = blocks.filter((block) => String(block.en || "").trim()).length;
  const translatedLines = editableRows.filter((row) => String(row.en || "").trim()).length;
  return {
    stem,
    file: `${stem}.adx`,
    scenes: Array.isArray(corpus.scenes) ? corpus.scenes.length : 0,
    totalBlocks: blocks.length,
    translatedBlocks,
    untranslatedBlocks: Math.max(0, blocks.length - translatedBlocks),
    totalLines: editableRows.length,
    translatedLines,
    untranslatedLines: Math.max(0, editableRows.length - translatedLines),
    approvedExists: lineRecords.length > 0,
    blockApprovedExists: blockRecords.length > 0,
    activeBlocks: blocks.filter((block) => block.effective_mode === "block").length,
    lineOverrideBlocks: blocks.filter((block) => block.effective_mode === "lines").length,
  };
}

app.get("/api/files", async (_req, res, next) => {
  try {
    const files = [];
    for (const stem of await listCorpusStems()) {
      const approvedPath = projectPath("translations", "approved", `${stem}.approved.jsonl`);
      const cleanPath = projectPath("work", "clean_source", `${stem}.adx`);
      files.push({
        stem,
        file: `${stem}.adx`,
        approvedExists: await exists(approvedPath),
        cleanSourceExists: await exists(cleanPath),
      });
    }
    res.json({ files });
  } catch (error) {
    next(error);
  }
});

app.get("/api/progress", async (_req, res, next) => {
  try {
    const files = [];
    for (const stem of await listCorpusStems()) {
      try {
        files.push(await buildFileProgress(stem));
      } catch (error) {
        files.push({
          stem,
          file: `${stem}.adx`,
          error: error.message,
          scenes: 0,
          totalBlocks: 0,
          translatedBlocks: 0,
          untranslatedBlocks: 0,
          totalLines: 0,
          translatedLines: 0,
          untranslatedLines: 0,
        });
      }
    }
    const overall = files.reduce((summary, file) => ({
      totalFiles: summary.totalFiles + 1,
      completeFiles: summary.completeFiles + (file.totalBlocks > 0 && file.translatedBlocks >= file.totalBlocks ? 1 : 0),
      totalBlocks: summary.totalBlocks + Number(file.totalBlocks || 0),
      translatedBlocks: summary.translatedBlocks + Number(file.translatedBlocks || 0),
      totalLines: summary.totalLines + Number(file.totalLines || 0),
      translatedLines: summary.translatedLines + Number(file.translatedLines || 0),
    }), {
      totalFiles: 0,
      completeFiles: 0,
      totalBlocks: 0,
      translatedBlocks: 0,
      totalLines: 0,
      translatedLines: 0,
    });
    overall.untranslatedBlocks = Math.max(0, overall.totalBlocks - overall.translatedBlocks);
    overall.untranslatedLines = Math.max(0, overall.totalLines - overall.translatedLines);
    res.json({ overall, files });
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
    const {
      approvedPath: blockApprovedPath,
      records: blockRecords,
      translations: blockTranslations,
    } = await loadBlockTranslationRecords(stem);
    const translationPrompts = await loadTranslationPrompts(stem, { includePrompt: false });
    const overflowReportRelative = path.join("patch_jobs", `${stem}_translated_jobs.${slug}.overflow_report.json`);
    const overflowReport = await readJson(projectPath(overflowReportRelative), null);
    const rows = buildRows(corpus, translations).map((row) => ({
      ...row,
      issues: lineIssues(row, textProfile),
    }));
    const blocks = buildBlockRows(buildBlocks(corpus.pages), blockTranslations, translations, textProfile);
    res.json({
      stem,
      file: `${stem}.adx`,
      textProfile,
      approvedPath: path.relative(projectRoot, approvedPath),
      blockApprovedPath: path.relative(projectRoot, blockApprovedPath),
      approvedExists: records.length > 0,
      blockApprovedExists: blockRecords.length > 0,
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
      blocks,
      stats: summarizeRows(rows),
      blockStats: {
        totalBlocks: blocks.length,
        translated: blocks.filter((block) => String(block.en || "").trim()).length,
        activeBlocks: blocks.filter((block) => block.effective_mode === "block").length,
        lineOverrideBlocks: blocks.filter((block) => block.effective_mode === "lines").length,
      },
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/files/:stem/prompts/:targetType/:targetId", async (req, res, next) => {
  try {
    const stem = safeStem(req.params.stem);
    const targetType = String(req.params.targetType || "");
    const targetId = String(req.params.targetId || "");
    if (!["batch", "line", "block"].includes(targetType) || !targetId) {
      const error = new Error("Valid targetType and targetId are required");
      error.status = 400;
      throw error;
    }
    const [prompt] = await loadTranslationPrompts(stem, {
      includePrompt: true,
      targetType,
      targetId,
    });
    if (!prompt) {
      const error = new Error(`Prompt not found for ${targetType}:${targetId}`);
      error.status = 404;
      throw error;
    }
    res.json({ prompt });
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
    applyChangesToRecords(records, changes, corpus, { lineOverride: req.body.layoutMode === "line" });
    await writeJsonl(approvedPath, records);
    res.json({ ok: true, saved: changes.length, backupId, backup });
  } catch (error) {
    next(error);
  }
});

app.post("/api/files/:stem/blocks/save", async (req, res, next) => {
  try {
    const stem = safeStem(req.params.stem);
    const changes = Array.isArray(req.body.changes) ? req.body.changes : [];
    if (!changes.length) return res.json({ ok: true, saved: 0 });
    const corpus = await loadCorpus(stem);
    const blocks = buildBlocks(corpus.pages);
    const blockById = new Map(blocks.map((block) => [block.block_id, block]));
    const { approvedPath: lineApprovedPath, records: lineRecords } = await loadTranslationRecords(stem);
    const { approvedPath, records } = await loadBlockTranslationRecords(stem);
    const backupId = timestampId();
    const backups = [await backupFile(approvedPath, backupId), await backupFile(lineApprovedPath, backupId)].filter(Boolean);

    for (const change of changes) {
      const block = blockById.get(String(change.block_id || ""));
      if (block) clearLineOverridesForBlock(lineRecords, block);
    }
    applyBlockChangesToRecords(records, changes);
    await writeJsonl(approvedPath, records);
    await writeJsonl(lineApprovedPath, lineRecords);
    res.json({ ok: true, saved: changes.length, backupId, backups });
  } catch (error) {
    next(error);
  }
});

app.post("/api/files/:stem/blocks/split-to-lines", async (req, res, next) => {
  try {
    const stem = safeStem(req.params.stem);
    const blockId = String(req.body.blockId || "");
    const en = String(req.body.en || "");
    if (!blockId) {
      const error = new Error("blockId is required");
      error.status = 400;
      throw error;
    }
    const corpus = await loadCorpus(stem);
    const block = buildBlocks(corpus.pages).find((row) => row.block_id === blockId);
    if (!block) {
      const error = new Error(`Unknown block_id: ${blockId}`);
      error.status = 404;
      throw error;
    }
    const { approvedPath, records } = await loadTranslationRecords(stem);
    const backupId = timestampId();
    const backup = await backupFile(approvedPath, backupId);
    const changes = materializeBlockLineChanges(block, en).map((change) => ({
      ...change,
      block_id: blockId,
      layout_mode: "line",
      line_override: true,
    }));
    applyChangesToRecords(records, changes, corpus, { lineOverride: true });
    await writeJsonl(approvedPath, records);
    res.json({ ok: true, saved: changes.length, backupId, backup, firstLineId: changes[0]?.line_id || null, changes });
  } catch (error) {
    next(error);
  }
});

app.post("/api/files/:stem/deepseek-prompt", async (req, res, next) => {
  try {
    const stem = safeStem(req.params.stem);
    const {
      lineId,
      blockId,
      instruction = "",
      textProfile = "apostrophe-patched",
    } = req.body;
    if (!lineId && !blockId) {
      const error = new Error("lineId or blockId is required");
      error.status = 400;
      throw error;
    }
    const payload = blockId
      ? await buildBlockDeepSeekPromptParts(stem, String(blockId), instruction, textProfile)
      : await buildDeepSeekPromptParts(stem, String(lineId), instruction, textProfile);
    res.json({ ok: true, ...payload, prompt: promptPartsToText(payload.parts) });
  } catch (error) {
    next(error);
  }
});

app.post("/api/files/:stem/retranslate", async (req, res, next) => {
  const abortController = new AbortController();
  req.on("aborted", () => abortController.abort());
  res.on("close", () => {
    if (!res.writableEnded) abortController.abort();
  });
  try {
    const stem = safeStem(req.params.stem);
    const {
      lineId,
      blockId,
      instruction = "",
      textProfile = "apostrophe-patched",
      model = "deepseek-v4-flash",
      promptParts,
    } = req.body;
    if (!lineId && !blockId) {
      const error = new Error("lineId or blockId is required");
      error.status = 400;
      throw error;
    }
    const promptPayload = Array.isArray(promptParts) && promptParts.length
      ? {
          targetType: blockId ? "block" : "line",
          targetId: blockId ? String(blockId) : String(lineId),
          parts: promptParts.map((part, index) => normalizePromptPart(part, index)),
        }
      : blockId
        ? await buildBlockDeepSeekPromptParts(stem, String(blockId), instruction, textProfile)
        : await buildDeepSeekPromptParts(stem, String(lineId), instruction, textProfile);
    const prompt = promptPartsToText(promptPayload.parts);
    if (!prompt.trim()) {
      const error = new Error("Prompt is empty");
      error.status = 400;
      throw error;
    }
    const result = await callDeepSeek(prompt, model, Number(req.body.temperature ?? 0.2), abortController.signal);
    const targetId = blockId ? String(blockId) : String(lineId);
    const row = {
      created_at: new Date().toISOString(),
      stem,
      target_type: blockId ? "block" : "line",
      target_id: targetId,
      line_id: lineId || null,
      block_id: blockId || null,
      text_profile: textProfile,
      model,
      instruction,
      prompt,
      prompt_parts: promptPayload.parts,
      suggestion: result,
    };
    await appendJsonl(projectPath("translations", "suggestions", stem, `${safeSuggestionName(targetId)}.jsonl`), row);
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
      "--block-translations",
      `translations/approved/${stem}.blocks.approved.jsonl`,
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
      "--block-translations",
      `translations/approved/${stem}.blocks.approved.jsonl`,
      "--jobs",
      jobs,
      "--source-dir",
      "work/clean_source",
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
    const report = result.exitCode === 0 ? await readJson(projectPath(outDir, "patch_report.json"), null) : null;
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
    if (installAdx) await requireFreshPatchedAdx(stem, slug);
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
