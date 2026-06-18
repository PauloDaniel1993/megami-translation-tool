import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Bot,
  CheckCircle2,
  Download,
  FileJson,
  Filter,
  Moon,
  Play,
  RefreshCw,
  RotateCcw,
  Save,
  Search,
  ShieldCheck,
  Sun,
  Wrench,
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

function speakerName(row) {
  if (!row) return "";
  return row.speaker_en || row.speaker_jp || (row.role === "narration" ? "Narration" : "No speaker");
}

function issueLabel(issue) {
  return ISSUE_LABELS[issue] || issue;
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
  const [dirty, setDirty] = useState(new Set());
  const [selectedId, setSelectedId] = useState("");
  const [query, setQuery] = useState("");
  const [roleFilter, setRoleFilter] = useState("all");
  const [issueFilter, setIssueFilter] = useState("all");
  const [sceneFilter, setSceneFilter] = useState("all");
  const [suggestion, setSuggestion] = useState(null);
  const [instruction, setInstruction] = useState("");
  const [busy, setBusy] = useState("");
  const [workflowLog, setWorkflowLog] = useState([]);
  const [backups, setBackups] = useState([]);
  const [promptOpen, setPromptOpen] = useState(false);

  async function loadFiles() {
    const [healthPayload, filesPayload, backupsPayload] = await Promise.all([
      api("/api/health"),
      api("/api/files"),
      api("/api/backups"),
    ]);
    setHealth(healthPayload);
    setFiles(filesPayload.files);
    setBackups(backupsPayload.backups || []);
    if (!stem && filesPayload.files[0]) setStem(filesPayload.files[0].stem);
  }

  async function loadStem(nextStem = stem, nextProfile = textProfile) {
    if (!nextStem) return;
    setBusy("load");
    try {
      const data = await api(`/api/files/${nextStem}?textProfile=${encodeURIComponent(nextProfile)}`);
      const nextDrafts = {};
      for (const row of data.rows) nextDrafts[row.line_id] = { en: row.en || "", notes: row.notes || "" };
      setPayload(data);
      setDrafts(nextDrafts);
      setDirty(new Set());
      setSelectedId(data.rows.find((row) => row.editable)?.line_id || data.rows[0]?.line_id || "");
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
  }, [selectedId, stem]);

  const rows = payload?.rows || [];
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

  const selected = rowsWithDrafts.find((row) => row.line_id === selectedId) || filteredRows[0] || rowsWithDrafts[0];
  const selectedIndex = selected ? rowsWithDrafts.findIndex((row) => row.line_id === selected.line_id) : -1;
  const sceneSummary = selected ? (payload?.sceneSummaries || []).find((scene) => scene.scene_id === selected.scene_id) : null;
  const promptByBatch = useMemo(() => {
    const prompts = new Map();
    for (const prompt of payload?.translationPrompts || []) prompts.set(prompt.batch_id, prompt);
    return prompts;
  }, [payload]);
  const selectedPrompt = selected?.batch_id ? promptByBatch.get(selected.batch_id) : null;
  const previousTranslations =
    selectedIndex > -1
      ? rowsWithDrafts
          .slice(0, selectedIndex)
          .filter((row) => row.scene_id === selected.scene_id && row.editable && row.draft.en.trim())
          .slice(-6)
      : [];

  function updateDraft(lineId, patch) {
    setDrafts((current) => ({
      ...current,
      [lineId]: { ...(current[lineId] || {}), ...patch },
    }));
    setDirty((current) => new Set(current).add(lineId));
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
        body: JSON.stringify({ changes }),
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

  async function runWorkflow(label, path, body = {}) {
    setBusy(label);
    try {
      const result = await api(path, { method: "POST", body: JSON.stringify(body) });
      setWorkflowLog((log) => [`${label}: ${compactCommand(result) || "ok"}`, result.stdout, result.stderr, ...log].filter(Boolean));
      if (result.overflowReport) {
        setPayload((current) => (current ? { ...current, overflowReport: result.overflowReport } : current));
      }
      await loadFiles();
      return result;
    } catch (error) {
      setWorkflowLog((log) => [`${label} failed: ${error.message}`, ...log]);
      return null;
    } finally {
      setBusy("");
    }
  }

  async function askDeepSeek() {
    if (!selected) return;
    setBusy("deepseek");
    setSuggestion(null);
    try {
      const result = await api(`/api/files/${stem}/retranslate`, {
        method: "POST",
        body: JSON.stringify({
          lineId: selected.line_id,
          instruction,
          textProfile,
          model: "deepseek-v4-flash",
        }),
      });
      setSuggestion(result.suggestion);
      setWorkflowLog((log) => [`DeepSeek suggestion saved for ${selected.line_id}`, ...log]);
    } catch (error) {
      setWorkflowLog((log) => [`DeepSeek failed: ${error.message}`, ...log]);
    } finally {
      setBusy("");
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
  const failures = rowsWithDrafts.filter((row) => row.currentIssues.length && row.editable).length;
  const overflowReport = payload?.overflowReport;
  const autoBreaks = overflowReport?.insertedWindows || 0;
  const selectedWindowStats = estimatePageWindows(selected, rowsWithDrafts);
  const reportedOverflowPage = selected
    ? overflowReport?.pages?.find((page) => page.page_id === selected.page_id)
    : null;

  return (
    <div className="h-screen overflow-hidden bg-background text-foreground">
      <header className="grid h-14 grid-cols-[auto_150px_220px_1fr_auto] items-center gap-3 border-b bg-card/95 px-3 shadow-sm backdrop-blur max-[980px]:h-auto max-[980px]:grid-cols-1 max-[980px]:py-3">
        <div className="flex min-w-0 items-center gap-2 font-semibold">
          <FileJson data-icon="inline-start" />
          <span className="truncate">Megami Translation Tool</span>
        </div>

        <AppSelect value={stem} onValueChange={setStem} label="File">
          {files.map((file) => (
            <SelectItem key={file.stem} value={file.stem}>
              {file.file}
            </SelectItem>
          ))}
        </AppSelect>

        <AppSelect value={textProfile} onValueChange={setTextProfile} label="Text profile">
          <SelectItem value="apostrophe-patched">apostrophe-patched</SelectItem>
          <SelectItem value="vanilla">vanilla</SelectItem>
        </AppSelect>

        <div className="flex min-w-0 flex-wrap justify-end gap-2 max-[980px]:justify-start">
          <MetricBadge>{translated}/{editable}</MetricBadge>
          <MetricBadge>{dirty.size} dirty</MetricBadge>
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
        <aside className="min-h-0 border-r bg-sidebar text-sidebar-foreground">
          <div className="flex flex-col gap-3 border-b p-3">
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
              <div className="flex items-center gap-2">
                <Filter className="size-4 text-muted-foreground" />
                <AppSelect value={sceneFilter} onValueChange={setSceneFilter} label="Scene filter">
                  <SelectItem value="all">All scenes</SelectItem>
                  {scenes.map(([id, title]) => (
                    <SelectItem key={id} value={id}>
                      {title}
                    </SelectItem>
                  ))}
                </AppSelect>
              </div>
              <AppSelect value={roleFilter} onValueChange={setRoleFilter} label="Role filter">
                <SelectItem value="all">All roles</SelectItem>
                <SelectItem value="narration">Narration</SelectItem>
                <SelectItem value="dialogue">Dialogue</SelectItem>
                <SelectItem value="speaker">Speaker</SelectItem>
              </AppSelect>
                <AppSelect value={issueFilter} onValueChange={setIssueFilter} label="Issue filter">
                  <SelectItem value="all">All lines</SelectItem>
                  <SelectItem value="dirty">Dirty</SelectItem>
                  <SelectItem value="untranslated">Untranslated</SelectItem>
                  <SelectItem value="empty">Empty</SelectItem>
                <SelectItem value="line_too_long">Wrap needed</SelectItem>
                  <SelectItem value="apostrophe">Apostrophe</SelectItem>
                </AppSelect>
            </div>
          </div>

          <ScrollArea className="h-[calc(100vh-12rem)] max-[760px]:h-80">
            <div className="divide-y">
              {filteredRows.map((row) => (
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
            {selected ? (
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
                    <div className="flex gap-2">
                      <Input
                        value={instruction}
                        onChange={(event) => setInstruction(event.target.value)}
                        placeholder="Retranslation instruction"
                      />
                      <TooltipButton
                        tooltip={`Ask DeepSeek to retranslate ${selected.line_id}`}
                        disabled={!selected.editable || busy === "deepseek"}
                        onClick={askDeepSeek}
                      >
                        <Icon><Bot /></Icon>
                        Ask
                      </TooltipButton>
                    </div>
                    {suggestion && (
                      <div className="grid gap-2 rounded-lg border bg-accent p-3 text-accent-foreground">
                        <p className="font-semibold">{suggestion.en}</p>
                        {suggestion.notes && <p className="text-sm opacity-80">{suggestion.notes}</p>}
                        <TooltipButton
                          tooltip={`Apply the DeepSeek suggestion to ${selected.line_id}`}
                          variant="secondary"
                          className="w-fit"
                          onClick={() => updateDraft(selected.line_id, { en: suggestion.en || "" })}
                        >
                          <Icon><Download /></Icon>
                          Apply
                        </TooltipButton>
                      </div>
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
          <div className="grid h-full grid-rows-[auto_auto_auto_minmax(0,1fr)]">
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
              <div><strong>Clean source</strong> {payload?.cleanSourceExists ? "yes" : "missing"}</div>
              <div>
                <strong>Overflow report</strong>{" "}
                {overflowReport?.exists
                  ? `${overflowReport.overflowPages} pages / ${overflowReport.insertedWindows || 0} @h / ${overflowReport.wrappedLines} wrapped`
                  : "missing"}
              </div>
              <div><strong>Latest backup</strong> {latestBackup?.id || "none"}</div>
            </div>

            <div className="border-b">
              <Button
                type="button"
                variant="ghost"
                title={promptOpen ? "Hide the captured DeepSeek prompt for this batch" : "Show the captured DeepSeek prompt for this batch"}
                className="h-auto w-full justify-between rounded-none px-3 py-2"
                aria-expanded={promptOpen}
                onClick={() => setPromptOpen((value) => !value)}
              >
                <span>DeepSeek prompt</span>
                <Badge variant="outline">{selectedPrompt ? selectedPrompt.batch_id : "not captured"}</Badge>
              </Button>
              {promptOpen && selectedPrompt ? (
                <div className="grid gap-2 p-3">
                  <div className="flex flex-wrap gap-2">
                    <Badge variant="secondary">{selected?.line_id}</Badge>
                    {selectedPrompt.model && <Badge variant="secondary">{selectedPrompt.model}</Badge>}
                    {selectedPrompt.status && <Badge variant="secondary">{selectedPrompt.status}</Badge>}
                  </div>
                  <pre className="max-h-72 overflow-auto rounded-lg border bg-muted p-3 text-xs leading-5 text-muted-foreground scrollbar-thin whitespace-pre-wrap break-words">
                    {selectedPrompt.prompt}
                  </pre>
                </div>
              ) : promptOpen ? (
                <p className="p-3 text-sm text-muted-foreground">No captured DeepSeek prompt for this line.</p>
              ) : null}
            </div>

            <ScrollArea className="min-h-0">
              <div className="flex flex-col gap-2 p-3">
                {busy && <div className="rounded-lg border bg-accent p-2 text-sm text-accent-foreground">Running {busy}...</div>}
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
