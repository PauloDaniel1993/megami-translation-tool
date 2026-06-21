import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  BarChart3,
  Bot,
  ChevronDown,
  CheckCircle2,
  Download,
  FileJson,
  Moon,
  Play,
  RefreshCw,
  RotateCcw,
  Save,
  Search,
  ShieldCheck,
  Sun,
  Trash2,
  Wrench,
  X,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { ThemeProvider, useTheme } from "@/components/theme-provider";
import { cn } from "@/lib/utils";
import "./styles.css";

const ISSUE_LABELS = {
  apostrophe: "apostrophe",
  empty: "empty",
  line_too_long: "wrap needed",
};

const BATCH_SHARED_PROMPT_PART_IDS = new Set(["task", "rules", "instruction", "global_style", "glossary"]);
const DEEPSEEK_LOOP_MODEL = "deepseek-v4-pro";
const DEEPSEEK_LOOP_RETRIES = 3;

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
  return payload;
}

function clampInteger(value, fallback, min, max) {
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

function mergeBlockBatchPromptParts(defaultParts, editedParts) {
  const editedById = new Map((editedParts || []).map((part) => [part.id, part]));
  return (defaultParts || []).map((part) => {
    const edited = editedById.get(part.id);
    if (!edited || !BATCH_SHARED_PROMPT_PART_IDS.has(part.id)) return part;
    return {
      ...part,
      content: edited.content,
      rows: edited.rows ?? part.rows,
    };
  });
}

async function runWithConcurrency(items, limit, worker, signal) {
  const queue = [...items];
  const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length && !signal?.aborted) {
      const item = queue.shift();
      await worker(item);
    }
  });
  await Promise.all(workers);
}

function rowIssues(row, draft, textProfile) {
  const issues = new Set();
  const text = draft?.en ?? row.en ?? "";
  const lines = splitTextLines(text);

  if (row.editable && !text.trim()) issues.add("empty");
  for (const line of lines) {
    if (line.trim().length > row.max_chars) issues.add("line_too_long");
  }
  if (textProfile === "vanilla" && text.includes("'")) issues.add("apostrophe");
  return [...issues];
}

function blockIssues(block, draft, textProfile) {
  const issues = new Set();
  const text = draft?.en ?? block.en ?? "";
  if (!String(text).trim()) issues.add("empty");
  if (textProfile === "vanilla" && String(text).includes("'")) issues.add("apostrophe");
  return [...issues];
}

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
  if (!stripped || stripped.length <= maxChars) return stripped ? [stripped] : [];
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

function wrappedLineCount(text, maxChars) {
  const lines = splitTextLines(text);
  if (!lines.length) return 0;
  return lines.reduce((total, line) => total + wrapVisibleLine(line, maxChars).length, 0);
}

function plannedLineCount(row) {
  if (!row) return 0;
  if (row.auto) return 1;
  const text = row.draft?.en ?? row.en ?? "";
  if (!String(text).trim()) return 1;
  return Math.max(1, wrappedLineCount(text, Number(row.max_chars || 50)));
}

function countEntryBoundedWindows(counts, capacity) {
  if (capacity <= 0) return 1;
  let windows = 0;
  let current = 0;
  for (const count of counts) {
    const lines = Math.max(1, count);
    const chunks = Math.ceil(lines / capacity);
    if (chunks === 1) {
      if (current && current + lines > capacity) {
        windows += 1;
        current = 0;
      }
      current += lines;
      continue;
    }

    if (current) {
      windows += 1;
      current = 0;
    }
    windows += chunks;
  }
  if (current) windows += 1;
  return Math.max(1, windows);
}

function estimatePageWindows(selected, rows) {
  if (!selected) return null;
  const pageRows = rows.filter((row) => row.page_id === selected.page_id);
  const maxLines = Number(selected.textbox?.max_lines_total || 4);
  const speakerPresent = Boolean(selected.textbox?.speaker_present);
  const usedLines = pageRows.reduce((total, row) => total + plannedLineCount(row), 0);
  const speakerLines = pageRows
    .filter((row) => row.role === "speaker")
    .reduce((total, row) => total + plannedLineCount(row), 0);
  let totalWindows = countEntryBoundedWindows(pageRows.map(plannedLineCount), maxLines);
  if (speakerPresent && speakerLines > 0 && speakerLines < maxLines) {
    const bodyCounts = pageRows.filter((row) => row.role !== "speaker").map(plannedLineCount);
    totalWindows = countEntryBoundedWindows(bodyCounts.length ? bodyCounts : [0], maxLines - speakerLines);
  }
  return {
    pageRows,
    usedLines,
    maxLines,
    speakerLines,
    selectedLines: plannedLineCount(selected),
    totalWindows,
    extraWindows: Math.max(0, totalWindows - 1),
  };
}

function estimateBlockPreview(block) {
  if (!block) return null;
  const text = block.draft?.en ?? block.en ?? "";
  const maxChars = Number(block.textbox?.max_chars_per_line || 50);
  const maxLines = Number(block.textbox?.max_lines_total || 4);
  const bodyLines = splitTextLines(text).flatMap((line) => wrapVisibleLine(line, maxChars));
  if (!bodyLines.length) {
    return { windows: [], window_count: 0, body_line_count: 0, inserted_windows: 0 };
  }
  const speaker = block.speaker_en || block.speaker_jp || "";
  const speakerLines = block.page_role === "dialogue" && speaker ? [speaker] : [];
  const capacity = Math.max(1, maxLines - speakerLines.length);
  const windows = [];
  for (let index = 0; index < bodyLines.length; index += capacity) {
    const chunk = bodyLines.slice(index, index + capacity);
    windows.push([...speakerLines, ...chunk]);
  }
  return {
    windows,
    window_count: windows.length,
    body_line_count: bodyLines.length,
    inserted_windows: Math.max(0, windows.length - 1),
  };
}

function speakerName(row) {
  if (!row) return "";
  return row.speaker_en || row.speaker_jp || (row.role === "narration" || row.page_role === "narration" ? "Narration" : "No speaker");
}

function issueLabel(issue) {
  return ISSUE_LABELS[issue] || issue;
}

function validationIssueLabel(issue) {
  return issueLabel(String(issue || "validation_error")).replace(/_/g, " ");
}

function validationFailureSummary(row) {
  if (row.issue === "unsafe_block_script_controls") {
    const pieces = [];
    if (row.line_start && row.line_end) pieces.push(`lines ${row.line_start}-${row.line_end}`);
    if (row.count) pieces.push(`${row.count} control command${row.count === 1 ? "" : "s"}`);
    if (Array.isArray(row.controls) && row.controls.length) {
      const controls = row.controls.slice(0, 4).join(", ");
      pieces.push(`controls: ${controls}${row.controls.length > 4 ? ", ..." : ""}`);
    }
    pieces.push("split this block before building jobs");
    return pieces.join(" | ");
  }
  const pieces = [];
  if (row.used_lines && row.max_lines) pieces.push(`${row.used_lines}/${row.max_lines} lines`);
  if (row.count) pieces.push(`count ${row.count}`);
  if (row.length) pieces.push(`${row.length} chars`);
  if (row.max) pieces.push(`max ${row.max}`);
  if (row.error) pieces.push(String(row.error));
  return pieces.join(" | ");
}

function codePointLabel(char) {
  return `U+${char.codePointAt(0).toString(16).toUpperCase().padStart(4, "0")}`;
}

function validationProblemChars(row) {
  const raw = [];
  if (Array.isArray(row.chars)) raw.push(...row.chars);
  if (row.char) raw.push(row.char);
  if (!raw.length && /cp932|disallowed/.test(String(row.issue || ""))) {
    raw.push(...Array.from(String(row.en || "")).filter((char) => {
      const code = char.codePointAt(0);
      return (code < 32 && char !== "\n" && char !== "\r" && char !== "\t") || code > 126;
    }));
  }

  const seen = new Set();
  return raw
    .map((item) => (typeof item === "string" ? { char: item } : item))
    .filter((item) => item?.char && !seen.has(item.char) && seen.add(item.char))
    .map((item) => ({
      char: item.char,
      name: item.name || "",
      label: `${item.char} (${codePointLabel(item.char)})${item.name ? ` ${item.name}` : ""}`,
    }));
}

function validationExcerpt(row, problemChars) {
  const text = String(row.en || "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  const firstChar = problemChars[0]?.char;
  const index = firstChar ? text.indexOf(firstChar) : -1;
  if (index < 0) return text.length > 120 ? `${text.slice(0, 117)}...` : text;
  const start = Math.max(0, index - 45);
  const end = Math.min(text.length, index + firstChar.length + 45);
  return `${start > 0 ? "..." : ""}${text.slice(start, end)}${end < text.length ? "..." : ""}`;
}

function compactCommand(result) {
  if (!result) return "";
  const pieces = [];
  if (result.command) pieces.push(result.command);
  if (typeof result.exitCode === "number") pieces.push(`exit ${result.exitCode}`);
  if (result.report) pieces.push(result.report.ok ? "validation ok" : `${result.report.failures?.length || 0} failures`);
  if (result.source) pieces.push(`source ${result.source}`);
  if (result.current?.state) pieces.push(`main.exe ${result.current.state}`);
  if (result.jobs) pieces.push(result.jobs);
  if (result.overflowReport?.exists) pieces.push(`${result.overflowReport.insertedWindows || 0} auto @h`);
  if (result.outDir) pieces.push(result.outDir);
  if (result.installFolder) pieces.push(`install folder ${result.installFolder}`);
  if (result.backupId) pieces.push(`backup ${result.backupId}`);
  if (result.launcher) pieces.push(`launcher ${result.launcher}`);
  if (result.locale) pieces.push(`locale ${result.locale}`);
  if (result.localeEmulatorPath) pieces.push(result.localeEmulatorPath);
  return pieces.join(" | ");
}

function workflowFailureOutput(failure) {
  if (!failure) return "";
  return [failure.stderr, failure.stdout]
    .filter(Boolean)
    .join("\n")
    .trim();
}

function workflowFailurePreview(failure) {
  const output = workflowFailureOutput(failure);
  if (!output) return "";
  return output.length > 1800 ? `${output.slice(0, 1800)}\n...` : output;
}

function Icon({ children }) {
  return React.cloneElement(children, { "data-icon": "inline-start" });
}

function TooltipButton({ tooltip, children, className, wrapperClassName, ...props }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className={cn("inline-flex", wrapperClassName)} title={tooltip}>
          <Button className={className} title={tooltip} {...props}>
            {children}
          </Button>
        </span>
      </TooltipTrigger>
      <TooltipContent>{tooltip}</TooltipContent>
    </Tooltip>
  );
}

function AppSelect({ value, onValueChange, label, className, children }) {
  return (
    <Select value={value} onValueChange={onValueChange}>
      <SelectTrigger aria-label={label} title={`Change ${label.toLowerCase()}`} className={cn("w-full", className)}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>{children}</SelectGroup>
      </SelectContent>
    </Select>
  );
}

function MetricBadge({ children, variant = "secondary" }) {
  return (
    <Badge variant={variant} className="h-7 rounded-md px-2.5 font-medium">
      {children}
    </Badge>
  );
}

function percentComplete(done, total) {
  if (!total) return 0;
  if (done >= total) return 100;
  return Math.min(99.9, Math.round((done / total) * 1000) / 10);
}

function ProgressMeter({ value, title }) {
  const safeValue = Math.min(100, Math.max(0, Number(value) || 0));
  return (
    <div
      className="h-2 overflow-hidden rounded-full bg-muted"
      role="progressbar"
      aria-label={title}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={safeValue}
      title={`${title}: ${safeValue}%`}
    >
      <div className="h-full rounded-full bg-primary transition-[width] duration-200" style={{ width: `${safeValue}%` }} />
    </div>
  );
}

function progressToneClass(value) {
  const safeValue = Math.min(100, Math.max(0, Number(value) || 0));
  if (safeValue >= 100) return "bg-chart-2";
  if (safeValue >= 66) return "bg-primary";
  if (safeValue >= 33) return "bg-chart-3";
  return "bg-destructive";
}

function CollapsibleHeader({ icon, title, badge, open, onToggle }) {
  return (
    <Button
      type="button"
      variant="ghost"
      className="h-10 w-full justify-between rounded-none px-3"
      aria-expanded={open}
      title={`${open ? "Collapse" : "Expand"} ${title}`}
      onClick={onToggle}
    >
      <span className="flex min-w-0 items-center gap-2">
        {icon}
        <span className="truncate font-medium">{title}</span>
      </span>
      <span className="flex items-center gap-2">
        {badge}
        <ChevronDown className={cn("size-4 text-muted-foreground transition-transform", open && "rotate-180")} />
      </span>
    </Button>
  );
}

function ThemeSwitch() {
  const { resolvedTheme, setTheme } = useTheme();
  const isDark = resolvedTheme === "dark";
  const tooltip = isDark ? "Switch to light theme" : "Switch to dark theme";

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className="flex items-center gap-2 rounded-lg border bg-card px-2 py-1" title={tooltip}>
          <Sun className="size-3.5 text-muted-foreground" />
          <Switch
            checked={isDark}
            onCheckedChange={(checked) => setTheme(checked ? "dark" : "light")}
            title={tooltip}
            aria-label={tooltip}
          />
          <Moon className="size-3.5 text-muted-foreground" />
        </div>
      </TooltipTrigger>
      <TooltipContent>{tooltip}</TooltipContent>
    </Tooltip>
  );
}

function App() {
  const [health, setHealth] = useState(null);
  const [files, setFiles] = useState([]);
  const [stem, setStem] = useState("");
  const [textProfile, setTextProfile] = useState("apostrophe-patched");
  const [payload, setPayload] = useState(null);
  const [drafts, setDrafts] = useState({});
  const [blockDrafts, setBlockDrafts] = useState({});
  const [dirty, setDirty] = useState(new Set());
  const [blockDirty, setBlockDirty] = useState(new Set());
  const [viewMode, setViewMode] = useState("blocks");
  const [selectedId, setSelectedId] = useState("");
  const [selectedBlockId, setSelectedBlockId] = useState("");
  const [query, setQuery] = useState("");
  const [roleFilter, setRoleFilter] = useState("all");
  const [issueFilter, setIssueFilter] = useState("all");
  const [sceneFilter, setSceneFilter] = useState("all");
  const [suggestion, setSuggestion] = useState(null);
  const [instruction] = useState("");
  const [deepSeekModalOpen, setDeepSeekModalOpen] = useState(false);
  const [deepSeekLoopModalOpen, setDeepSeekLoopModalOpen] = useState(false);
  const [deepSeekModel, setDeepSeekModel] = useState("deepseek-v4-flash");
  const [deepSeekTemperature, setDeepSeekTemperature] = useState("0.2");
  const [deepSeekPromptParts, setDeepSeekPromptParts] = useState([]);
  const [deepSeekPromptLoading, setDeepSeekPromptLoading] = useState(false);
  const [deepSeekBlockCount, setDeepSeekBlockCount] = useState("1");
  const [deepSeekParallelCount, setDeepSeekParallelCount] = useState("1");
  const [deepSeekLoopStartMode, setDeepSeekLoopStartMode] = useState("selected");
  const [deepSeekProgress, setDeepSeekProgress] = useState(null);
  const [deepSeekCancelling, setDeepSeekCancelling] = useState(false);
  const [validationReport, setValidationReport] = useState(null);
  const [busy, setBusy] = useState("");
  const [workflowFailure, setWorkflowFailure] = useState(null);
  const [workflowLog, setWorkflowLog] = useState([]);
  const [backups, setBackups] = useState([]);
  const [progressSummary, setProgressSummary] = useState(null);
  const [filePanelOpen, setFilePanelOpen] = useState(false);
  const [progressPanelOpen, setProgressPanelOpen] = useState(false);
  const [searchPanelOpen, setSearchPanelOpen] = useState(true);
  const [promptOpen, setPromptOpen] = useState(false);
  const [capturedPromptDetail, setCapturedPromptDetail] = useState(null);
  const [capturedPromptLoading, setCapturedPromptLoading] = useState(false);
  const blockEditorRef = useRef(null);
  const lineEditorRef = useRef(null);
  const deepSeekAbortRef = useRef(null);

  async function loadFiles() {
    const [healthPayload, filesPayload, backupsPayload, progressPayload] = await Promise.all([
      api("/api/health"),
      api("/api/files"),
      api("/api/backups"),
      api("/api/progress"),
    ]);
    setHealth(healthPayload);
    setFiles(filesPayload.files);
    setBackups(backupsPayload.backups || []);
    setProgressSummary(progressPayload);
    if (!stem && filesPayload.files[0]) setStem(filesPayload.files[0].stem);
  }

  async function loadStem(nextStem = stem, nextProfile = textProfile) {
    if (!nextStem) return;
    setBusy("load");
    try {
      const data = await api(`/api/files/${nextStem}?textProfile=${encodeURIComponent(nextProfile)}`);
      const nextDrafts = {};
      for (const row of data.rows) nextDrafts[row.line_id] = { en: row.en || "", notes: row.notes || "" };
      const nextBlockDrafts = {};
      for (const block of data.blocks || []) nextBlockDrafts[block.block_id] = { en: block.en || "", notes: block.notes || "" };
      setPayload(data);
      setDrafts(nextDrafts);
      setBlockDrafts(nextBlockDrafts);
      setDirty(new Set());
      setBlockDirty(new Set());
      setSelectedId(data.rows.find((row) => row.editable)?.line_id || data.rows[0]?.line_id || "");
      setSelectedBlockId(data.blocks?.find((block) => String(block.en || "").trim())?.block_id || data.blocks?.[0]?.block_id || "");
      setSuggestion(null);
    } finally {
      setBusy("");
    }
  }

  useEffect(() => {
    loadFiles().catch((error) => setWorkflowLog((log) => [`Startup failed: ${error.message}`, ...log]));
  }, []);

  useEffect(() => {
    if (stem) loadStem(stem, textProfile).catch((error) => setWorkflowLog((log) => [`Load failed: ${error.message}`, ...log]));
  }, [stem, textProfile]);

  useEffect(() => {
    setPromptOpen(false);
    setDeepSeekPromptParts([]);
    setCapturedPromptDetail(null);
  }, [selectedId, selectedBlockId, viewMode, stem]);

  const rows = payload?.rows || [];
  const blocks = payload?.blocks || [];
  const rowsWithDrafts = useMemo(
    () =>
      rows.map((row) => ({
        ...row,
        draft: drafts[row.line_id] || { en: row.en || "", notes: row.notes || "" },
        currentIssues: rowIssues(row, drafts[row.line_id], textProfile),
        isDirty: dirty.has(row.line_id),
      })),
    [rows, drafts, dirty, textProfile],
  );
  const blocksWithDrafts = useMemo(
    () =>
      blocks.map((block) => ({
        ...block,
        draft: blockDrafts[block.block_id] || { en: block.en || "", notes: block.notes || "" },
        currentIssues: blockIssues(block, blockDrafts[block.block_id], textProfile),
        isDirty: blockDirty.has(block.block_id),
      })),
    [blocks, blockDrafts, blockDirty, textProfile],
  );

  const scenes = useMemo(() => {
    const seen = new Map();
    for (const row of rowsWithDrafts) {
      if (!seen.has(row.scene_id)) seen.set(row.scene_id, row.scene_title_jp || row.scene_id);
    }
    return [...seen.entries()];
  }, [rowsWithDrafts]);

  const filteredRows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rowsWithDrafts.filter((row) => {
      if (roleFilter !== "all" && row.role !== roleFilter) return false;
      if (sceneFilter !== "all" && row.scene_id !== sceneFilter) return false;
      if (issueFilter === "dirty" && !row.isDirty) return false;
      if (issueFilter === "untranslated" && row.draft.en.trim()) return false;
      if (issueFilter !== "all" && issueFilter !== "dirty" && issueFilter !== "untranslated" && !row.currentIssues.includes(issueFilter)) {
        return false;
      }
      if (!q) return true;
      return [row.line_id, row.jp, row.draft.en, row.speaker_en, row.scene_title_jp]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(q));
    });
  }, [rowsWithDrafts, query, roleFilter, issueFilter, sceneFilter]);

  const filteredBlocks = useMemo(() => {
    const q = query.trim().toLowerCase();
    return blocksWithDrafts.filter((block) => {
      if (roleFilter !== "all" && block.page_role !== roleFilter) return false;
      if (sceneFilter !== "all" && block.scene_id !== sceneFilter) return false;
      if (issueFilter === "dirty" && !block.isDirty) return false;
      if (issueFilter === "untranslated" && block.draft.en.trim()) return false;
      if (issueFilter !== "all" && issueFilter !== "dirty" && issueFilter !== "untranslated" && !block.currentIssues.includes(issueFilter)) {
        return false;
      }
      if (!q) return true;
      return [block.block_id, block.jp, block.draft.en, block.speaker_en, block.scene_title_jp]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(q));
    });
  }, [blocksWithDrafts, query, roleFilter, issueFilter, sceneFilter]);

  const selected = rowsWithDrafts.find((row) => row.line_id === selectedId) || filteredRows[0] || rowsWithDrafts[0];
  const selectedBlock = blocksWithDrafts.find((block) => block.block_id === selectedBlockId) || filteredBlocks[0] || blocksWithDrafts[0];
  const selectedIndex = selected ? rowsWithDrafts.findIndex((row) => row.line_id === selected.line_id) : -1;
  const selectedSceneId = viewMode === "blocks" ? selectedBlock?.scene_id : selected?.scene_id;
  const sceneSummary = selectedSceneId ? (payload?.sceneSummaries || []).find((scene) => scene.scene_id === selectedSceneId) : null;
  const promptLookup = useMemo(() => {
    const byBatch = new Map();
    const byLine = new Map();
    const byBlock = new Map();
    for (const prompt of payload?.translationPrompts || []) {
      if (prompt.batch_id) byBatch.set(prompt.batch_id, prompt);
      if (prompt.line_id) byLine.set(prompt.line_id, prompt);
      if (prompt.block_id) byBlock.set(prompt.block_id, prompt);
      if (prompt.target_type === "batch" && prompt.target_id) byBatch.set(prompt.target_id, prompt);
      if (prompt.target_type === "line" && prompt.target_id) byLine.set(prompt.target_id, prompt);
      if (prompt.target_type === "block" && prompt.target_id) byBlock.set(prompt.target_id, prompt);
    }
    return { byBatch, byLine, byBlock };
  }, [payload]);
  const selectedPrompt =
    viewMode === "blocks"
      ? (selectedBlock?.block_id ? promptLookup.byBlock.get(selectedBlock.block_id) : null)
      : selected?.line_id
        ? promptLookup.byLine.get(selected.line_id) || (selected.batch_id ? promptLookup.byBatch.get(selected.batch_id) : null)
        : null;
  const selectedPromptLabel =
    selectedPrompt?.target_id || selectedPrompt?.block_id || selectedPrompt?.line_id || selectedPrompt?.batch_id || null;
  const selectedPromptDetail =
    capturedPromptDetail?.target_type === selectedPrompt?.target_type && capturedPromptDetail?.target_id === selectedPromptLabel
      ? capturedPromptDetail
      : selectedPrompt;
  const selectedPromptText = selectedPromptDetail?.prompt || "";

  useEffect(() => {
    if (!promptOpen || !selectedPrompt?.target_type || !selectedPromptLabel || !stem) {
      setCapturedPromptDetail(null);
      setCapturedPromptLoading(false);
      return undefined;
    }
    let cancelled = false;
    setCapturedPromptLoading(true);
    api(
      `/api/files/${stem}/prompts/${encodeURIComponent(selectedPrompt.target_type)}/${encodeURIComponent(selectedPromptLabel)}`,
    )
      .then((result) => {
        if (!cancelled) setCapturedPromptDetail(result.prompt || null);
      })
      .catch((error) => {
        if (!cancelled) {
          setCapturedPromptDetail(null);
          setWorkflowLog((log) => [`DeepSeek prompt capture failed: ${error.message}`, ...log]);
        }
      })
      .finally(() => {
        if (!cancelled) setCapturedPromptLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [promptOpen, selectedPrompt?.target_type, selectedPromptLabel, stem]);
  const previousTranslations =
    selectedIndex > -1
      ? rowsWithDrafts
          .slice(0, selectedIndex)
          .filter((row) => row.scene_id === selected.scene_id && row.editable && row.draft.en.trim())
          .slice(-6)
      : [];
  const selectedBlockIndex = selectedBlock ? blocksWithDrafts.findIndex((block) => block.block_id === selectedBlock.block_id) : -1;
  const previousBlocks =
    selectedBlockIndex > -1
      ? blocksWithDrafts
          .slice(0, selectedBlockIndex)
          .filter((block) => block.scene_id === selectedBlock.scene_id && block.draft.en.trim())
          .slice(-4)
      : [];

  function updateDraft(lineId, patch) {
    setDrafts((current) => ({
      ...current,
      [lineId]: { ...(current[lineId] || {}), ...patch },
    }));
    setDirty((current) => new Set(current).add(lineId));
  }

  function updateBlockDraft(blockId, patch) {
    setBlockDrafts((current) => ({
      ...current,
      [blockId]: { ...(current[blockId] || {}), ...patch },
    }));
    setBlockDirty((current) => new Set(current).add(blockId));
  }

  async function saveChanges(lineIds) {
    const ids = lineIds || [...dirty];
    const changes = ids.map((lineId) => ({
      line_id: lineId,
      en: drafts[lineId]?.en || "",
      notes: drafts[lineId]?.notes || "",
    }));
    if (!changes.length) return;
    setBusy("save");
    try {
      const result = await api(`/api/files/${stem}/save`, {
        method: "POST",
        body: JSON.stringify({ changes, layoutMode: "line" }),
      });
      setWorkflowLog((log) => [`Saved ${result.saved} line(s), backup ${result.backupId}`, ...log]);
      await loadStem(stem, textProfile);
      await loadFiles();
    } catch (error) {
      setWorkflowLog((log) => [`Save failed: ${error.message}`, ...log]);
    } finally {
      setBusy("");
    }
  }

  async function saveBlockChanges(blockIds) {
    const ids = blockIds || [...blockDirty];
    const changes = ids.map((blockId) => ({
      block_id: blockId,
      en: blockDrafts[blockId]?.en || "",
      notes: blockDrafts[blockId]?.notes || "",
    }));
    if (!changes.length) return;
    setBusy("save");
    try {
      const result = await api(`/api/files/${stem}/blocks/save`, {
        method: "POST",
        body: JSON.stringify({ changes }),
      });
      setWorkflowLog((log) => [`Saved ${result.saved} block(s), backup ${result.backupId}`, ...log]);
      await loadStem(stem, textProfile);
      await loadFiles();
    } catch (error) {
      setWorkflowLog((log) => [`Block save failed: ${error.message}`, ...log]);
    } finally {
      setBusy("");
    }
  }

  async function splitSelectedBlockToLines() {
    if (!selectedBlock) {
      setViewMode("lines");
      return;
    }
    if (!String(selectedBlock.draft.en || "").trim()) {
      setSelectedId(selectedBlock.line_ids?.[0] || selectedId);
      setViewMode("lines");
      return;
    }
    setBusy("split");
    try {
      const result = await api(`/api/files/${stem}/blocks/split-to-lines`, {
        method: "POST",
        body: JSON.stringify({
          blockId: selectedBlock.block_id,
          en: selectedBlock.draft.en || "",
        }),
      });
      setWorkflowLog((log) => [`Split ${selectedBlock.block_id} into ${result.saved} line override(s), backup ${result.backupId}`, ...log]);
      await loadStem(stem, textProfile);
      setViewMode("lines");
      if (result.firstLineId) setSelectedId(result.firstLineId);
      await loadFiles();
    } catch (error) {
      setWorkflowLog((log) => [`Split failed: ${error.message}`, ...log]);
    } finally {
      setBusy("");
    }
  }

  async function chooseViewMode(nextMode) {
    if (nextMode === viewMode) return;
    if (nextMode === "blocks" && roleFilter === "speaker") setRoleFilter("all");
    if (nextMode === "lines" && viewMode === "blocks") {
      await splitSelectedBlockToLines();
      return;
    }
    setViewMode(nextMode);
  }

  function updateDeepSeekPromptPart(partId, content) {
    setDeepSeekPromptParts((current) =>
      current.map((part) => (part.id === partId ? { ...part, content } : part)),
    );
  }

  function clearSelectedTranslation() {
    if (viewMode === "blocks") {
      if (!selectedBlock) return;
      updateBlockDraft(selectedBlock.block_id, { en: "" });
      setSuggestion(null);
      setWorkflowLog((log) => [`Cleared draft for ${selectedBlock.block_id}; Save to persist`, ...log]);
      requestAnimationFrame(() => blockEditorRef.current?.focus());
      return;
    }
    if (!selected || !selected.editable) return;
    updateDraft(selected.line_id, { en: "" });
    setSuggestion(null);
    setWorkflowLog((log) => [`Cleared draft for ${selected.line_id}; Save to persist`, ...log]);
    requestAnimationFrame(() => lineEditorRef.current?.focus());
  }

  function clearAllTranslations() {
    if (viewMode === "blocks") {
      if (!blocksWithDrafts.length) return;
      if (!window.confirm(`Clear all ${blocksWithDrafts.length} block translation drafts? Use Save all to persist.`)) return;
      setBlockDrafts((current) => {
        const next = { ...current };
        for (const block of blocksWithDrafts) {
          next[block.block_id] = { ...(next[block.block_id] || block.draft || {}), en: "" };
        }
        return next;
      });
      setBlockDirty(new Set(blocksWithDrafts.map((block) => block.block_id)));
      setSuggestion(null);
      setWorkflowLog((log) => [`Cleared ${blocksWithDrafts.length} block draft(s); Save all to persist`, ...log]);
      return;
    }

    const editableRows = rowsWithDrafts.filter((row) => row.editable);
    if (!editableRows.length) return;
    if (!window.confirm(`Clear all ${editableRows.length} line translation drafts? Use Save all to persist.`)) return;
    setDrafts((current) => {
      const next = { ...current };
      for (const row of editableRows) {
        next[row.line_id] = { ...(next[row.line_id] || row.draft || {}), en: "" };
      }
      return next;
    });
    setDirty(new Set(editableRows.map((row) => row.line_id)));
    setSuggestion(null);
    setWorkflowLog((log) => [`Cleared ${editableRows.length} line draft(s); Save all to persist`, ...log]);
  }

  function resolveValidationFailure(row) {
    const rawId = String(row?.line_id || "");
    if (!rawId) return null;

    const block = blocksWithDrafts.find((item) => (
      item.block_id === rawId ||
      item.page_ids?.includes(rawId) ||
      item.line_ids?.includes(rawId)
    ));
    if (block) return { mode: "blocks", id: block.block_id };

    const line = rowsWithDrafts.find((item) => item.line_id === rawId);
    if (line) return { mode: "lines", id: line.line_id };

    const pageLine = rowsWithDrafts.find((item) => item.page_id === rawId);
    if (pageLine) return { mode: "lines", id: pageLine.line_id };

    return null;
  }

  function openValidationFailure(row) {
    const target = resolveValidationFailure(row);
    if (!target) {
      setWorkflowLog((log) => [`Could not locate validation target ${row?.line_id || "(unknown)"}`, ...log]);
      return;
    }
    setSuggestion(null);
    setPromptOpen(false);
    if (target.mode === "blocks") {
      if (roleFilter === "speaker") setRoleFilter("all");
      setViewMode("blocks");
      setSelectedBlockId(target.id);
      requestAnimationFrame(() => blockEditorRef.current?.scrollIntoView({ block: "center", behavior: "smooth" }));
    } else {
      setViewMode("lines");
      setSelectedId(target.id);
      requestAnimationFrame(() => lineEditorRef.current?.scrollIntoView({ block: "center", behavior: "smooth" }));
    }
  }

  async function loadDeepSeekPromptParts() {
    if (viewMode === "blocks" && !selectedBlock) return;
    if (viewMode === "lines" && !selected) return;
    setDeepSeekPromptLoading(true);
    try {
      const result = await api(`/api/files/${stem}/deepseek-prompt`, {
        method: "POST",
        body: JSON.stringify({
          lineId: viewMode === "lines" ? selected.line_id : undefined,
          blockId: viewMode === "blocks" ? selectedBlock.block_id : undefined,
          instruction,
          textProfile,
        }),
      });
      setDeepSeekPromptParts(result.parts || []);
    } catch (error) {
      setWorkflowLog((log) => [`DeepSeek prompt failed: ${error.message}`, ...log]);
      setDeepSeekModalOpen(false);
    } finally {
      setDeepSeekPromptLoading(false);
    }
  }

  async function openDeepSeekModal() {
    setDeepSeekModalOpen(true);
    setDeepSeekPromptParts([]);
    await loadDeepSeekPromptParts();
  }

  function cancelDeepSeekRequest() {
    if (!deepSeekAbortRef.current || deepSeekAbortRef.current.signal.aborted) return;
    setDeepSeekCancelling(true);
    setDeepSeekProgress((current) => (current ? { ...current, cancelling: true } : current));
    deepSeekAbortRef.current.abort();
  }

  function openDeepSeekLoopModal() {
    if (!blocksWithDrafts.length) return;
    const availableCount = Math.max(loopAvailableBlockCount, 1);
    const nextCount = clampInteger(deepSeekBlockCount, 1, 1, availableCount);
    setDeepSeekBlockCount(String(nextCount));
    setDeepSeekLoopModalOpen(true);
  }

  async function runWorkflow(label, path, body = {}) {
    setBusy(label);
    try {
      const result = await api(path, { method: "POST", body: JSON.stringify(body) });
      const failed = typeof result.exitCode === "number" && result.exitCode !== 0;
      const summary = compactCommand(result) || "ok";
      setWorkflowLog((log) => [`${label}${failed ? " failed" : ""}: ${summary}`, result.stdout, result.stderr, ...log].filter(Boolean));
      setWorkflowFailure(failed ? { label, summary, ...result } : null);
      if (result.overflowReport) {
        setPayload((current) => (current ? { ...current, overflowReport: result.overflowReport } : current));
      }
      if (label === "validate" || result.report) {
        setValidationReport(result.report || null);
      }
      await loadFiles();
      return result;
    } catch (error) {
      setWorkflowFailure({ label, summary: error.message, stderr: error.message });
      setWorkflowLog((log) => [`${label} failed: ${error.message}`, ...log]);
      return null;
    } finally {
      setBusy("");
    }
  }

  async function askDeepSeek() {
    if (viewMode === "blocks" && !selectedBlock) return;
    if (viewMode === "lines" && !selected) return;
    const targetMode = viewMode;
    const targetLineId = targetMode === "lines" ? selected.line_id : null;
    const targetBlockId = targetMode === "blocks" ? selectedBlock.block_id : null;
    const targetId = targetBlockId || targetLineId;
    const blockTargets = targetMode === "blocks" ? deepSeekBlockTargets : [];
    const parallelCount = targetMode === "blocks" ? requestedDeepSeekParallelCount : 1;
    const totalCount = targetMode === "blocks" ? blockTargets.length : 1;
    let completedCount = 0;
    let failedCount = 0;
    const temperature = Number(deepSeekTemperature);
    if (!Number.isFinite(temperature) || temperature < 0 || temperature > 2) {
      setWorkflowLog((log) => ["DeepSeek failed: temperature must be between 0 and 2", ...log]);
      return;
    }
    const controller = new AbortController();
    deepSeekAbortRef.current = controller;
    setDeepSeekCancelling(false);
    setBusy("deepseek");
    setSuggestion(null);
    setDeepSeekModalOpen(false);
    setDeepSeekProgress({
      done: 0,
      failed: 0,
      total: totalCount,
      mode: targetMode,
      parallel: parallelCount,
    });
    try {
      if (targetMode === "blocks") {
        const failures = [];
        await runWithConcurrency(blockTargets, parallelCount, async (block) => {
          if (controller.signal.aborted) return;
          try {
            const promptPayload = block.block_id === targetBlockId
              ? { parts: deepSeekPromptParts }
              : await api(`/api/files/${stem}/deepseek-prompt`, {
                  method: "POST",
                  signal: controller.signal,
                  body: JSON.stringify({
                    blockId: block.block_id,
                    instruction,
                    textProfile,
                  }),
                });
            const result = await api(`/api/files/${stem}/retranslate`, {
              method: "POST",
              signal: controller.signal,
              body: JSON.stringify({
                blockId: block.block_id,
                instruction,
                textProfile,
                model: deepSeekModel.trim() || "deepseek-v4-flash",
                temperature,
                promptParts:
                  block.block_id === targetBlockId
                    ? deepSeekPromptParts
                    : mergeBlockBatchPromptParts(promptPayload.parts || [], deepSeekPromptParts),
              }),
            });
            updateBlockDraft(block.block_id, { en: result.suggestion?.en || "" });
            if (block.block_id === targetBlockId) setSuggestion(result.suggestion);
          } catch (error) {
            if (controller.signal.aborted) throw error;
            failedCount += 1;
            failures.push(`${block.block_id}: ${error.message}`);
          } finally {
            if (!controller.signal.aborted) {
              completedCount += 1;
              setDeepSeekProgress({
                done: completedCount,
                failed: failedCount,
                total: totalCount,
                mode: targetMode,
                parallel: parallelCount,
              });
            }
          }
        }, controller.signal);
        setSelectedBlockId(targetBlockId);
        requestAnimationFrame(() => blockEditorRef.current?.scrollIntoView({ block: "center", behavior: "smooth" }));
        setWorkflowLog((log) => [
          `DeepSeek batch applied ${blockTargets.length - failedCount}/${blockTargets.length} block draft(s) with ${parallelCount} parallel request(s); review, then Save all`,
          ...failures,
          ...log,
        ]);
      } else {
        const result = await api(`/api/files/${stem}/retranslate`, {
          method: "POST",
          signal: controller.signal,
          body: JSON.stringify({
            lineId: targetLineId,
            instruction,
            textProfile,
            model: deepSeekModel.trim() || "deepseek-v4-flash",
            temperature,
            promptParts: deepSeekPromptParts,
          }),
        });
        setSuggestion(result.suggestion);
        setSelectedId(targetLineId);
        updateDraft(targetLineId, { en: result.suggestion?.en || "" });
        completedCount = 1;
        setDeepSeekProgress({ done: 1, failed: 0, total: 1, mode: targetMode, parallel: 1 });
        requestAnimationFrame(() => lineEditorRef.current?.scrollIntoView({ block: "center", behavior: "smooth" }));
        setWorkflowLog((log) => [
          `DeepSeek applied to draft for ${targetId}; review it, then Save`,
          ...log,
        ]);
      }
    } catch (error) {
      if (controller.signal.aborted) {
        setWorkflowLog((log) => [`DeepSeek cancelled after ${completedCount}/${totalCount} completed`, ...log]);
      } else {
        setWorkflowLog((log) => [`DeepSeek failed: ${error.message}`, ...log]);
      }
    } finally {
      setBusy("");
      setDeepSeekProgress(null);
      setDeepSeekCancelling(false);
      if (deepSeekAbortRef.current === controller) deepSeekAbortRef.current = null;
    }
  }

  async function runDeepSeekLoop() {
    if (!blocksWithDrafts.length) return;
    const blockTargets = deepSeekLoopBlockTargets;
    const totalCount = blockTargets.length;
    if (!totalCount) {
      const reason =
        deepSeekLoopStartMode === "after-last-translated"
          ? "no blocks available after the last translated block"
          : "no blocks available from the selected block";
      setWorkflowLog((log) => [`DeepSeek Loop skipped: ${reason}.`, ...log]);
      return;
    }
    const temperature = Number(deepSeekTemperature);
    if (!Number.isFinite(temperature) || temperature < 0 || temperature > 2) {
      setWorkflowLog((log) => ["DeepSeek Loop failed: temperature must be between 0 and 2", ...log]);
      return;
    }

    const controller = new AbortController();
    deepSeekAbortRef.current = controller;
    setDeepSeekCancelling(false);
    setBusy("deepseek");
    setSuggestion(null);
    setDeepSeekModalOpen(false);
    setDeepSeekLoopModalOpen(false);
    setWorkflowLog((log) => [
      `DeepSeek Loop starting ${totalCount} block(s) from ${blockTargets[0].block_id} (${deepSeekLoopStartMode}) with ${DEEPSEEK_LOOP_MODEL}`,
      ...log,
    ]);
    setDeepSeekProgress({
      done: 0,
      failed: 0,
      total: totalCount,
      mode: "loop",
      parallel: 1,
    });

    let completedCount = 0;
    let failedCount = 0;
    let pendingChanges = [];
    let stopReason = "";

    async function savePendingChanges(reason) {
      if (!pendingChanges.length) return null;
      const changes = pendingChanges;
      pendingChanges = [];
      try {
        const result = await api(`/api/files/${stem}/blocks/save`, {
          method: "POST",
          body: JSON.stringify({ changes }),
        });
        setWorkflowLog((log) => [
          `DeepSeek Loop saved ${result.saved} translated block(s) after ${reason}, backup ${result.backupId}`,
          ...log,
        ]);
        return result;
      } catch (error) {
        pendingChanges = [...changes, ...pendingChanges];
        throw error;
      }
    }

    async function refreshAfterLoopSave() {
      await loadStem(stem, textProfile);
      await loadFiles();
    }

    async function flushAndRefresh(reason) {
      await savePendingChanges(reason);
      await refreshAfterLoopSave();
    }

    function promptPartsForLoopBlock(block, defaultParts) {
      if (!deepSeekPromptParts.length) return defaultParts || [];
      if (block.block_id === selectedBlock?.block_id) return deepSeekPromptParts;
      return mergeBlockBatchPromptParts(defaultParts || [], deepSeekPromptParts);
    }

    async function saveBlockForNextPrompt(change) {
      pendingChanges.push(change);
      await savePendingChanges(change.block_id);
    }

    try {
      for (const block of blockTargets) {
        if (controller.signal.aborted) break;
        setSelectedBlockId(block.block_id);
        let blockResult = null;
        let lastError = null;
        for (let attempt = 1; attempt <= DEEPSEEK_LOOP_RETRIES + 1; attempt += 1) {
          if (controller.signal.aborted) break;
          try {
            const promptPayload = await api(`/api/files/${stem}/deepseek-prompt`, {
              method: "POST",
              signal: controller.signal,
              body: JSON.stringify({
                blockId: block.block_id,
                instruction,
                textProfile,
              }),
            });
            blockResult = await api(`/api/files/${stem}/retranslate`, {
              method: "POST",
              signal: controller.signal,
              body: JSON.stringify({
                blockId: block.block_id,
                instruction,
                textProfile,
                model: DEEPSEEK_LOOP_MODEL,
                temperature,
                promptParts: promptPartsForLoopBlock(block, promptPayload.parts || []),
              }),
            });
            lastError = null;
            break;
          } catch (error) {
            if (controller.signal.aborted) throw error;
            lastError = error;
            if (attempt <= DEEPSEEK_LOOP_RETRIES) {
              setWorkflowLog((log) => [
                `DeepSeek Loop retry ${attempt}/${DEEPSEEK_LOOP_RETRIES} for ${block.block_id}: ${error.message}`,
                ...log,
              ]);
            }
          }
        }

        if (!blockResult) {
          failedCount += 1;
          stopReason = `${block.block_id} failed after ${DEEPSEEK_LOOP_RETRIES} retries: ${lastError?.message || "unknown error"}`;
          setDeepSeekProgress({
            done: completedCount,
            failed: failedCount,
            total: totalCount,
            mode: "loop",
            parallel: 1,
          });
          throw new Error(stopReason);
        }

        const en = blockResult.suggestion?.en || "";
        const notes = block.draft?.notes || "";
        updateBlockDraft(block.block_id, { en });
        setSuggestion(blockResult.suggestion);
        await saveBlockForNextPrompt({ block_id: block.block_id, en, notes });
        completedCount += 1;
        setDeepSeekProgress({
          done: completedCount,
          failed: failedCount,
          total: totalCount,
          mode: "loop",
          parallel: 1,
        });
      }

      if (controller.signal.aborted) {
        await flushAndRefresh("cancellation");
        setWorkflowLog((log) => [`DeepSeek Loop cancelled after ${completedCount}/${totalCount} completed`, ...log]);
        return;
      }

      await flushAndRefresh("completion");
      setWorkflowLog((log) => [
        `DeepSeek Loop translated and saved ${completedCount}/${totalCount} block(s) sequentially with ${DEEPSEEK_LOOP_MODEL}`,
        ...log,
      ]);
    } catch (error) {
      if (controller.signal.aborted) {
        await flushAndRefresh("cancellation");
        setWorkflowLog((log) => [`DeepSeek Loop cancelled after ${completedCount}/${totalCount} completed`, ...log]);
      } else {
        try {
          await flushAndRefresh("failure");
        } catch (saveError) {
          setWorkflowLog((log) => [`DeepSeek Loop save failed after stopping: ${saveError.message}`, ...log]);
        }
        setWorkflowLog((log) => [`DeepSeek Loop stopped: ${stopReason || error.message}`, ...log]);
      }
    } finally {
      setBusy("");
      setDeepSeekProgress(null);
      setDeepSeekCancelling(false);
      if (deepSeekAbortRef.current === controller) deepSeekAbortRef.current = null;
    }
  }

  async function installBuild() {
    if (!window.confirm("Install patched executable and ADX into the game folder? A backup will be created first.")) return;
    await runWorkflow("install", "/api/install", { stem, textProfile, installExe: true, installAdx: true });
    await loadFiles();
  }

  async function restoreBackup(id) {
    if (!id || !window.confirm(`Restore backup ${id}?`)) return;
    await runWorkflow("restore", "/api/restore", { backupId: id });
    await loadFiles();
  }

  const latestBackup = backups[0];
  const translated = rowsWithDrafts.filter((row) => row.editable && row.draft.en.trim()).length;
  const editable = rowsWithDrafts.filter((row) => row.editable).length;
  const blockTranslated = blocksWithDrafts.filter((block) => block.draft.en.trim()).length;
  const blockProgressPercent = percentComplete(blockTranslated, blocksWithDrafts.length);
  const lineProgressPercent = percentComplete(translated, editable);
  const fileProgressRows = progressSummary?.files || [];
  const translatableFileRows = useMemo(
    () =>
      fileProgressRows
        .filter((file) => Number(file.totalBlocks || 0) > 0 || Number(file.totalLines || 0) > 0)
        .sort((a, b) => (
          Number(b.totalBlocks || 0) - Number(a.totalBlocks || 0) ||
          Number(b.totalLines || 0) - Number(a.totalLines || 0) ||
          String(a.file || a.stem).localeCompare(String(b.file || b.stem), undefined, { numeric: true })
        )),
    [fileProgressRows],
  );
  const selectedFileProgress = fileProgressRows.find((file) => file.stem === stem) || null;
  const overallProgress = progressSummary?.overall || null;
  const overallProgressPercent = overallProgress
    ? percentComplete(overallProgress.translatedBlocks, overallProgress.totalBlocks)
    : blockProgressPercent;
  const sceneProgress = useMemo(() => {
    const byScene = new Map();
    for (const block of blocksWithDrafts) {
      const sceneId = block.scene_id || "unknown";
      const current = byScene.get(sceneId) || {
        sceneId,
        title: block.scene_title_jp || sceneId,
        totalBlocks: 0,
        translatedBlocks: 0,
        totalLines: 0,
        translatedLines: 0,
      };
      current.totalBlocks += 1;
      if (String(block.draft.en || "").trim()) current.translatedBlocks += 1;
      byScene.set(sceneId, current);
    }
    for (const row of rowsWithDrafts) {
      if (!row.editable) continue;
      const sceneId = row.scene_id || "unknown";
      const current = byScene.get(sceneId) || {
        sceneId,
        title: row.scene_title_jp || sceneId,
        totalBlocks: 0,
        translatedBlocks: 0,
        totalLines: 0,
        translatedLines: 0,
      };
      current.totalLines += 1;
      if (String(row.draft.en || "").trim()) current.translatedLines += 1;
      byScene.set(sceneId, current);
    }
    return [...byScene.values()]
      .map((scene) => ({
        ...scene,
        blockPercent: percentComplete(scene.translatedBlocks, scene.totalBlocks),
        linePercent: percentComplete(scene.translatedLines, scene.totalLines),
      }))
      .sort((a, b) => {
        const firstBlock = blocksWithDrafts.find((block) => block.scene_id === a.sceneId);
        const secondBlock = blocksWithDrafts.find((block) => block.scene_id === b.sceneId);
        return Number(firstBlock?.line_start || 0) - Number(secondBlock?.line_start || 0);
      });
  }, [blocksWithDrafts, rowsWithDrafts]);
  const hasAnyBlockTranslationDraft = blocksWithDrafts.some((block) => String(block.draft.en || "").trim());
  const hasAnyLineTranslationDraft = rowsWithDrafts.some((row) => row.editable && String(row.draft.en || "").trim());
  const lineFailures = rowsWithDrafts.filter((row) => row.currentIssues.length && row.editable).length;
  const blockFailures = blocksWithDrafts.filter((block) => block.currentIssues.length).length;
  const failures = viewMode === "blocks" ? blockFailures : lineFailures;
  const overflowReport = payload?.overflowReport;
  const autoBreaks = overflowReport?.insertedWindows || 0;
  const selectedWindowStats = estimatePageWindows(selected, rowsWithDrafts);
  const selectedBlockPreview = estimateBlockPreview(selectedBlock);
  const reportedOverflowPage = selected
    ? overflowReport?.pages?.find((page) => page.page_id === selected.page_id)
    : null;
  const selectedBlockReport = selectedBlock
    ? overflowReport?.blocks?.find((block) => block.block_id === selectedBlock.block_id)
    : null;
  const remainingBlockCount = viewMode === "blocks" && selectedBlockIndex > -1 ? blocksWithDrafts.length - selectedBlockIndex : 1;
  const lastTranslatedBlockIndex = blocksWithDrafts.reduce((lastIndex, block, index) => (
    String(block.draft?.en || block.en || "").trim() ? index : lastIndex
  ), -1);
  const lastTranslatedBlock = lastTranslatedBlockIndex > -1 ? blocksWithDrafts[lastTranslatedBlockIndex] : null;
  const loopStartIndex =
    deepSeekLoopStartMode === "after-last-translated"
      ? Math.min(lastTranslatedBlockIndex + 1, blocksWithDrafts.length)
      : selectedBlockIndex > -1
        ? selectedBlockIndex
        : 0;
  const loopStartBlock = blocksWithDrafts[loopStartIndex] || null;
  const loopAvailableBlockCount = Math.max(0, blocksWithDrafts.length - loopStartIndex);
  const requestedDeepSeekLoopBlockCount = loopAvailableBlockCount
    ? clampInteger(deepSeekBlockCount, 1, 1, loopAvailableBlockCount)
    : 0;
  const deepSeekLoopBlockTargets = requestedDeepSeekLoopBlockCount
    ? blocksWithDrafts.slice(loopStartIndex, loopStartIndex + requestedDeepSeekLoopBlockCount)
    : [];
  const requestedDeepSeekBlockCount = clampInteger(deepSeekBlockCount, 1, 1, Math.max(remainingBlockCount, 1));
  const deepSeekBlockTargets =
    viewMode === "blocks" && selectedBlockIndex > -1
      ? blocksWithDrafts.slice(selectedBlockIndex, selectedBlockIndex + requestedDeepSeekBlockCount)
      : [];
  const requestedDeepSeekParallelCount = clampInteger(
    deepSeekParallelCount,
    1,
    1,
    Math.min(Math.max(deepSeekBlockTargets.length, 1), 10),
  );
  const deepSeekHasPromptContent = deepSeekPromptParts.some((part) => String(part.content || "").trim());
  const deepSeekTargetLabel = viewMode === "blocks" ? selectedBlock?.block_id : selected?.line_id;
  const deepSeekTargetDescription =
    viewMode === "blocks"
      ? "Translate the selected block as one coherent passage."
      : "Retranslate the selected line directly.";
  const deepSeekRunning = busy === "deepseek";
  const deepSeekProgressTotal = deepSeekProgress?.total || (deepSeekRunning ? 1 : 0);
  const deepSeekProgressDone = deepSeekProgress?.done || 0;
  const deepSeekProgressPercent = deepSeekProgressTotal
    ? Math.min(100, Math.round((deepSeekProgressDone / deepSeekProgressTotal) * 100))
    : 0;
  const deepSeekOverlayTitle = deepSeekCancelling
    ? "Cancelling DeepSeek"
    : deepSeekProgress?.mode === "loop"
      ? "DeepSeek Loop"
      : deepSeekProgress?.mode === "blocks" ? "Translating Block Batch" : "Translating With DeepSeek";
  const deepSeekOverlayStatus = deepSeekProgress?.mode === "loop"
    ? deepSeekCancelling
      ? "Stopping after the current request"
      : `${deepSeekProgressDone}/${deepSeekProgressTotal} blocks complete`
    : deepSeekProgress?.mode === "blocks"
      ? deepSeekCancelling
        ? "Stopping queued and in-flight requests"
        : `${deepSeekProgressDone}/${deepSeekProgressTotal} blocks complete`
      : deepSeekCancelling
        ? "Stopping the active request"
        : deepSeekProgressDone ? "Applying suggestion" : "Waiting for DeepSeek";
  const validationFailures = Array.isArray(validationReport?.failures) ? validationReport.failures : [];
  const validationWarnings = Array.isArray(validationReport?.warnings) ? validationReport.warnings : [];
  const workflowFailureText = workflowFailurePreview(workflowFailure);

  return (
    <div className="h-screen overflow-hidden bg-background text-foreground">
      <header className="grid h-14 grid-cols-[auto_220px_1fr_auto] items-center gap-3 border-b bg-card/95 px-3 shadow-sm backdrop-blur max-[980px]:h-auto max-[980px]:grid-cols-1 max-[980px]:py-3">
        <div className="flex min-w-0 items-center gap-2 font-semibold">
          <FileJson data-icon="inline-start" />
          <span className="truncate">Megami Translation Tool</span>
        </div>

        <AppSelect value={textProfile} onValueChange={setTextProfile} label="Text profile">
          <SelectItem value="apostrophe-patched">apostrophe-patched</SelectItem>
          <SelectItem value="vanilla">vanilla</SelectItem>
        </AppSelect>

        <div className="flex min-w-0 flex-wrap justify-end gap-2 max-[980px]:justify-start">
          <MetricBadge>{overallProgressPercent}% overall</MetricBadge>
          <MetricBadge>{viewMode === "blocks" ? `${blockTranslated}/${blocksWithDrafts.length} blocks` : `${translated}/${editable} lines`}</MetricBadge>
          <MetricBadge>{dirty.size + blockDirty.size} dirty</MetricBadge>
          <MetricBadge variant={failures ? "destructive" : "secondary"}>{failures} flagged</MetricBadge>
          <MetricBadge variant={autoBreaks ? "default" : "outline"}>{autoBreaks} auto @h</MetricBadge>
          <MetricBadge variant={health?.deepseekConfigured ? "default" : "outline"}>
            {health?.deepseekConfigured ? "DeepSeek ready" : "No API key"}
          </MetricBadge>
          <MetricBadge variant={health?.localeEmulatorConfigured ? "default" : "outline"}>
            {health?.localeEmulatorConfigured ? "Locale ready" : "No LEProc"}
          </MetricBadge>
        </div>

        <ThemeSwitch />
      </header>

      <main className="grid h-[calc(100vh-3.5rem)] min-h-0 grid-cols-[minmax(320px,34vw)_minmax(460px,1fr)_minmax(300px,22vw)] max-[1180px]:grid-cols-[330px_minmax(460px,1fr)] max-[760px]:h-auto max-[760px]:min-h-screen max-[760px]:grid-cols-1">
        <aside className="flex min-h-0 flex-col border-r bg-sidebar text-sidebar-foreground">
          <section className="border-b">
            <CollapsibleHeader
              icon={<FileJson className="size-4 text-muted-foreground" />}
              title="Files"
              badge={<Badge variant="secondary">{translatableFileRows.length}</Badge>}
              open={filePanelOpen}
              onToggle={() => setFilePanelOpen((value) => !value)}
            />
            {filePanelOpen && (
              <div className="max-h-[34vh] overflow-auto p-3 pt-0 scrollbar-thin max-[760px]:max-h-none">
                <div className="grid gap-2">
                  {translatableFileRows.length ? translatableFileRows.map((file) => {
                    const filePercent = percentComplete(file.translatedBlocks, file.totalBlocks);
                    return (
                      <Button
                        key={file.stem}
                        type="button"
                        variant="ghost"
                        title={`Open ${file.file}`}
                        className={cn(
                          "h-auto w-full justify-start rounded-lg border bg-card px-3 py-2 text-left",
                          stem === file.stem && "border-primary bg-accent text-accent-foreground",
                        )}
                        onClick={() => {
                          setStem(file.stem);
                          setSceneFilter("all");
                        }}
                      >
                        <span className="grid w-full gap-2">
                          <span className="flex items-center justify-between gap-3">
                            <span className="min-w-0 truncate text-sm font-medium">{file.file}</span>
                            <span className="shrink-0 text-xs text-muted-foreground">{filePercent}%</span>
                          </span>
                          <span className="flex flex-wrap gap-2 text-xs text-muted-foreground">
                            <span>{file.totalBlocks} blocks</span>
                            <span>{file.scenes} scenes</span>
                            <span>{file.translatedBlocks}/{file.totalBlocks} done</span>
                          </span>
                          <span className="h-1.5 overflow-hidden rounded-full bg-muted">
                            <span
                              className={cn("block h-full rounded-full", progressToneClass(filePercent))}
                              style={{ width: `${Math.min(100, Math.max(0, Number(filePercent) || 0))}%` }}
                            />
                          </span>
                        </span>
                      </Button>
                    );
                  }) : (
                    <p className="rounded-lg border bg-card p-3 text-sm text-muted-foreground">No translatable files loaded.</p>
                  )}
                </div>
              </div>
            )}
          </section>

          <section className="border-b">
            <CollapsibleHeader
              icon={<BarChart3 className="size-4 text-muted-foreground" />}
              title="Progress"
              badge={<Badge variant="secondary">{overallProgressPercent}%</Badge>}
              open={progressPanelOpen}
              onToggle={() => setProgressPanelOpen((value) => !value)}
            />
            {progressPanelOpen && (
              <div className="max-h-[38vh] overflow-auto p-3 pt-0 scrollbar-thin max-[760px]:max-h-none">
                <div className="grid gap-2 rounded-lg border bg-card p-3">
                  <div className="flex items-center justify-between gap-3 text-sm">
                    <span className="font-medium">All files</span>
                    <span className="text-muted-foreground">
                      {overallProgress?.translatedBlocks ?? blockTranslated}/{overallProgress?.totalBlocks ?? blocksWithDrafts.length} blocks
                    </span>
                  </div>
                  <ProgressMeter value={overallProgressPercent} title="Overall block progress" />
                  <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
                    <span>{overallProgressPercent}% blocks</span>
                    <span>{overallProgress?.completeFiles ?? 0}/{overallProgress?.totalFiles ?? files.length} files complete</span>
                  </div>
                </div>

                <div className="mt-3 grid gap-2 rounded-lg border bg-card p-3">
                  <div className="flex items-center justify-between gap-3 text-sm">
                    <span className="font-medium">Selected file</span>
                    <span className="text-muted-foreground">
                      {selectedFileProgress?.translatedBlocks ?? blockTranslated}/{selectedFileProgress?.totalBlocks ?? blocksWithDrafts.length} blocks
                    </span>
                  </div>
                  <ProgressMeter value={blockProgressPercent} title={`${stem || "file"} block progress`} />
                  <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
                    <span>{blockProgressPercent}% blocks</span>
                    <span>{lineProgressPercent}% lines</span>
                    <span>{translated}/{editable} translated lines</span>
                  </div>
                </div>

                <div className="mt-3 max-h-64 overflow-auto rounded-lg border bg-card scrollbar-thin">
                  {sceneProgress.length ? sceneProgress.map((scene) => (
                    <Button
                      key={scene.sceneId}
                      type="button"
                      variant="ghost"
                      title={`Filter to ${scene.title}`}
                      className={cn(
                        "h-auto w-full justify-start rounded-none border-b px-3 py-2 text-left last:border-b-0",
                        sceneFilter === scene.sceneId && "bg-accent text-accent-foreground",
                      )}
                      onClick={() => setSceneFilter(scene.sceneId)}
                    >
                      <span className="grid w-full gap-1.5">
                        <span className="flex items-center justify-between gap-3">
                          <span className="min-w-0 truncate text-sm font-medium">{scene.title}</span>
                          <span className="shrink-0 text-xs text-muted-foreground">{scene.blockPercent}%</span>
                        </span>
                        <ProgressMeter value={scene.blockPercent} title={`${scene.title} block progress`} />
                        <span className="flex flex-wrap gap-2 text-xs text-muted-foreground">
                          <span>{scene.translatedBlocks}/{scene.totalBlocks} blocks</span>
                          <span>{scene.linePercent}% lines</span>
                        </span>
                      </span>
                    </Button>
                  )) : (
                    <p className="p-3 text-sm text-muted-foreground">No scene progress loaded.</p>
                  )}
                </div>
              </div>
            )}
          </section>

          <section className="border-b">
            <CollapsibleHeader
              icon={<Search className="size-4 text-muted-foreground" />}
              title="Search"
              badge={query || sceneFilter !== "all" || roleFilter !== "all" || issueFilter !== "all" ? <Badge variant="outline">filtered</Badge> : null}
              open={searchPanelOpen}
              onToggle={() => setSearchPanelOpen((value) => !value)}
            />
            {searchPanelOpen && (
              <div className="grid gap-3 p-3 pt-0">
                <div className="flex gap-2">
                  <div className="relative min-w-0 flex-1">
                    <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                    <Input
                      value={query}
                      onChange={(event) => setQuery(event.target.value)}
                      placeholder="Search"
                      className="pl-8"
                    />
                  </div>
                  <TooltipButton
                    tooltip="Reload the selected file and discard unsaved local edits"
                    variant="outline"
                    size="icon"
                    onClick={() => loadStem(stem, textProfile)}
                    aria-label="Reload selected file"
                  >
                    <RefreshCw data-icon="inline-start" />
                  </TooltipButton>
                </div>

                <div className="grid gap-2">
                  <AppSelect value={sceneFilter} onValueChange={setSceneFilter} label="Scene filter">
                    <SelectItem value="all">All scenes</SelectItem>
                    {scenes.map(([id, title]) => (
                      <SelectItem key={id} value={id}>
                        {title}
                      </SelectItem>
                    ))}
                  </AppSelect>
                  <AppSelect value={roleFilter} onValueChange={setRoleFilter} label="Role filter">
                    <SelectItem value="all">All roles</SelectItem>
                    <SelectItem value="narration">Narration</SelectItem>
                    <SelectItem value="dialogue">Dialogue</SelectItem>
                    {viewMode === "lines" && <SelectItem value="speaker">Speaker</SelectItem>}
                  </AppSelect>
                  <AppSelect value={issueFilter} onValueChange={setIssueFilter} label="Issue filter">
                    <SelectItem value="all">All {viewMode}</SelectItem>
                    <SelectItem value="dirty">Dirty</SelectItem>
                    <SelectItem value="untranslated">Untranslated</SelectItem>
                    <SelectItem value="empty">Empty</SelectItem>
                    {viewMode === "lines" && <SelectItem value="line_too_long">Wrap needed</SelectItem>}
                    <SelectItem value="apostrophe">Apostrophe</SelectItem>
                  </AppSelect>
                  <div className="grid grid-cols-2 rounded-lg border bg-card p-1" role="tablist" aria-label="Editor mode">
                    <Button
                      type="button"
                      role="tab"
                      aria-selected={viewMode === "blocks"}
                      title="Edit complete translation blocks"
                      variant="ghost"
                      className={cn(
                        "h-8 rounded-md",
                        viewMode === "blocks" && "bg-primary text-primary-foreground hover:bg-primary hover:text-primary-foreground",
                      )}
                      onClick={() => chooseViewMode("blocks")}
                    >
                      Blocks
                    </Button>
                    <Button
                      type="button"
                      role="tab"
                      aria-selected={viewMode === "lines"}
                      title="Split the selected block into explicit line overrides and switch to line editing"
                      variant="ghost"
                      className={cn(
                        "h-8 rounded-md",
                        viewMode === "lines" && "bg-primary text-primary-foreground hover:bg-primary hover:text-primary-foreground",
                      )}
                      onClick={() => chooseViewMode("lines")}
                      disabled={busy === "split"}
                    >
                      Lines
                    </Button>
                  </div>
                </div>
              </div>
            )}
          </section>

          <ScrollArea className="min-h-0 flex-1 max-[760px]:h-80">
            <div className="divide-y">
              {viewMode === "blocks" ? filteredBlocks.map((block) => (
                <Button
                  key={block.block_id}
                  type="button"
                  variant="ghost"
                  title={`Open ${block.block_id}`}
                  className={cn(
                    "h-auto w-full justify-start rounded-none px-3 py-2 text-left",
                    selectedBlock?.block_id === block.block_id && "bg-accent text-accent-foreground",
                    block.isDirty && "border-l-4 border-l-chart-3",
                  )}
                  onClick={() => {
                    setSelectedBlockId(block.block_id);
                    setSuggestion(null);
                  }}
                >
                  <span className="grid w-full grid-cols-[116px_82px_minmax(0,1fr)_auto] items-center gap-2">
                    <span className="font-mono text-xs text-muted-foreground">{block.block_id.replace(`${stem}:`, "")}</span>
                    <span className="truncate text-xs text-muted-foreground">{speakerName(block)}</span>
                    <span className="truncate font-normal">{block.draft.en || block.jp}</span>
                    <Badge variant={block.effective_mode === "lines" ? "secondary" : "outline"} className="rounded-md">
                      {block.effective_mode}
                    </Badge>
                  </span>
                </Button>
              )) : filteredRows.map((row) => (
                <Button
                  key={row.line_id}
                  type="button"
                  variant="ghost"
                  title={`Open ${row.line_id} by ${speakerName(row)}`}
                  className={cn(
                    "h-auto w-full justify-start rounded-none px-3 py-2 text-left",
                    selected?.line_id === row.line_id && "bg-accent text-accent-foreground",
                    row.isDirty && "border-l-4 border-l-chart-3",
                  )}
                  onClick={() => {
                    setSelectedId(row.line_id);
                    setSuggestion(null);
                  }}
                >
                  <span className="grid w-full grid-cols-[86px_88px_minmax(0,1fr)_auto] items-center gap-2">
                    <span className="font-mono text-xs text-muted-foreground">{row.line_id}</span>
                    <span className="truncate text-xs text-muted-foreground">{speakerName(row)}</span>
                    <span className="truncate font-normal">{row.draft.en || row.jp}</span>
                    {row.currentIssues.length > 0 && (
                      <Badge variant="outline" className="rounded-md">
                        {issueLabel(row.currentIssues[0])}
                      </Badge>
                    )}
                  </span>
                </Button>
              ))}
            </div>
          </ScrollArea>
        </aside>

        <section className="min-h-0 bg-background">
          <ScrollArea className="h-full">
            {viewMode === "blocks" ? (
              selectedBlock ? (
                <div className="flex flex-col gap-4 p-4">
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0">
                      <p className="truncate text-sm text-muted-foreground">{selectedBlock.scene_title_jp}</p>
                      <h1 className="text-2xl font-semibold tracking-tight">{selectedBlock.block_id}</h1>
                    </div>
                    <div className="flex flex-wrap justify-end gap-2">
                      <TooltipButton
                        tooltip={`Save edits for ${selectedBlock.block_id}`}
                        variant="outline"
                        disabled={!blockDirty.has(selectedBlock.block_id) || busy === "save"}
                        onClick={() => saveBlockChanges([selectedBlock.block_id])}
                      >
                        <Icon><Save /></Icon>
                        Save
                      </TooltipButton>
                      <TooltipButton
                        tooltip="Save every dirty block"
                        variant="outline"
                        disabled={!blockDirty.size || busy === "save"}
                        onClick={() => saveBlockChanges()}
                      >
                        <Icon><Save /></Icon>
                        Save all
                      </TooltipButton>
                      <TooltipButton
                        tooltip={`Clear the draft translation for ${selectedBlock.block_id}`}
                        variant="destructive"
                        disabled={!String(selectedBlock.draft.en || "").trim() || Boolean(busy)}
                        onClick={clearSelectedTranslation}
                      >
                        <Icon><Trash2 /></Icon>
                        Clear
                      </TooltipButton>
                      <TooltipButton
                        tooltip="Clear every block translation draft in this file"
                        variant="destructive"
                        disabled={!hasAnyBlockTranslationDraft || Boolean(busy)}
                        onClick={clearAllTranslations}
                      >
                        <Icon><Trash2 /></Icon>
                        Clear all
                      </TooltipButton>
                      <TooltipButton
                        tooltip={`Configure and send a DeepSeek request for ${selectedBlock.block_id}`}
                        variant="outline"
                        disabled={!health?.deepseekConfigured || busy === "deepseek" || deepSeekPromptLoading}
                        onClick={openDeepSeekModal}
                      >
                        <Icon><Bot /></Icon>
                        DeepSeek
                      </TooltipButton>
                      <TooltipButton
                        tooltip={`Configure a ${DEEPSEEK_LOOP_MODEL} sequential loop with retries and automatic saving`}
                        variant="outline"
                        disabled={!health?.deepseekConfigured || busy === "deepseek" || deepSeekPromptLoading || !blocksWithDrafts.length}
                        onClick={openDeepSeekLoopModal}
                      >
                        <Icon><Bot /></Icon>
                        DeepSeek loop
                      </TooltipButton>
                      <TooltipButton
                        tooltip="Split this block into explicit line overrides and switch to line editing"
                        variant="secondary"
                        disabled={busy === "split"}
                        onClick={splitSelectedBlockToLines}
                      >
                        Lines
                      </TooltipButton>
                    </div>
                  </div>

                  <div className="flex flex-wrap gap-2">
                    <Badge variant="secondary">pages {selectedBlock.page_start}-{selectedBlock.page_end}</Badge>
                    <Badge variant="secondary">lines {selectedBlock.line_start}-{selectedBlock.line_end}</Badge>
                    <Badge variant="secondary">{selectedBlock.page_role}</Badge>
                    <Badge variant="secondary">{speakerName(selectedBlock)}</Badge>
                    <Badge variant={selectedBlock.effective_mode === "lines" ? "secondary" : "outline"}>{selectedBlock.effective_mode}</Badge>
                    <Badge variant={selectedBlock.currentIssues.length ? "destructive" : "outline"}>
                      {selectedBlock.currentIssues.length ? selectedBlock.currentIssues.map(issueLabel).join(", ") : "clean"}
                    </Badge>
                  </div>

                  <div className="grid grid-cols-[minmax(170px,0.55fr)_minmax(260px,0.8fr)_minmax(320px,1.3fr)] gap-4 max-[1100px]:grid-cols-1">
                    <Card>
                      <CardHeader>
                        <CardDescription>Speaker</CardDescription>
                        <CardTitle className="text-2xl">{speakerName(selectedBlock)}</CardTitle>
                      </CardHeader>
                      <CardContent className="flex flex-col gap-2">
                        {selectedBlock.speaker_jp && <p lang="ja" className="text-sm text-muted-foreground">{selectedBlock.speaker_jp}</p>}
                        <Badge variant="outline" className="w-fit">{selectedBlock.page_role}</Badge>
                      </CardContent>
                    </Card>

                    <Card>
                      <CardHeader>
                        <CardDescription>Generated Windows</CardDescription>
                        <CardTitle>
                          {selectedBlockPreview?.window_count || 0} window{(selectedBlockPreview?.window_count || 0) === 1 ? "" : "s"}
                        </CardTitle>
                      </CardHeader>
                      <CardContent className="flex flex-col gap-3">
                        <div className="flex flex-wrap gap-1.5">
                          <Badge variant="outline">{selectedBlockPreview?.body_line_count || 0} body lines</Badge>
                          <Badge variant={selectedBlockPreview?.inserted_windows ? "secondary" : "outline"}>
                            {selectedBlockPreview?.inserted_windows || 0} extra @h
                          </Badge>
                          <Badge variant="outline">{selectedBlock.line_ids?.length || 0} source lines</Badge>
                        </div>
                        {overflowReport?.exists && (
                          <p className="text-sm text-muted-foreground">
                            {selectedBlockReport
                              ? `Last Jobs run generated ${selectedBlockReport.window_count} window${selectedBlockReport.window_count === 1 ? "" : "s"} for this block.`
                              : "Last Jobs run has no block job for this block."}
                          </p>
                        )}
                      </CardContent>
                    </Card>

                    <Card>
                      <CardHeader>
                        <CardDescription>Scene Context</CardDescription>
                        <CardTitle>{sceneSummary?.scene_title_en || selectedBlock.scene_title_jp}</CardTitle>
                      </CardHeader>
                      <CardContent className="flex max-h-72 flex-col gap-3 overflow-auto scrollbar-thin">
                        {sceneSummary?.summary_jp && <p lang="ja" className="text-sm leading-6 text-muted-foreground">{sceneSummary.summary_jp}</p>}
                        {Array.isArray(sceneSummary?.active_characters) && sceneSummary.active_characters.length > 0 && (
                          <div className="flex flex-wrap gap-1.5">
                            {sceneSummary.active_characters.map((name) => (
                              <Badge key={name} variant="secondary">{name}</Badge>
                            ))}
                          </div>
                        )}
                        {Array.isArray(sceneSummary?.translation_notes_en) && sceneSummary.translation_notes_en.length > 0 && (
                          <ul className="grid gap-2 pl-4 text-sm text-muted-foreground">
                            {sceneSummary.translation_notes_en.slice(0, 4).map((note) => <li key={note}>{note}</li>)}
                          </ul>
                        )}
                      </CardContent>
                    </Card>
                  </div>

                  {previousBlocks.length > 0 && (
                    <Card>
                      <CardHeader>
                        <CardDescription>Previous Blocks</CardDescription>
                      </CardHeader>
                      <CardContent className="max-h-72 overflow-auto scrollbar-thin">
                        <div className="divide-y">
                          {previousBlocks.map((block) => (
                            <Button
                              key={block.block_id}
                              type="button"
                              variant="ghost"
                              title={`Jump to previous block ${block.block_id}`}
                              className="h-auto w-full justify-start rounded-none px-0 py-3 text-left"
                              onClick={() => {
                                setSelectedBlockId(block.block_id);
                                setSuggestion(null);
                              }}
                            >
                              <span className="grid w-full grid-cols-[150px_minmax(180px,0.9fr)_minmax(220px,1.1fr)] gap-3 max-[900px]:grid-cols-1">
                                <span className="grid gap-1 text-xs text-muted-foreground">
                                  <span className="font-mono">{block.block_id.replace(`${stem}:`, "")}</span>
                                  <strong>{speakerName(block)}</strong>
                                </span>
                                <span lang="ja" className="whitespace-normal font-normal leading-5 text-muted-foreground">{block.jp}</span>
                                <span className="whitespace-normal font-medium leading-5">{block.draft.en}</span>
                              </span>
                            </Button>
                          ))}
                        </div>
                      </CardContent>
                    </Card>
                  )}

                  <Card>
                    <CardHeader>
                      <CardDescription>Japanese Block</CardDescription>
                    </CardHeader>
                    <CardContent>
                      <pre lang="ja" className="whitespace-pre-wrap rounded-lg bg-muted p-4 text-lg leading-8">{selectedBlock.jp}</pre>
                    </CardContent>
                  </Card>

                  <div className="grid gap-4">
                    <label className="grid gap-2">
                      <span className="text-sm font-medium">English Block</span>
                      <Textarea
                        ref={blockEditorRef}
                        value={selectedBlock.draft.en}
                        onChange={(event) => updateBlockDraft(selectedBlock.block_id, { en: event.target.value })}
                        spellCheck="true"
                        rows={10}
                        className="min-h-56 resize-y text-base"
                      />
                    </label>

                    <label className="grid gap-2">
                      <span className="text-sm font-medium">Notes</span>
                      <Textarea
                        value={selectedBlock.draft.notes}
                        onChange={(event) => updateBlockDraft(selectedBlock.block_id, { notes: event.target.value })}
                        rows={3}
                        className="resize-y"
                      />
                    </label>
                  </div>

                  <Card>
                    <CardHeader>
                      <CardDescription>Generated Preview</CardDescription>
                    </CardHeader>
                    <CardContent className="grid gap-3">
                      {selectedBlockPreview?.windows?.length ? (
                        selectedBlockPreview.windows.map((windowLines, index) => (
                          <pre key={`${selectedBlock.block_id}-${index}`} className="whitespace-pre-wrap rounded-lg border bg-muted p-3 text-sm leading-6">
                            {windowLines.join("\n")}
                            {"\n@h"}
                          </pre>
                        ))
                      ) : (
                        <p className="text-sm text-muted-foreground">No generated windows yet.</p>
                      )}
                    </CardContent>
                  </Card>

                  <Card>
                    <CardContent className="flex flex-col gap-3 pt-6">
                      {suggestion && (
                        <div className="grid gap-2 rounded-lg border bg-accent p-3 text-accent-foreground">
                          <p className="text-sm font-medium opacity-80">Applied DeepSeek draft</p>
                          <p className="whitespace-pre-wrap font-semibold">{suggestion.en}</p>
                          {suggestion.notes && <p className="text-sm opacity-80">{suggestion.notes}</p>}
                          <TooltipButton
                            tooltip={`Restore the DeepSeek draft to ${selectedBlock.block_id}`}
                            variant="secondary"
                            className="w-fit"
                            onClick={() => updateBlockDraft(selectedBlock.block_id, { en: suggestion.en || "" })}
                          >
                            <Icon><Download /></Icon>
                            Reapply
                          </TooltipButton>
                        </div>
                      )}
                      {!suggestion && (
                        <p className="text-sm text-muted-foreground">
                          Use the DeepSeek button above to configure and send a request for this block.
                        </p>
                      )}
                    </CardContent>
                  </Card>
                </div>
              ) : (
                <div className="grid h-full place-items-center text-muted-foreground">No blocks loaded.</div>
              )
            ) : selected ? (
              <div className="flex flex-col gap-4 p-4">
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <p className="truncate text-sm text-muted-foreground">{selected.scene_title_jp}</p>
                    <h1 className="text-2xl font-semibold tracking-tight">{selected.line_id}</h1>
                  </div>
                  <div className="flex flex-wrap justify-end gap-2">
                    <TooltipButton
                      tooltip={`Save edits for ${selected.line_id}`}
                      variant="outline"
                      disabled={!dirty.has(selected.line_id) || busy === "save"}
                      onClick={() => saveChanges([selected.line_id])}
                    >
                      <Icon><Save /></Icon>
                      Save
                    </TooltipButton>
                    <TooltipButton
                      tooltip="Save every dirty translation line"
                      variant="outline"
                      disabled={!dirty.size || busy === "save"}
                      onClick={() => saveChanges()}
                    >
                      <Icon><Save /></Icon>
                      Save all
                    </TooltipButton>
                    <TooltipButton
                      tooltip={`Clear the draft translation for ${selected.line_id}`}
                      variant="destructive"
                      disabled={!selected.editable || !String(selected.draft.en || "").trim() || Boolean(busy)}
                      onClick={clearSelectedTranslation}
                    >
                      <Icon><Trash2 /></Icon>
                      Clear
                    </TooltipButton>
                    <TooltipButton
                      tooltip="Clear every editable line translation draft in this file"
                      variant="destructive"
                      disabled={!hasAnyLineTranslationDraft || Boolean(busy)}
                      onClick={clearAllTranslations}
                    >
                      <Icon><Trash2 /></Icon>
                      Clear all
                    </TooltipButton>
                    <TooltipButton
                      tooltip={`Configure and send a DeepSeek request for ${selected.line_id}`}
                      variant="outline"
                      disabled={!selected.editable || !health?.deepseekConfigured || busy === "deepseek" || deepSeekPromptLoading}
                      onClick={openDeepSeekModal}
                    >
                      <Icon><Bot /></Icon>
                      DeepSeek
                    </TooltipButton>
                  </div>
                </div>

                <div className="flex flex-wrap gap-2">
                  <Badge variant="secondary">line {selected.line_number}</Badge>
                  <Badge variant="secondary">page {selected.page_index}</Badge>
                  <Badge variant="secondary">{selected.role}</Badge>
                  <Badge variant="secondary">{speakerName(selected)}</Badge>
                  <Badge variant="outline">max {selected.max_chars}</Badge>
                  <Badge variant={selected.currentIssues.length ? "destructive" : "outline"}>
                    {selected.currentIssues.length ? selected.currentIssues.map(issueLabel).join(", ") : "clean"}
                  </Badge>
                </div>

                <div className="grid grid-cols-[minmax(170px,0.55fr)_minmax(260px,0.8fr)_minmax(320px,1.3fr)] gap-4 max-[1100px]:grid-cols-1">
                  <Card>
                    <CardHeader>
                      <CardDescription>Speaker</CardDescription>
                      <CardTitle className="text-2xl">{speakerName(selected)}</CardTitle>
                    </CardHeader>
                    <CardContent className="flex flex-col gap-2">
                      {selected.speaker_jp && <p lang="ja" className="text-sm text-muted-foreground">{selected.speaker_jp}</p>}
                      <Badge variant="outline" className="w-fit">{selected.role} / {selected.kind || "text"}</Badge>
                    </CardContent>
                  </Card>

                  <Card>
                    <CardHeader>
                      <CardDescription>Window Budget</CardDescription>
                      <CardTitle>
                        {selectedWindowStats?.totalWindows || 1} window{(selectedWindowStats?.totalWindows || 1) === 1 ? "" : "s"}
                      </CardTitle>
                    </CardHeader>
                    <CardContent className="flex flex-col gap-3">
                      <div className="flex flex-wrap gap-1.5">
                        <Badge variant={selectedWindowStats?.usedLines > selectedWindowStats?.maxLines ? "default" : "outline"}>
                          {selectedWindowStats?.usedLines || 0}/{selectedWindowStats?.maxLines || 4} lines
                        </Badge>
                        <Badge variant={selectedWindowStats?.extraWindows ? "secondary" : "outline"}>
                          {selectedWindowStats?.extraWindows || 0} extra @h
                        </Badge>
                        <Badge variant={selectedWindowStats?.selectedLines > 1 ? "secondary" : "outline"}>
                          {selectedWindowStats?.selectedLines || 0} selected
                        </Badge>
                      </div>
                      <p className="text-sm text-muted-foreground">
                        {selectedWindowStats?.extraWindows
                          ? `${selectedWindowStats.extraWindows} automatic break${selectedWindowStats.extraWindows === 1 ? "" : "s"} predicted for this page.`
                          : "Current page fits one game window."}
                      </p>
                      {overflowReport?.exists && (
                        <p className="text-sm text-muted-foreground">
                          {reportedOverflowPage
                            ? `Last Jobs run inserted ${reportedOverflowPage.inserted_windows} break${reportedOverflowPage.inserted_windows === 1 ? "" : "s"} here.`
                            : "Last Jobs run has no overflow for this page."}
                        </p>
                      )}
                    </CardContent>
                  </Card>

                  <Card>
                    <CardHeader>
                      <CardDescription>Scene Context</CardDescription>
                      <CardTitle>{sceneSummary?.scene_title_en || selected.scene_title_jp}</CardTitle>
                    </CardHeader>
                    <CardContent className="flex max-h-72 flex-col gap-3 overflow-auto scrollbar-thin">
                      {sceneSummary?.summary_jp && <p lang="ja" className="text-sm leading-6 text-muted-foreground">{sceneSummary.summary_jp}</p>}
                      {Array.isArray(sceneSummary?.active_characters) && sceneSummary.active_characters.length > 0 && (
                        <div className="flex flex-wrap gap-1.5">
                          {sceneSummary.active_characters.map((name) => (
                            <Badge key={name} variant="secondary">{name}</Badge>
                          ))}
                        </div>
                      )}
                      {Array.isArray(sceneSummary?.translation_notes_en) && sceneSummary.translation_notes_en.length > 0 && (
                        <ul className="grid gap-2 pl-4 text-sm text-muted-foreground">
                          {sceneSummary.translation_notes_en.slice(0, 4).map((note) => <li key={note}>{note}</li>)}
                        </ul>
                      )}
                    </CardContent>
                  </Card>
                </div>

                <Card>
                  <CardHeader>
                    <CardDescription>Previous Translations</CardDescription>
                  </CardHeader>
                  <CardContent className="max-h-72 overflow-auto scrollbar-thin">
                    {previousTranslations.length ? (
                      <div className="divide-y">
                        {previousTranslations.map((row) => (
                          <Button
                            key={row.line_id}
                            type="button"
                            variant="ghost"
                            title={`Jump to previous translated line ${row.line_id}`}
                            className="h-auto w-full justify-start rounded-none px-0 py-3 text-left"
                            onClick={() => {
                              setSelectedId(row.line_id);
                              setSuggestion(null);
                            }}
                          >
                            <span className="grid w-full grid-cols-[150px_minmax(180px,0.9fr)_minmax(220px,1.1fr)] gap-3 max-[900px]:grid-cols-1">
                              <span className="grid gap-1 text-xs text-muted-foreground">
                                <span className="font-mono">{row.line_id}</span>
                                <strong>{speakerName(row)}</strong>
                              </span>
                              <span lang="ja" className="whitespace-normal font-normal leading-5 text-muted-foreground">{row.jp}</span>
                              <span className="whitespace-normal font-medium leading-5">{row.draft.en}</span>
                            </span>
                          </Button>
                        ))}
                      </div>
                    ) : (
                      <p className="text-sm text-muted-foreground">No previous translated lines in this scene.</p>
                    )}
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader>
                    <CardDescription>Japanese Source</CardDescription>
                  </CardHeader>
                  <CardContent>
                    <p lang="ja" className="rounded-lg bg-muted p-4 text-lg leading-8">{selected.jp}</p>
                  </CardContent>
                </Card>

                <div className="grid gap-4">
                  <label className="grid gap-2">
                    <span className="text-sm font-medium">English</span>
                    <Textarea
                      ref={lineEditorRef}
                      value={selected.draft.en}
                      onChange={(event) => updateDraft(selected.line_id, { en: event.target.value })}
                      spellCheck="true"
                      rows={6}
                      disabled={!selected.editable}
                      className="min-h-36 resize-y text-base"
                    />
                  </label>

                  <label className="grid gap-2">
                    <span className="text-sm font-medium">Notes</span>
                    <Textarea
                      value={selected.draft.notes}
                      onChange={(event) => updateDraft(selected.line_id, { notes: event.target.value })}
                      rows={3}
                      disabled={!selected.editable}
                      className="resize-y"
                    />
                  </label>
                </div>

                <Card>
                  <CardContent className="flex flex-col gap-3 pt-6">
                    {suggestion && (
                      <div className="grid gap-2 rounded-lg border bg-accent p-3 text-accent-foreground">
                        <p className="text-sm font-medium opacity-80">Applied DeepSeek draft</p>
                        <p className="font-semibold">{suggestion.en}</p>
                        {suggestion.notes && <p className="text-sm opacity-80">{suggestion.notes}</p>}
                        <TooltipButton
                          tooltip={`Restore the DeepSeek draft to ${selected.line_id}`}
                          variant="secondary"
                          className="w-fit"
                          onClick={() => updateDraft(selected.line_id, { en: suggestion.en || "" })}
                        >
                          <Icon><Download /></Icon>
                          Reapply
                        </TooltipButton>
                      </div>
                    )}
                    {!suggestion && (
                      <p className="text-sm text-muted-foreground">
                        Use the DeepSeek button above to configure and send a request for this line.
                      </p>
                    )}
                  </CardContent>
                </Card>
              </div>
            ) : (
              <div className="grid h-full place-items-center text-muted-foreground">No lines loaded.</div>
            )}
          </ScrollArea>
        </section>

        <aside className="min-h-0 border-l bg-sidebar text-sidebar-foreground max-[1180px]:col-span-2 max-[1180px]:h-80 max-[1180px]:border-l-0 max-[1180px]:border-t max-[760px]:col-span-1">
          <div className="grid h-full grid-rows-[auto_auto_auto_auto_auto_minmax(0,1fr)]">
            <div className="flex flex-col gap-2 border-b p-3">
              <PipelineButton
                tooltip="Validate approved translations; page overflow is allowed for automatic windows"
                onClick={() => runWorkflow("validate", "/api/workflows/validate", { stem, textProfile })}
              >
                <CheckCircle2 data-icon="inline-start" />
                Validate
              </PipelineButton>
              <PipelineButton
                tooltip="Build overflow-aware patch jobs from the approved translation JSONL"
                onClick={() => runWorkflow("build jobs", "/api/workflows/build-jobs", { stem, textProfile })}
              >
                <Wrench data-icon="inline-start" />
                Jobs
              </PipelineButton>
              <PipelineButton
                tooltip="Reinsert patch jobs into a clean ADX source using variable-size mode"
                onClick={() => runWorkflow("reinsert", "/api/workflows/reinsert", { stem, textProfile, mode: "variable" })}
              >
                <Wrench data-icon="inline-start" />
                Reinsert
              </PipelineButton>
              <PipelineButton
                tooltip="Verify the executable apostrophe patch against the original backup"
                onClick={() => runWorkflow("verify exe", "/api/workflows/exe/verify")}
              >
                <ShieldCheck data-icon="inline-start" />
                Verify exe
              </PipelineButton>
              <PipelineButton
                tooltip="Create patched_exe/main_apostrophe.exe from the original executable backup"
                onClick={() => runWorkflow("build exe", "/api/workflows/exe/build")}
              >
                <Wrench data-icon="inline-start" />
                Build exe
              </PipelineButton>
              <PipelineButton tooltip="Back up the live game files and install the patched executable and ADX" onClick={installBuild}>
                <Download data-icon="inline-start" />
                Install
              </PipelineButton>
              <PipelineButton tooltip="Launch main.exe with Locale Emulator if LEProc.exe is available" onClick={() => runWorkflow("launch", "/api/launch")}>
                <Play data-icon="inline-start" />
                Launch
              </PipelineButton>
              <PipelineButton
                tooltip={latestBackup ? `Restore latest backup ${latestBackup.id}` : "No app-created backup is available to restore"}
                disabled={!latestBackup}
                onClick={() => restoreBackup(latestBackup?.id)}
              >
                <RotateCcw data-icon="inline-start" />
                Restore
              </PipelineButton>
            </div>

            <div className="grid gap-1 border-b p-3 text-sm">
              <div><strong>Approved</strong> {payload?.approvedExists ? "yes" : "missing"}</div>
              <div><strong>Block approved</strong> {payload?.blockApprovedExists ? "yes" : "missing"}</div>
              <div><strong>Clean source</strong> {payload?.cleanSourceExists ? "yes" : "missing"}</div>
              <div>
                <strong>Overflow report</strong>{" "}
                {overflowReport?.exists
                  ? `${overflowReport.blockJobs || 0} blocks / ${overflowReport.overflowPages} pages / ${overflowReport.insertedWindows || 0} @h / ${overflowReport.wrappedLines} wrapped${overflowReport.unsafeBlockRanges ? ` / ${overflowReport.unsafeBlockRanges} unsafe` : ""}`
                  : "missing"}
              </div>
              <div><strong>Latest backup</strong> {latestBackup?.id || "none"}</div>
            </div>

            <div className="border-b">
              <Button
                type="button"
                variant="ghost"
                title={promptOpen ? "Hide the captured DeepSeek prompt" : "Show the captured DeepSeek prompt"}
                className="h-auto w-full justify-between rounded-none px-3 py-2"
                aria-expanded={promptOpen}
                onClick={() => setPromptOpen((value) => !value)}
              >
                <span>DeepSeek prompt</span>
                <Badge variant="outline">{selectedPromptLabel || "not captured"}</Badge>
              </Button>
              {promptOpen && selectedPrompt ? (
                <div className="grid gap-2 p-3">
                  <div className="flex flex-wrap gap-2">
                    {selectedPromptLabel && <Badge variant="secondary">{selectedPromptLabel}</Badge>}
                    {selectedPromptDetail.source && <Badge variant="secondary">{selectedPromptDetail.source}</Badge>}
                    {selectedPromptDetail.model && <Badge variant="secondary">{selectedPromptDetail.model}</Badge>}
                    {selectedPromptDetail.status && <Badge variant="secondary">{selectedPromptDetail.status}</Badge>}
                  </div>
                  {capturedPromptLoading ? (
                    <div className="rounded-lg border bg-muted p-3 text-sm text-muted-foreground">Loading captured prompt...</div>
                  ) : selectedPromptText ? (
                    <pre className="max-h-72 overflow-auto rounded-lg border bg-muted p-3 text-xs leading-5 text-muted-foreground scrollbar-thin whitespace-pre-wrap break-words">
                      {selectedPromptText}
                    </pre>
                  ) : (
                    <p className="rounded-lg border bg-muted p-3 text-sm text-muted-foreground">Captured prompt text is unavailable.</p>
                  )}
                </div>
              ) : promptOpen ? (
                <p className="p-3 text-sm text-muted-foreground">No captured DeepSeek prompt for this target.</p>
              ) : null}
            </div>

            {workflowFailure && (
              <div className="grid gap-2 border-b border-destructive/40 bg-destructive/10 p-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <strong className="text-sm text-destructive">Workflow failed</strong>
                      <Badge variant="destructive">{workflowFailure.label}</Badge>
                      {typeof workflowFailure.exitCode === "number" && (
                        <Badge variant="outline">exit {workflowFailure.exitCode}</Badge>
                      )}
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">
                      The next step is using the previous output until this failure is fixed and the step is run again.
                    </p>
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    title="Dismiss workflow failure"
                    aria-label="Dismiss workflow failure"
                    onClick={() => setWorkflowFailure(null)}
                  >
                    <X />
                  </Button>
                </div>

                {workflowFailure.command && (
                  <code className="block rounded-md border bg-card p-2 text-xs text-muted-foreground">
                    {workflowFailure.command}
                  </code>
                )}
                {workflowFailureText && (
                  <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-md border bg-card p-2 text-xs leading-5 scrollbar-thin">
                    {workflowFailureText}
                  </pre>
                )}
              </div>
            )}

            {validationReport && !validationReport.ok && (
              <div className="grid gap-2 border-b p-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <strong className="text-sm">Validation failed</strong>
                      <Badge variant="destructive">{validationFailures.length}</Badge>
                      {validationWarnings.length > 0 && <Badge variant="outline">{validationWarnings.length} warnings</Badge>}
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">
                      Open a failure to jump to the matching block, line, or page.
                    </p>
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    title="Dismiss validation results"
                    aria-label="Dismiss validation results"
                    onClick={() => setValidationReport(null)}
                  >
                    <X />
                  </Button>
                </div>

                <div className="max-h-64 overflow-auto rounded-lg border scrollbar-thin">
                  {validationFailures.slice(0, 80).map((failure, index) => {
                    const target = resolveValidationFailure(failure);
                    const problemChars = validationProblemChars(failure);
                    const excerpt = validationExcerpt(failure, problemChars);
                    const summary = validationFailureSummary(failure);
                    return (
                      <Button
                        key={`${failure.line_id || "failure"}-${failure.issue || "issue"}-${index}`}
                        type="button"
                        variant="ghost"
                        title={target ? `Open ${failure.line_id}` : `No loaded target for ${failure.line_id || "unknown"}`}
                        disabled={!target}
                        className="h-auto w-full justify-start rounded-none border-b px-3 py-2 text-left last:border-b-0"
                        onClick={() => openValidationFailure(failure)}
                      >
                        <span className="grid min-w-0 gap-1">
                          <span className="flex flex-wrap items-center gap-2">
                            <Badge variant={target?.mode === "blocks" ? "secondary" : "outline"}>{target?.mode || "missing"}</Badge>
                            <span className="font-mono text-xs text-muted-foreground">{failure.line_id || "(unknown)"}</span>
                          </span>
                          <span className="text-sm font-medium">{validationIssueLabel(failure.issue)}</span>
                          {problemChars.length > 0 && (
                            <span className="text-xs text-destructive">
                              Unsupported: {problemChars.map((item) => item.label).join(", ")}
                            </span>
                          )}
                          {excerpt && (
                            <span className="whitespace-normal text-xs text-muted-foreground">{excerpt}</span>
                          )}
                          {summary && (
                            <span className="text-xs text-muted-foreground">{summary}</span>
                          )}
                        </span>
                      </Button>
                    );
                  })}
                  {validationFailures.length > 80 && (
                    <p className="p-2 text-xs text-muted-foreground">
                      Showing 80 of {validationFailures.length} failures. Fix visible failures or filter in the editor, then validate again.
                    </p>
                  )}
                </div>
              </div>
            )}

            <ScrollArea className="min-h-0">
              <div className="flex flex-col gap-2 p-3">
                {busy && (
                  <div className="rounded-lg border bg-accent p-2 text-sm text-accent-foreground">
                    Running {busy}
                    {deepSeekProgress ? ` ${deepSeekProgress.done}/${deepSeekProgress.total}` : ""}...
                  </div>
                )}
                {workflowLog.map((line, index) => (
                  <pre key={`${index}-${line.slice(0, 12)}`} className="whitespace-pre-wrap break-words rounded-lg border bg-card p-2 text-xs leading-5">
                    {line}
                  </pre>
                ))}
              </div>
            </ScrollArea>
          </div>
        </aside>
      </main>

      {deepSeekRunning && (
        <div className="fixed inset-0 z-[70] grid place-items-center bg-background/70 p-4 backdrop-blur-sm">
          <div
            role="status"
            aria-live="polite"
            className="grid w-full max-w-md gap-5 rounded-lg border bg-card/95 p-6 text-card-foreground shadow-2xl"
          >
            <div className="flex items-center gap-4">
              <div className="deepseek-loader-gif" aria-hidden="true">
                <span />
                <span />
                <span />
                <span />
              </div>
              <div className="min-w-0">
                <p className="text-sm text-muted-foreground">DeepSeek is running</p>
                <h2 className="truncate text-xl font-semibold">{deepSeekOverlayTitle}</h2>
              </div>
            </div>

            <div className="grid gap-2">
              <div className="flex items-center justify-between gap-3 text-sm">
                <span className="font-medium">{deepSeekOverlayStatus}</span>
                <span className="text-muted-foreground">{deepSeekProgressPercent}%</span>
              </div>
              <div className="h-2 overflow-hidden rounded-full bg-muted">
                <div
                  className="deepseek-progress-bar h-full rounded-full bg-primary"
                  style={{ width: `${deepSeekProgressPercent}%` }}
                />
              </div>
              <div className="flex flex-wrap gap-2 pt-1">
                <Badge variant="secondary">{deepSeekProgressDone}/{deepSeekProgressTotal || 1} done</Badge>
                {deepSeekProgress?.failed > 0 && <Badge variant="destructive">{deepSeekProgress.failed} failed</Badge>}
                {deepSeekProgress?.mode === "blocks" && <Badge variant="outline">{deepSeekProgress.parallel || 1} parallel</Badge>}
              </div>
            </div>

            <div className="flex justify-end">
              <Button
                type="button"
                variant="destructive"
                disabled={deepSeekCancelling}
                onClick={cancelDeepSeekRequest}
              >
                <X data-icon="inline-start" />
                {deepSeekCancelling ? "Cancelling" : "Cancel"}
              </Button>
            </div>
          </div>
        </div>
      )}

      {deepSeekLoopModalOpen && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-background/80 p-4 backdrop-blur-sm">
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="deepseek-loop-title"
            className="grid w-full max-w-lg overflow-hidden rounded-lg border bg-card shadow-xl"
          >
            <div className="border-b p-4">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <p className="text-sm text-muted-foreground">Sequential block translation</p>
                  <h2 id="deepseek-loop-title" className="truncate text-xl font-semibold">
                    DeepSeek Loop
                  </h2>
                </div>
                <Badge variant="outline">{DEEPSEEK_LOOP_MODEL}</Badge>
              </div>
            </div>

            <div className="grid gap-4 p-4">
              <div className="grid gap-2 rounded-lg border bg-muted/40 p-3 text-sm text-muted-foreground">
                <div><strong className="text-foreground">Starts at</strong> {loopStartBlock?.block_id || "no available block"}</div>
                <div><strong className="text-foreground">Last translated</strong> {lastTranslatedBlock?.block_id || "none"}</div>
                <div><strong className="text-foreground">Order</strong> one block at a time, no parallelism</div>
                <div><strong className="text-foreground">Retries</strong> {DEEPSEEK_LOOP_RETRIES} per block, then stop</div>
                <div><strong className="text-foreground">Saving</strong> successful translations are saved automatically</div>
              </div>

              <div className="grid gap-2">
                <span className="text-sm font-medium">Start point</span>
                <div className="grid grid-cols-1 rounded-lg border bg-muted p-1 min-[520px]:grid-cols-2">
                  <Button
                    type="button"
                    variant={deepSeekLoopStartMode === "selected" ? "secondary" : "ghost"}
                    className="h-8 rounded-md"
                    onClick={() => setDeepSeekLoopStartMode("selected")}
                  >
                    Selected block
                  </Button>
                  <Button
                    type="button"
                    variant={deepSeekLoopStartMode === "after-last-translated" ? "secondary" : "ghost"}
                    className="h-8 rounded-md"
                    onClick={() => setDeepSeekLoopStartMode("after-last-translated")}
                  >
                    After last translated
                  </Button>
                </div>
              </div>

              <label className="grid gap-2">
                <span className="text-sm font-medium">Blocks to translate</span>
                <Input
                  type="number"
                  min="1"
                  max={Math.max(loopAvailableBlockCount, 1)}
                  step="1"
                  value={deepSeekBlockCount}
                  onChange={(event) => setDeepSeekBlockCount(event.target.value)}
                />
              </label>

              <div className="flex flex-wrap gap-2">
                <Badge variant="secondary">
                  {requestedDeepSeekLoopBlockCount} queued
                </Badge>
                <Badge variant="outline">{loopAvailableBlockCount} available</Badge>
                <Badge variant="outline">{textProfile}</Badge>
              </div>
            </div>

            <div className="flex flex-wrap justify-end gap-2 border-t p-4">
              <Button type="button" variant="outline" onClick={() => setDeepSeekLoopModalOpen(false)}>
                Cancel
              </Button>
              <Button
                type="button"
                disabled={!health?.deepseekConfigured || busy === "deepseek" || !deepSeekLoopBlockTargets.length}
                onClick={runDeepSeekLoop}
              >
                <Bot data-icon="inline-start" />
                Start loop
              </Button>
            </div>
          </div>
        </div>
      )}

      {deepSeekModalOpen && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-background/80 p-4 backdrop-blur-sm">
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="deepseek-request-title"
            className="flex max-h-[calc(100vh-2rem)] w-full max-w-5xl flex-col overflow-hidden rounded-lg border bg-card shadow-xl"
          >
            <div className="border-b p-4">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <p className="text-sm text-muted-foreground">{deepSeekTargetDescription}</p>
                  <h2 id="deepseek-request-title" className="truncate text-xl font-semibold">
                    {deepSeekTargetLabel || "DeepSeek Request"}
                  </h2>
                </div>
                <Badge variant="outline">{viewMode}</Badge>
              </div>
            </div>

            <div className="min-h-0 flex-1 overflow-auto p-4 scrollbar-thin">
              <div className="grid gap-4">
                <div className="grid grid-cols-[minmax(0,1fr)_120px_auto] items-end gap-3 max-[760px]:grid-cols-1">
                  <label className="grid gap-2">
                    <span className="text-sm font-medium">Model</span>
                    <Input
                      value={deepSeekModel}
                      onChange={(event) => setDeepSeekModel(event.target.value)}
                      placeholder="deepseek-v4-flash"
                    />
                  </label>
                  <label className="grid gap-2">
                    <span className="text-sm font-medium">Temperature</span>
                    <Input
                      type="number"
                      min="0"
                      max="2"
                      step="0.1"
                      value={deepSeekTemperature}
                      onChange={(event) => setDeepSeekTemperature(event.target.value)}
                    />
                  </label>
                  <Button
                    type="button"
                    variant="outline"
                    disabled={deepSeekPromptLoading}
                    onClick={loadDeepSeekPromptParts}
                  >
                    <RefreshCw data-icon="inline-start" />
                    Defaults
                  </Button>
                </div>

                {viewMode === "blocks" && (
                  <div className="grid grid-cols-[140px_140px_minmax(0,1fr)] items-end gap-3 max-[760px]:grid-cols-1">
                    <label className="grid gap-2">
                      <span className="text-sm font-medium">Blocks</span>
                      <Input
                        type="number"
                        min="1"
                        max={Math.max(remainingBlockCount, 1)}
                        step="1"
                        value={deepSeekBlockCount}
                        onChange={(event) => setDeepSeekBlockCount(event.target.value)}
                      />
                    </label>
                    <label className="grid gap-2">
                      <span className="text-sm font-medium">Parallel</span>
                      <Input
                        type="number"
                        min="1"
                        max={Math.min(Math.max(deepSeekBlockTargets.length, 1), 10)}
                        step="1"
                        value={deepSeekParallelCount}
                        onChange={(event) => setDeepSeekParallelCount(event.target.value)}
                      />
                    </label>
                    <div className="flex flex-wrap gap-2 pb-2">
                      <Badge variant="secondary">{deepSeekBlockTargets.length || 0} queued</Badge>
                      <Badge variant="outline">{requestedDeepSeekParallelCount} parallel</Badge>
                    </div>
                  </div>
                )}

                <div className="grid gap-3">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium">Prompt parts</span>
                      <Badge variant="outline">{deepSeekPromptParts.length}</Badge>
                    </div>
                  </div>
                  {deepSeekPromptLoading ? (
                    <div className="rounded-lg border bg-muted p-4 text-sm text-muted-foreground">Loading default prompt...</div>
                  ) : deepSeekPromptParts.length ? (
                    deepSeekPromptParts.map((part) => (
                      <div key={part.id} className="grid gap-2 rounded-lg border bg-background p-3">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <span className="text-sm font-medium">{part.label}</span>
                        </div>
                        <Textarea
                          aria-label={part.label}
                          value={part.content}
                          onChange={(event) => updateDeepSeekPromptPart(part.id, event.target.value)}
                          rows={Math.min(Math.max(Number(part.rows || 5), 3), 14)}
                          spellCheck="true"
                          className="resize-y font-mono text-xs leading-5"
                        />
                      </div>
                    ))
                  ) : (
                    <div className="rounded-lg border bg-muted p-4 text-sm text-muted-foreground">No prompt parts loaded.</div>
                  )}
                </div>
              </div>
            </div>

            <div className="flex flex-wrap justify-end gap-2 border-t p-4">
              <Button type="button" variant="outline" onClick={() => setDeepSeekModalOpen(false)}>
                Cancel
              </Button>
              <Button
                type="button"
                disabled={
                  !deepSeekTargetLabel ||
                  busy === "deepseek" ||
                  !health?.deepseekConfigured ||
                  deepSeekPromptLoading ||
                  (viewMode === "blocks" && !deepSeekBlockTargets.length) ||
                  !deepSeekHasPromptContent
                }
                onClick={askDeepSeek}
              >
                <Bot data-icon="inline-start" />
                {viewMode === "blocks" && deepSeekBlockTargets.length > 1 ? `Send ${deepSeekBlockTargets.length}` : "Send"}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function PipelineButton({ tooltip, children, className, ...props }) {
  return (
    <TooltipButton
      tooltip={tooltip}
      variant="outline"
      wrapperClassName="w-full"
      className={cn("w-full justify-start bg-card", className)}
      {...props}
    >
      {children}
    </TooltipButton>
  );
}

createRoot(document.getElementById("root")).render(
  <ThemeProvider defaultTheme="system" storageKey="megami-ui-theme">
    <TooltipProvider delayDuration={250}>
      <App />
    </TooltipProvider>
  </ThemeProvider>,
);
