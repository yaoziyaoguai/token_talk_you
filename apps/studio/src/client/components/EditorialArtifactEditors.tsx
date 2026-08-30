import { podcastChapterPlanIssues } from "@token-talk/domain/podcast";
import { FileAudio, FileText, LayoutList, LoaderCircle, LockKeyhole, LockOpen, Plus, RotateCw, Save, Search, Trash2, UsersRound } from "lucide-react";
import { useEffect, useState } from "react";

interface EditorProps {
  value: unknown;
  saving: boolean;
  onSave: (value: Record<string, unknown>) => void;
  onDirtyChange: (dirty: boolean) => void;
  readOnly: boolean;
}

interface ScriptEditorProps extends EditorProps {
  segmentLabels?: Record<string, string>;
  regeneratingSegmentId?: string | undefined;
  onRegenerateSegment?: ((segmentId: string) => void) | undefined;
}

const RESEARCH_SOURCE_KINDS = ["scholarly", "primary", "book", "web"] as const;

export function ResearchPlanEditor({ value, saving, onSave, onDirtyChange, readOnly }: EditorProps) {
  const persisted = JSON.stringify(asRecord(value));
  const [plan, setPlan] = useState<Record<string, unknown>>(() => structuredClone(asRecord(value)));
  useEffect(() => setPlan(structuredClone(asRecord(value))), [persisted]);
  const queries = asArray(plan.queries).map(asRecord);
  const synthesisDirectives = asArray(plan.synthesisDirectives).filter((item): item is string => typeof item === "string");
  const dirty = JSON.stringify(plan) !== persisted;
  const valid = queries.length >= 2 && queries.length <= 6
    && queries.every((query) => text(query.query) && text(query.intent) && ["zh", "en"].includes(String(query.language)) && asArray(query.sourceKinds).length > 0)
    && synthesisDirectives.every((directive) => directive.trim().length > 0);
  useDirtySignal(dirty, onDirtyChange);

  function updateQuery(index: number, key: string, nextValue: unknown) {
    setPlan((current) => ({ ...current, status: "draft", queries: asArray(current.queries).map((query, queryIndex) => queryIndex === index ? { ...asRecord(query), [key]: nextValue } : query) }));
  }

  function toggleSourceKind(index: number, sourceKind: typeof RESEARCH_SOURCE_KINDS[number]) {
    const current = asArray(queries[index]?.sourceKinds).filter((item): item is string => typeof item === "string");
    updateQuery(index, "sourceKinds", current.includes(sourceKind) ? current.filter((item) => item !== sourceKind) : [...current, sourceKind]);
  }

  function addQuery() {
    if (queries.length >= 6) return;
    setPlan((current) => ({ ...current, status: "draft", queries: [...asArray(current.queries), { query: "", intent: "说明这条检索要补齐的证据", language: "en", sourceKinds: ["scholarly", "web"] }] }));
  }

  function removeQuery(index: number) {
    setPlan((current) => ({ ...current, status: "draft", queries: asArray(current.queries).filter((_query, queryIndex) => queryIndex !== index) }));
  }

  function updateDirective(index: number, nextValue: string) {
    setPlan((current) => ({
      ...current,
      status: "draft",
      synthesisDirectives: asArray(current.synthesisDirectives).map((directive, directiveIndex) => directiveIndex === index ? nextValue : directive),
    }));
  }

  function addDirective() {
    if (synthesisDirectives.length >= 12) return;
    setPlan((current) => ({
      ...current,
      status: "draft",
      synthesisDirectives: [...asArray(current.synthesisDirectives), "说明事实编辑需要如何拆分概念、指标或时间尺度"],
    }));
  }

  function removeDirective(index: number) {
    setPlan((current) => ({
      ...current,
      status: "draft",
      synthesisDirectives: asArray(current.synthesisDirectives).filter((_directive, directiveIndex) => directiveIndex !== index),
    }));
  }

  return <div className="research-plan-editor managed-plan-editor">
    <header><span><Search size={16} aria-hidden="true" />检索路线</span><strong>{queries.length} 条查询</strong></header>
    {queries.length > 0 ? <ol className="managed-plan-list research-query-list">
      {queries.map((query, index) => <li key={`${String(query.query ?? "query")}-${index}`}>
        <span className="managed-plan-number">{String(index + 1).padStart(2, "0")}</span>
        <div className="managed-plan-fields">
          <label className="wide-field"><span>检索式</span><input aria-label={`第 ${index + 1} 条检索式`} value={String(query.query ?? "")} disabled={readOnly} onChange={(event) => updateQuery(index, "query", event.target.value)} /></label>
          <label><span>语言</span><select aria-label={`第 ${index + 1} 条检索语言`} value={String(query.language ?? "en")} disabled={readOnly} onChange={(event) => updateQuery(index, "language", event.target.value)}><option value="en">English</option><option value="zh">中文</option></select></label>
          <label className="full-field"><span>研究意图</span><textarea aria-label={`第 ${index + 1} 条研究意图`} rows={2} value={String(query.intent ?? "")} disabled={readOnly} onChange={(event) => updateQuery(index, "intent", event.target.value)} /></label>
          <fieldset className="research-source-kind-field"><legend>目标来源</legend>{RESEARCH_SOURCE_KINDS.map((sourceKind) => <label key={sourceKind}><input type="checkbox" checked={asArray(query.sourceKinds).includes(sourceKind)} disabled={readOnly} onChange={() => toggleSourceKind(index, sourceKind)} /><span>{researchSourceKindLabel(sourceKind)}</span></label>)}</fieldset>
        </div>
        <IconDelete label={`删除第 ${index + 1} 条检索`} disabled={readOnly || queries.length <= 2} onClick={() => removeQuery(index)} />
      </li>)}
    </ol> : <EmptyEditor title="还没有检索路线" copy="运行研究策划，或手动添加至少两条检索式。" />}
    <section className="research-synthesis-directives" aria-labelledby="research-synthesis-directives-title">
      <header><strong id="research-synthesis-directives-title">综合返修</strong><small>{synthesisDirectives.length} 条</small></header>
      {synthesisDirectives.length > 0 ? <ol>{synthesisDirectives.map((directive, index) => <li key={`${directive}-${index}`}>
        <span className="managed-plan-number">{String(index + 1).padStart(2, "0")}</span>
        <textarea aria-label={`第 ${index + 1} 条综合返修要求`} rows={2} value={directive} disabled={readOnly} onChange={(event) => updateDirective(index, event.target.value)} />
        <IconDelete label={`删除第 ${index + 1} 条综合返修要求`} disabled={readOnly} onClick={() => removeDirective(index)} />
      </li>)}</ol> : <p>当前没有概念或证据结构的定向返修要求。</p>}
      {!readOnly ? <button className="secondary-command" type="button" disabled={synthesisDirectives.length >= 12} onClick={addDirective}><Plus size={14} aria-hidden="true" />添加要求</button> : null}
    </section>
    {!readOnly ? <EditorFooter addLabel="添加检索" addDisabled={queries.length >= 6} onAdd={addQuery} saveLabel="保存检索计划" saving={saving} saveDisabled={!dirty || !valid} onSave={() => onSave({ ...plan, status: "draft", queries, synthesisDirectives })} /> : null}
  </div>;
}

export function ScriptTranscriptEditor({ value, saving, onSave, onDirtyChange, readOnly, segmentLabels = {}, regeneratingSegmentId, onRegenerateSegment }: ScriptEditorProps) {
  const persisted = JSON.stringify(asRecord(value));
  const [script, setScript] = useState<Record<string, unknown>>(() => structuredClone(asRecord(value)));

  useEffect(() => setScript(structuredClone(asRecord(value))), [persisted]);

  const lines = asArray(script.lines).map(asRecord);
  const dirty = JSON.stringify(script) !== persisted;
  const characters = lines.reduce((total, line) => total + String(line.text ?? "").length, 0);
  const valid = lines.length > 0 && lines.every((line) => typeof line.speaker === "string" && line.speaker.trim() && typeof line.text === "string" && line.text.trim());
  const lockedSegmentIds = asArray(script.lockedSegmentIds).filter((item): item is string => typeof item === "string");
  const lockedSegments = new Set(lockedSegmentIds);
  const groups = lines.reduce<Array<{ id: string; lines: Array<{ line: Record<string, unknown>; index: number }> }>>((result, line, index) => {
    const id = typeof line.segmentId === "string" && line.segmentId.trim() ? line.segmentId : "segment-1";
    const existing = result.find((group) => group.id === id);
    if (existing) existing.lines.push({ line, index });
    else result.push({ id, lines: [{ line, index }] });
    return result;
  }, []);
  useDirtySignal(dirty, onDirtyChange);

  function updateLine(index: number, key: "speaker" | "text", nextValue: string) {
    setScript((current) => ({
      ...current,
      status: "draft",
      lines: asArray(current.lines).map((line, lineIndex) => lineIndex === index ? { ...asRecord(line), [key]: nextValue } : line),
    }));
  }

  function addLine() {
    setScript((current) => {
      const currentLines = asArray(current.lines).map(asRecord);
      const previous = currentLines.at(-1);
      return {
        ...current,
        status: "draft",
        lines: [...currentLines, {
          segmentId: typeof previous?.segmentId === "string" ? previous.segmentId : "segment-1",
          speaker: typeof previous?.speaker === "string" ? previous.speaker : "本期主持",
          text: "",
          claimIds: [],
        }],
      };
    });
  }

  function removeLine(index: number) {
    setScript((current) => ({ ...current, status: "draft", lines: asArray(current.lines).filter((_line, lineIndex) => lineIndex !== index) }));
  }

  function toggleSegmentLock(segmentId: string) {
    setScript((current) => {
      const currentLocks = asArray(current.lockedSegmentIds).filter((item): item is string => typeof item === "string");
      return {
        ...current,
        status: "draft",
        lockedSegmentIds: currentLocks.includes(segmentId)
          ? currentLocks.filter((id) => id !== segmentId)
          : [...currentLocks, segmentId],
      };
    });
  }

  return <div className="script-transcript-editor">
    <header>
      <span><FileAudio size={16} aria-hidden="true" />逐字稿</span>
      <div><strong>{lines.length} 句</strong><small>{characters.toLocaleString("zh-CN")} 字 · 约 {Math.max(1, Math.round(characters / 220))} 分钟</small></div>
    </header>
    {groups.length > 0 ? <div className="script-segment-list">
      {groups.map((group, groupIndex) => {
        const locked = lockedSegments.has(group.id);
        const regenerating = regeneratingSegmentId === group.id;
        return <section className={locked ? "script-segment is-locked" : "script-segment"} key={group.id} aria-labelledby={`script-segment-${group.id}`}>
          <header className="script-segment-header">
            <div><span>章节 {String(groupIndex + 1).padStart(2, "0")}</span><strong id={`script-segment-${group.id}`}>{segmentLabels[group.id] ?? group.id}</strong><small>{group.lines.length} 句 · {group.lines.reduce((total, item) => total + String(item.line.text ?? "").length, 0)} 字</small></div>
            <div className="script-segment-actions">
              <button className="icon-command" type="button" title={locked ? `解锁章节 ${groupIndex + 1}` : `锁定章节 ${groupIndex + 1}`} aria-label={locked ? `解锁章节 ${groupIndex + 1}` : `锁定章节 ${groupIndex + 1}`} disabled={readOnly || saving || Boolean(regeneratingSegmentId)} onClick={() => toggleSegmentLock(group.id)}>{locked ? <LockKeyhole size={15} aria-hidden="true" /> : <LockOpen size={15} aria-hidden="true" />}</button>
              {onRegenerateSegment ? <button className="secondary-command script-segment-regenerate" type="button" aria-label={`重新生成章节 ${groupIndex + 1}`} disabled={readOnly || locked || dirty || saving || Boolean(regeneratingSegmentId)} onClick={() => onRegenerateSegment(group.id)}>{regenerating ? <LoaderCircle className="is-spinning" size={14} aria-hidden="true" /> : <RotateCw size={14} aria-hidden="true" />}{regenerating ? "生成中" : "重生成"}</button> : null}
            </div>
          </header>
          <ol className="script-line-list">
            {group.lines.map(({ line, index }) => <li key={`${group.id}-${index}`}>
              <span className="script-line-number">{String(index + 1).padStart(2, "0")}</span>
              <label className="script-speaker-field"><span>角色</span><input aria-label={`第 ${index + 1} 句角色`} value={String(line.speaker ?? "")} disabled={readOnly} onChange={(event) => updateLine(index, "speaker", event.target.value)} /></label>
              <label className="script-copy-field"><span>台词</span><textarea aria-label={`第 ${index + 1} 句台词`} value={String(line.text ?? "")} disabled={readOnly} rows={2} onChange={(event) => updateLine(index, "text", event.target.value)} /></label>
              <IconDelete label={`删除第 ${index + 1} 句`} disabled={readOnly || lines.length <= 1} onClick={() => removeLine(index)} className="script-remove-line" />
            </li>)}
          </ol>
        </section>;
      })}
    </div> : <EmptyEditor title="还没有可编辑的台词" copy="可以先运行脚本节点，也可以手动加入第一句。" />}
    {!readOnly ? <EditorFooter addLabel="添加一句" onAdd={addLine} saveLabel="保存逐字稿" saving={saving} saveDisabled={!dirty || !valid} onSave={() => onSave({ ...script, status: "draft", lockedSegmentIds, estimatedCharacters: characters, estimatedMinutes: Math.round((characters / 220) * 10) / 10 })} /> : null}
  </div>;
}

export function CastPlanEditor({ value, saving, onSave, onDirtyChange, readOnly }: EditorProps) {
  const persisted = JSON.stringify(asRecord(value));
  const [plan, setPlan] = useState<Record<string, unknown>>(() => structuredClone(asRecord(value)));
  useEffect(() => setPlan(structuredClone(asRecord(value))), [persisted]);
  const roles = asArray(plan.roles).map(asRecord);
  const dirty = JSON.stringify(plan) !== persisted;
  const valid = roles.length > 0 && roles.length <= 4 && roles.every((role) => text(role.name) && text(role.responsibility));
  useDirtySignal(dirty, onDirtyChange);

  function updateRole(index: number, key: string, nextValue: string) {
    setPlan((current) => ({ ...current, status: "draft", roles: asArray(current.roles).map((role, roleIndex) => roleIndex === index ? { ...asRecord(role), [key]: nextValue } : role) }));
  }

  function addRole() {
    setPlan((current) => {
      const currentRoles = asArray(current.roles).map(asRecord);
      if (currentRoles.length >= 4) return current;
      const id = nextId("role", currentRoles.map((role) => String(role.id ?? "")));
      return { ...current, status: "draft", roles: [...currentRoles, { id, name: "新角色", responsibility: "说明这个角色为听众解决什么问题", speakingStyle: "自然、清楚", mustAsk: "本期必须追问的问题", voiceBrief: "与认知功能匹配的声音方向" }] };
    });
  }

  function removeRole(index: number) {
    setPlan((current) => ({ ...current, status: "draft", roles: asArray(current.roles).filter((_role, roleIndex) => roleIndex !== index) }));
  }

  return <div className="cast-plan-editor managed-plan-editor">
    <header>
      <span><UsersRound size={16} aria-hidden="true" />本期角色</span>
      <label><span>连续性</span><select aria-label="角色连续性" value={String(plan.policy ?? "dynamic")} disabled={readOnly} onChange={(event) => setPlan((current) => ({ ...current, status: "draft", policy: event.target.value }))}><option value="dynamic">按选题动态编排</option><option value="recurring_with_guests">常驻角色 + 本期角色</option><option value="fixed">沿用系列固定角色</option></select></label>
    </header>
    {roles.length > 0 ? <ol className="managed-plan-list cast-role-editor-list">
      {roles.map((role, index) => <li key={String(role.id ?? index)}>
        <span className="managed-plan-number">{String(index + 1).padStart(2, "0")}</span>
        <div className="managed-plan-fields">
          <label><span>角色名</span><input aria-label={`第 ${index + 1} 个角色名`} value={String(role.name ?? "")} disabled={readOnly} onChange={(event) => updateRole(index, "name", event.target.value)} /></label>
          <label className="wide-field"><span>认知职责</span><input aria-label={`第 ${index + 1} 个角色职责`} value={String(role.responsibility ?? "")} disabled={readOnly} onChange={(event) => updateRole(index, "responsibility", event.target.value)} /></label>
          <details className="managed-plan-details"><summary>表演方向与必问问题</summary><div><label><span>说话方式</span><input aria-label={`第 ${index + 1} 个角色说话方式`} value={String(role.speakingStyle ?? "")} disabled={readOnly} onChange={(event) => updateRole(index, "speakingStyle", event.target.value)} /></label><label><span>必须追问</span><input aria-label={`第 ${index + 1} 个角色必须追问`} value={String(role.mustAsk ?? "")} disabled={readOnly} onChange={(event) => updateRole(index, "mustAsk", event.target.value)} /></label><label><span>声音方向</span><input aria-label={`第 ${index + 1} 个角色声音方向`} value={String(role.voiceBrief ?? "")} disabled={readOnly} onChange={(event) => updateRole(index, "voiceBrief", event.target.value)} /></label></div></details>
        </div>
        <IconDelete label={`删除第 ${index + 1} 个角色`} disabled={readOnly || roles.length <= 1} onClick={() => removeRole(index)} />
      </li>)}
    </ol> : <EmptyEditor title="还没有本期角色" copy="角色由本期问题决定，不默认双人主持。" />}
    {!readOnly ? <EditorFooter addLabel="添加角色" addDisabled={roles.length >= 4} onAdd={addRole} saveLabel="保存角色方案" saving={saving} saveDisabled={!dirty || !valid} onSave={() => onSave({ ...plan, status: "draft", roles })} /> : null}
  </div>;
}

export function EpisodeBlueprintEditor({ value, saving, onSave, onDirtyChange, readOnly }: EditorProps) {
  const persisted = JSON.stringify(asRecord(value));
  const [blueprint, setBlueprint] = useState<Record<string, unknown>>(() => structuredClone(asRecord(value)));
  useEffect(() => setBlueprint(structuredClone(asRecord(value))), [persisted]);
  const segments = asArray(blueprint.segments).map(asRecord);
  const dirty = JSON.stringify(blueprint) !== persisted;
  const totalMinutes = Math.round(segments.reduce((total, segment) => total + number(segment.minutes), 0) * 10) / 10;
  const targetMinutes = number(blueprint.targetMinutes) || totalMinutes;
  const maximumChapters = Math.max(3, Math.ceil(targetMinutes / 10));
  const chapterIssues = podcastChapterPlanIssues(segments.map((segment) => ({ title: text(segment.title), minutes: number(segment.minutes) })), targetMinutes);
  const valid = chapterIssues.length === 0 && segments.every((segment) => text(segment.title) && text(segment.purpose));
  useDirtySignal(dirty, onDirtyChange);

  function updateSegment(index: number, key: string, nextValue: string | number) {
    setBlueprint((current) => ({ ...current, status: "draft", segments: asArray(current.segments).map((segment, segmentIndex) => segmentIndex === index ? { ...asRecord(segment), [key]: nextValue } : segment) }));
  }

  function addSegment() {
    setBlueprint((current) => {
      const currentSegments = asArray(current.segments).map(asRecord);
      if (currentSegments.length >= maximumChapters) return current;
      const id = nextId("segment", currentSegments.map((segment) => String(segment.id ?? "")));
      return { ...current, status: "draft", segments: [...currentSegments, { id, title: "新章节", minutes: 5, purpose: "说明这一章如何推进核心问题", claimIds: [], tension: "本章需要展开的分歧", handoff: "自然承接下一章" }] };
    });
  }

  function removeSegment(index: number) {
    setBlueprint((current) => ({ ...current, status: "draft", segments: asArray(current.segments).filter((_segment, segmentIndex) => segmentIndex !== index) }));
  }

  return <div className="episode-blueprint-editor managed-plan-editor">
    <header><span><LayoutList size={16} aria-hidden="true" />节目章节</span><strong>{segments.length} 章 · {totalMinutes} / {targetMinutes} 分钟</strong></header>
    {segments.length > 0 ? <ol className="managed-plan-list blueprint-segment-list">
      {segments.map((segment, index) => <li key={String(segment.id ?? index)}>
        <span className="managed-plan-number">{String(index + 1).padStart(2, "0")}</span>
        <div className="managed-plan-fields">
          <label className="wide-field"><span>章节标题</span><input aria-label={`第 ${index + 1} 章标题`} maxLength={45} value={String(segment.title ?? "")} disabled={readOnly} onChange={(event) => updateSegment(index, "title", event.target.value)} /></label>
          <label><span>分钟</span><input aria-label={`第 ${index + 1} 章时长`} type="number" min="2" max="60" step="0.5" value={number(segment.minutes) || ""} disabled={readOnly} onChange={(event) => updateSegment(index, "minutes", Number(event.target.value))} /></label>
          <label className="full-field"><span>本章目的</span><textarea aria-label={`第 ${index + 1} 章目的`} rows={2} value={String(segment.purpose ?? "")} disabled={readOnly} onChange={(event) => updateSegment(index, "purpose", event.target.value)} /></label>
          <details className="managed-plan-details"><summary>分歧与章节承接</summary><div><label><span>核心张力</span><input aria-label={`第 ${index + 1} 章核心张力`} value={String(segment.tension ?? "")} disabled={readOnly} onChange={(event) => updateSegment(index, "tension", event.target.value)} /></label><label><span>下一章承接</span><input aria-label={`第 ${index + 1} 章承接`} value={String(segment.handoff ?? "")} disabled={readOnly} onChange={(event) => updateSegment(index, "handoff", event.target.value)} /></label></div></details>
        </div>
        <IconDelete label={`删除第 ${index + 1} 章`} disabled={readOnly || segments.length <= 3} onClick={() => removeSegment(index)} />
      </li>)}
    </ol> : <EmptyEditor title="还没有节目章节" copy="先运行节目蓝图，或手动加入第一章。" />}
    {!readOnly ? <EditorFooter addLabel="添加章节" addDisabled={segments.length >= maximumChapters} onAdd={addSegment} saveLabel="保存节目蓝图" saving={saving} saveDisabled={!dirty || !valid} onSave={() => onSave({ ...blueprint, status: "draft", targetMinutes, segments })} /> : null}
  </div>;
}

export function ReleaseCopyEditor({ value, saving, onSave, onDirtyChange, readOnly }: EditorProps) {
  const persisted = JSON.stringify(asRecord(value));
  const [copy, setCopy] = useState<Record<string, unknown>>(() => structuredClone(asRecord(value)));
  const [keywordInput, setKeywordInput] = useState(() => asArray(asRecord(value).keywords).filter((item): item is string => typeof item === "string").join("，"));
  useEffect(() => {
    const next = structuredClone(asRecord(value));
    setCopy(next);
    setKeywordInput(asArray(next.keywords).filter((item): item is string => typeof item === "string").join("，"));
  }, [persisted]);
  const showNotes = asArray(copy.showNotes).filter((item): item is string => typeof item === "string");
  const keywords = keywordInput.split(/[，,]/).map((item) => item.trim()).filter(Boolean);
  const dirty = JSON.stringify({ ...copy, keywords }) !== persisted;
  const valid = text(copy.episodeTitle).length <= 120 && Boolean(text(copy.episodeTitle) && text(copy.summary))
    && showNotes.every((note) => note.trim().length > 0)
    && keywords.every((keyword) => keyword.trim().length > 0 && keyword.trim().length <= 40);
  useDirtySignal(dirty, onDirtyChange);

  function update(key: string, nextValue: unknown) {
    setCopy((current) => ({ ...current, status: "ready", [key]: nextValue }));
  }

  return <div className="release-copy-editor managed-plan-editor">
    <header><span><FileText size={16} aria-hidden="true" />发行文案</span><strong>{showNotes.length} 条 Show Notes</strong></header>
    <div className="release-copy-fields">
      <label><span>单集标题</span><input aria-label="发行单集标题" maxLength={120} value={String(copy.episodeTitle ?? "")} disabled={readOnly} onChange={(event) => update("episodeTitle", event.target.value)} /></label>
      <label><span>单集摘要</span><textarea aria-label="发行单集摘要" rows={5} maxLength={2_000} value={String(copy.summary ?? "")} disabled={readOnly} onChange={(event) => update("summary", event.target.value)} /></label>
      <label><span>Show Notes</span><textarea aria-label="发行 Show Notes" rows={Math.max(4, Math.min(10, showNotes.length + 2))} value={showNotes.join("\n")} disabled={readOnly} onChange={(event) => update("showNotes", event.target.value.split("\n"))} /></label>
      <label><span>关键词</span><input aria-label="发行关键词" value={keywordInput} disabled={readOnly} onChange={(event) => setKeywordInput(event.target.value)} /></label>
    </div>
    {!readOnly ? <footer><span /> <button className="primary-command" type="button" disabled={!dirty || !valid || saving} onClick={() => onSave({ ...copy, status: "ready", showNotes, keywords })}><Save size={15} aria-hidden="true" />{saving ? "保存中" : "保存发行文案"}</button></footer> : null}
  </div>;
}

function EditorFooter({ addLabel, addDisabled = false, onAdd, saveLabel, saving, saveDisabled, onSave }: { addLabel: string; addDisabled?: boolean; onAdd: () => void; saveLabel: string; saving: boolean; saveDisabled: boolean; onSave: () => void }) {
  return <footer><button className="secondary-command" type="button" disabled={addDisabled} onClick={onAdd}><Plus size={15} aria-hidden="true" />{addLabel}</button><button className="primary-command" type="button" disabled={saveDisabled || saving} onClick={onSave}><Save size={15} aria-hidden="true" />{saving ? "保存中" : saveLabel}</button></footer>;
}

function IconDelete({ label, disabled, onClick, className = "" }: { label: string; disabled: boolean; onClick: () => void; className?: string }) {
  return <button className={`icon-command managed-plan-delete ${className}`.trim()} type="button" title={label} aria-label={label} disabled={disabled} onClick={onClick}><Trash2 size={15} aria-hidden="true" /></button>;
}

function EmptyEditor({ title, copy }: { title: string; copy: string }) {
  return <div className="script-empty-state"><strong>{title}</strong><span>{copy}</span></div>;
}

function researchSourceKindLabel(value: typeof RESEARCH_SOURCE_KINDS[number]): string {
  return { scholarly: "论文", primary: "一手材料", book: "图书", web: "Web" }[value];
}

function useDirtySignal(dirty: boolean, onDirtyChange: (dirty: boolean) => void) {
  useEffect(() => {
    onDirtyChange(dirty);
    return () => onDirtyChange(false);
  }, [dirty, onDirtyChange]);
}

function nextId(prefix: string, existing: string[]): string {
  for (let index = 1; index <= 99; index += 1) {
    const id = `${prefix}-${index}`;
    if (!existing.includes(id)) return id;
  }
  return `${prefix}-${Date.now()}`;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function number(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
