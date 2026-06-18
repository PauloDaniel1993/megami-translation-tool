import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Bot,
  CheckCircle2,
  Download,
  FileJson,
  Filter,
  Play,
  RefreshCw,
  RotateCcw,
  Save,
  Search,
  ShieldCheck,
  Wrench,
} from "lucide-react";
import "./styles.css";

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
  const lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n").filter((line) => line.trim());
  if (row.editable && !text.trim()) issues.add("empty");
  for (const line of lines) {
    if (line.trim().length > row.max_chars) issues.add("line_too_long");
  }
  if (textProfile === "vanilla" && text.includes("'")) issues.add("apostrophe");
  return [...issues];
}

function speakerName(row) {
  if (!row) return "";
  return row.speaker_en || row.speaker_jp || (row.role === "narration" ? "Narration" : "No speaker");
}

function compactCommand(result) {
  if (!result) return "";
  const pieces = [];
  if (result.command) pieces.push(result.command);
  if (typeof result.exitCode === "number") pieces.push(`exit ${result.exitCode}`);
  if (result.report) {
    pieces.push(result.report.ok ? "validation ok" : `${result.report.failures?.length || 0} failures`);
  }
  if (result.source) pieces.push(`source ${result.source}`);
  if (result.current?.state) pieces.push(`main.exe ${result.current.state}`);
  if (result.jobs) pieces.push(result.jobs);
  if (result.outDir) pieces.push(result.outDir);
  return pieces.join(" | ");
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
  const sceneSummary = selected
    ? (payload?.sceneSummaries || []).find((scene) => scene.scene_id === selected.scene_id)
    : null;
  const promptByBatch = useMemo(() => {
    const prompts = new Map();
    for (const prompt of payload?.translationPrompts || []) prompts.set(prompt.batch_id, prompt);
    return prompts;
  }, [payload]);
  const selectedPrompt = selected?.batch_id ? promptByBatch.get(selected.batch_id) : null;
  const previousTranslations = selectedIndex > -1
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

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <FileJson size={18} />
          <span>Megami Translation Tool</span>
        </div>
        <select value={stem} onChange={(event) => setStem(event.target.value)} aria-label="File">
          {files.map((file) => (
            <option key={file.stem} value={file.stem}>
              {file.file}
            </option>
          ))}
        </select>
        <select value={textProfile} onChange={(event) => setTextProfile(event.target.value)} aria-label="Text profile">
          <option value="apostrophe-patched">apostrophe-patched</option>
          <option value="vanilla">vanilla</option>
        </select>
        <div className="metrics">
          <span>{translated}/{editable}</span>
          <span>{dirty.size} dirty</span>
          <span>{failures} flagged</span>
          <span>{health?.deepseekConfigured ? "DeepSeek ready" : "No API key"}</span>
        </div>
      </header>

      <main className="workspace">
        <aside className="sidebar">
          <div className="toolbar">
            <div className="searchbox">
              <Search size={15} />
              <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search" />
            </div>
            <button type="button" onClick={() => loadStem(stem, textProfile)} title="Reload">
              <RefreshCw size={16} />
            </button>
          </div>
          <div className="filters">
            <label>
              <Filter size={14} />
              <select value={sceneFilter} onChange={(event) => setSceneFilter(event.target.value)}>
                <option value="all">All scenes</option>
                {scenes.map(([id, title]) => (
                  <option key={id} value={id}>
                    {title}
                  </option>
                ))}
              </select>
            </label>
            <select value={roleFilter} onChange={(event) => setRoleFilter(event.target.value)}>
              <option value="all">All roles</option>
              <option value="narration">Narration</option>
              <option value="dialogue">Dialogue</option>
              <option value="speaker">Speaker</option>
            </select>
            <select value={issueFilter} onChange={(event) => setIssueFilter(event.target.value)}>
              <option value="all">All lines</option>
              <option value="dirty">Dirty</option>
              <option value="untranslated">Untranslated</option>
              <option value="empty">Empty</option>
              <option value="line_too_long">Too long</option>
              <option value="apostrophe">Apostrophe</option>
            </select>
          </div>
          <div className="line-list">
            {filteredRows.map((row) => (
              <button
                key={row.line_id}
                type="button"
                className={`line-row ${selected?.line_id === row.line_id ? "active" : ""} ${row.isDirty ? "dirty" : ""}`}
                onClick={() => {
                  setSelectedId(row.line_id);
                  setSuggestion(null);
                }}
              >
                <span className="line-id">{row.line_id}</span>
                <span className="line-role">{speakerName(row)}</span>
                <span className="line-text">{row.draft.en || row.jp}</span>
                {row.currentIssues.length > 0 && <span className="issue-pill">{row.currentIssues[0]}</span>}
              </button>
            ))}
          </div>
        </aside>

        <section className="editor">
          {selected ? (
            <>
              <div className="editor-head">
                <div>
                  <div className="eyebrow">{selected.scene_title_jp}</div>
                  <h1>{selected.line_id}</h1>
                </div>
                <div className="head-actions">
                  <button type="button" onClick={() => saveChanges([selected.line_id])} disabled={!dirty.has(selected.line_id) || busy === "save"}>
                    <Save size={16} />
                    Save
                  </button>
                  <button type="button" onClick={() => saveChanges()} disabled={!dirty.size || busy === "save"}>
                    <Save size={16} />
                    Save all
                  </button>
                </div>
              </div>

              <div className="meta-strip">
                <span>line {selected.line_number}</span>
                <span>page {selected.page_index}</span>
                <span>{selected.role}</span>
                <span>{speakerName(selected)}</span>
                <span>max {selected.max_chars}</span>
                <span>{selected.currentIssues.length ? selected.currentIssues.join(", ") : "clean"}</span>
              </div>

              <div className="context-grid">
                <section className="speaker-block">
                  <div className="context-label">Speaker</div>
                  <div className="speaker-name">{speakerName(selected)}</div>
                  {selected.speaker_jp && <div className="speaker-jp" lang="ja">{selected.speaker_jp}</div>}
                  <div className="speaker-meta">{selected.role} · {selected.kind || "text"}</div>
                </section>

                <section className="scene-block">
                  <div className="context-label">Scene Context</div>
                  <div className="scene-title">{sceneSummary?.scene_title_en || selected.scene_title_jp}</div>
                  {sceneSummary?.summary_jp && <p lang="ja">{sceneSummary.summary_jp}</p>}
                  {Array.isArray(sceneSummary?.active_characters) && sceneSummary.active_characters.length > 0 && (
                    <div className="context-tags">
                      {sceneSummary.active_characters.map((name) => <span key={name}>{name}</span>)}
                    </div>
                  )}
                  {Array.isArray(sceneSummary?.translation_notes_en) && sceneSummary.translation_notes_en.length > 0 && (
                    <ul className="context-notes">
                      {sceneSummary.translation_notes_en.slice(0, 4).map((note) => <li key={note}>{note}</li>)}
                    </ul>
                  )}
                </section>
              </div>

              <section className="previous-context">
                <div className="context-label">Previous Translations</div>
                {previousTranslations.length ? previousTranslations.map((row) => (
                  <button
                    key={row.line_id}
                    type="button"
                    className="context-line"
                    onClick={() => {
                      setSelectedId(row.line_id);
                      setSuggestion(null);
                    }}
                  >
                    <span className="context-line-head">
                      <span>{row.line_id}</span>
                      <strong>{speakerName(row)}</strong>
                    </span>
                    <span className="context-line-jp" lang="ja">{row.jp}</span>
                    <span className="context-line-en">{row.draft.en}</span>
                  </button>
                )) : <div className="context-empty">No previous translated lines in this scene.</div>}
              </section>

              <div className="jp-block" lang="ja">{selected.jp}</div>

              <label className="field">
                <span>English</span>
                <textarea
                  value={selected.draft.en}
                  onChange={(event) => updateDraft(selected.line_id, { en: event.target.value })}
                  spellCheck="true"
                  rows={6}
                  disabled={!selected.editable}
                />
              </label>

              <label className="field">
                <span>Notes</span>
                <textarea
                  value={selected.draft.notes}
                  onChange={(event) => updateDraft(selected.line_id, { notes: event.target.value })}
                  rows={3}
                  disabled={!selected.editable}
                />
              </label>

              <div className="deepseek">
                <div className="deepseek-row">
                  <input
                    value={instruction}
                    onChange={(event) => setInstruction(event.target.value)}
                    placeholder="Retranslation instruction"
                  />
                  <button type="button" onClick={askDeepSeek} disabled={!selected.editable || busy === "deepseek"}>
                    <Bot size={16} />
                    Ask
                  </button>
                </div>
                {suggestion && (
                  <div className="suggestion">
                    <div className="suggestion-text">{suggestion.en}</div>
                    {suggestion.notes && <div className="suggestion-notes">{suggestion.notes}</div>}
                    <button type="button" onClick={() => updateDraft(selected.line_id, { en: suggestion.en || "" })}>
                      <Download size={16} />
                      Apply
                    </button>
                  </div>
                )}
              </div>
            </>
          ) : (
            <div className="empty-state">No lines loaded.</div>
          )}
        </section>

        <aside className="workflow">
          <div className="workflow-actions">
            <button className="pipeline-step" type="button" onClick={() => runWorkflow("validate", "/api/workflows/validate", { stem, textProfile })}>
              <CheckCircle2 size={16} />
              Validate
            </button>
            <button className="pipeline-step" type="button" onClick={() => runWorkflow("build jobs", "/api/workflows/build-jobs", { stem, textProfile })}>
              <Wrench size={16} />
              Jobs
            </button>
            <button className="pipeline-step" type="button" onClick={() => runWorkflow("reinsert", "/api/workflows/reinsert", { stem, textProfile, mode: "variable" })}>
              <Wrench size={16} />
              Reinsert
            </button>
            <button className="pipeline-step" type="button" onClick={() => runWorkflow("verify exe", "/api/workflows/exe/verify")}>
              <ShieldCheck size={16} />
              Verify exe
            </button>
            <button className="pipeline-step" type="button" onClick={() => runWorkflow("build exe", "/api/workflows/exe/build")}>
              <Wrench size={16} />
              Build exe
            </button>
            <button className="pipeline-step" type="button" onClick={installBuild}>
              <Download size={16} />
              Install
            </button>
            <button className="pipeline-step" type="button" onClick={() => runWorkflow("launch", "/api/launch")}>
              <Play size={16} />
              Launch
            </button>
            <button className="pipeline-step" type="button" onClick={() => restoreBackup(latestBackup?.id)} disabled={!latestBackup}>
              <RotateCcw size={16} />
              Restore
            </button>
          </div>

          <div className="status-block">
            <div><strong>Approved</strong> {payload?.approvedExists ? "yes" : "missing"}</div>
            <div><strong>Clean source</strong> {payload?.cleanSourceExists ? "yes" : "missing"}</div>
            <div><strong>Latest backup</strong> {latestBackup?.id || "none"}</div>
          </div>

          <div className={`prompt-panel ${promptOpen ? "open" : ""}`}>
            <button
              type="button"
              className="prompt-summary"
              onClick={() => setPromptOpen((value) => !value)}
              aria-expanded={promptOpen}
            >
              <span>DeepSeek prompt</span>
              <small>{selectedPrompt ? selectedPrompt.batch_id : "not captured"}</small>
            </button>
            {promptOpen && selectedPrompt ? (
              <div className="prompt-body">
                <div className="prompt-meta">
                  <span>{selected?.line_id}</span>
                  {selectedPrompt.model && <span>{selectedPrompt.model}</span>}
                  {selectedPrompt.status && <span>{selectedPrompt.status}</span>}
                </div>
                <pre>{selectedPrompt.prompt}</pre>
              </div>
            ) : promptOpen ? (
              <div className="prompt-empty">No captured DeepSeek prompt for this line.</div>
            ) : null}
          </div>

          <div className="log">
            {busy && <div className="log-line running">Running {busy}...</div>}
            {workflowLog.map((line, index) => (
              <pre key={`${index}-${line.slice(0, 12)}`} className="log-line">{line}</pre>
            ))}
          </div>
        </aside>
      </main>
    </div>
  );
}

createRoot(document.getElementById("root")).render(<App />);
