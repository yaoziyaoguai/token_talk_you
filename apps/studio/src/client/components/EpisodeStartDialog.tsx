import type { EpisodeOpportunity } from "@token-talk/domain";
import type { StartEpisodeInput, StudioBootstrap } from "../../shared/api.js";
import { Check, Music2, ShieldCheck, Users, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

interface EpisodeStartDialogProps {
  data: StudioBootstrap;
  opportunity: EpisodeOpportunity;
  pending: boolean;
  error: string | undefined;
  onClose: () => void;
  onStart: (input: StartEpisodeInput) => Promise<void>;
}

const musicLabels = { minimal: "克制留白", narrative: "叙事配乐", immersive: "沉浸声景" } as const;
const budgetLabels = { local: "本地试制", economy: "经济日更", balanced: "效果均衡", premium: "精品上限" } as const;

export function EpisodeStartDialog({ data, opportunity, pending, error, onClose, onStart }: EpisodeStartDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose);
  const pendingRef = useRef(pending);
  onCloseRef.current = onClose;
  pendingRef.current = pending;
  const compatibleRecipes = useMemo(
    () => data.recipes.filter((recipe) => isRecipeCompatible(recipe.capabilityIds, opportunity)),
    [data.recipes, opportunity],
  );
  const recommendedRecipeId = opportunity.verdict === "rapid_brief" ? "rapid-topic-v1" : "deep-reading-v1";
  const initialRecipe = compatibleRecipes.find((recipe) => recipe.id === recommendedRecipeId) ?? compatibleRecipes[0];
  const [title, setTitle] = useState(opportunity.title);
  const [hook, setHook] = useState(opportunity.candidate.hook);
  const [centralQuestion, setCentralQuestion] = useState(opportunity.candidate.editorial?.centralQuestion ?? opportunity.candidate.hook);
  const [listenerPromise, setListenerPromise] = useState(opportunity.candidate.editorial?.listenerPromise ?? opportunity.candidate.hook);
  const [recipeId, setRecipeId] = useState(initialRecipe?.id ?? "");
  const [targetMinutes, setTargetMinutes] = useState<number | "">(Math.round((opportunity.candidate.targetMinutes.min + opportunity.candidate.targetMinutes.max) / 2));
  const [musicPolicy, setMusicPolicy] = useState<StartEpisodeInput["musicPolicy"]>(initialRecipe?.musicPolicy ?? "minimal");
  const [maxCostCny, setMaxCostCny] = useState<number | "">(initialRecipe?.estimatedCostCny?.max ?? 5);
  const recipe = useMemo(() => data.recipes.find((item) => item.id === recipeId), [data.recipes, recipeId]);

  useEffect(() => {
    if (!recipe) return;
    setMusicPolicy(recipe.musicPolicy);
    setMaxCostCny(recipe.estimatedCostCny?.max ?? 5);
    setTargetMinutes(Math.round((recipe.targetMinutes.min + recipe.targetMinutes.max) / 2));
  }, [recipe]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    const supportsModal = typeof dialog.showModal === "function";
    if (supportsModal && !dialog.open) dialog.showModal();
    else dialog.setAttribute("open", "");
    closeButtonRef.current?.focus();

    const cancel = (event: Event) => {
      event.preventDefault();
      if (pendingRef.current) return;
      onCloseRef.current();
    };
    const fallbackEscape = (event: KeyboardEvent) => {
      if (!supportsModal && event.key === "Escape") cancel(event);
    };
    dialog.addEventListener("cancel", cancel);
    window.addEventListener("keydown", fallbackEscape);
    return () => {
      dialog.removeEventListener("cancel", cancel);
      window.removeEventListener("keydown", fallbackEscape);
      if (dialog.open && typeof dialog.close === "function") dialog.close();
      else dialog.removeAttribute("open");
      previouslyFocused?.focus();
    };
  }, []);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!recipe || targetMinutes === "" || maxCostCny === "") return;
    await onStart({
      title,
      hook,
      centralQuestion,
      listenerPromise,
      recipeId: recipe.id,
      targetMinutes,
      musicPolicy,
      budgetPolicy: recipe.budgetPolicy,
      maxCostCny,
    });
  }

  return (
    <dialog ref={dialogRef} className="dialog-backdrop" aria-labelledby="start-dialog-title">
      <section className="start-dialog">
        <header><div><p className="eyebrow">已采用选题</p><h2 id="start-dialog-title">{opportunity.verdict === "research_first" ? "确认资料研究怎么做" : "确认本集怎么做"}</h2></div><button ref={closeButtonRef} className="icon-command" type="button" aria-label="关闭" disabled={pending} onClick={onClose}><X size={18} /></button></header>
        <form onSubmit={(event) => void submit(event)}>
          <label className="wide-field"><span>节目标题</span><input required value={title} onChange={(event) => setTitle(event.target.value)} /></label>
          <label className="wide-field"><span>本集核心命题</span><textarea required value={centralQuestion} onChange={(event) => setCentralQuestion(event.target.value)} /></label>
          <label className="wide-field"><span>听众承诺</span><textarea required value={listenerPromise} onChange={(event) => setListenerPromise(event.target.value)} /></label>
          <label className="wide-field"><span>开场承诺</span><textarea required value={hook} onChange={(event) => setHook(event.target.value)} /></label>
          <fieldset className="recipe-choice"><legend>节目类型</legend>{data.recipes.map((item) => {
            const compatible = isRecipeCompatible(item.capabilityIds, opportunity);
            return <label className={`${recipeId === item.id ? "active" : ""}${compatible ? "" : " is-disabled"}`} key={item.id}><input type="radio" name="recipe" value={item.id} checked={recipeId === item.id} disabled={!compatible} onChange={() => setRecipeId(item.id)} /><span><strong>{item.label}</strong><small>{compatible ? item.description : "本题需要先建立事实账本，不能跳过资料核验。"}</small><em>{item.targetMinutes.min}–{item.targetMinutes.max} 分钟 · 预计 ¥{item.estimatedCostCny?.min ?? 0}–{item.estimatedCostCny?.max ?? 0}</em></span>{recipeId === item.id ? <Check size={16} /> : null}</label>;
          })}</fieldset>
          <div className="intent-grid">
            <label><span>目标时长</span><input required type="number" min="15" max="240" value={targetMinutes} onChange={(event) => setTargetMinutes(event.currentTarget.value === "" ? "" : event.currentTarget.valueAsNumber)} /></label>
            <label><span>音乐策略</span><select value={musicPolicy} onChange={(event) => setMusicPolicy(event.target.value as StartEpisodeInput["musicPolicy"])}><option value="minimal">克制留白</option><option value="narrative">叙事配乐</option><option value="immersive">沉浸声景</option></select></label>
            <label><span>现金上限</span><input required type="number" min="0" step="0.5" value={maxCostCny} onChange={(event) => setMaxCostCny(event.currentTarget.value === "" ? "" : event.currentTarget.valueAsNumber)} /></label>
          </div>
          <div className="intent-summary">
            <div><Users size={17} /><span><strong>动态角色</strong><small>{opportunity.candidate.suggestedRoles.join(" / ")}</small></span></div>
            <div><Music2 size={17} /><span><strong>{musicLabels[musicPolicy]}</strong><small>每个 Cue 均保留“不使用音乐”的候选</small></span></div>
            <div><ShieldCheck size={17} /><span><strong>自动成片审计</strong><small>发行前核对母带、逐字稿、校验值与权利记录</small></span></div>
          </div>
          {error ? <p className="dialog-error" role="alert">{error}</p> : null}
          <footer><span>{recipe ? `${budgetLabels[recipe.budgetPolicy]} · 上限 ${maxCostCny === "" ? "待填写" : `¥${maxCostCny.toFixed(2)}`}` : "请选择节目类型"}</span><div><button className="secondary-command" type="button" disabled={pending} onClick={onClose}>稍后再做</button><button className="primary-command" type="submit" disabled={pending || !recipe || targetMinutes === "" || maxCostCny === ""}>{pending ? "正在建立工作流…" : opportunity.verdict === "research_first" ? "启动资料研究" : "启动节目制作"}</button></div></footer>
        </form>
      </section>
    </dialog>
  );
}

function isRecipeCompatible(capabilityIds: string[], opportunity: EpisodeOpportunity): boolean {
  const needsFactLedger = opportunity.candidate.origin === "trend"
    && (opportunity.candidate.verification.status !== "ready" || opportunity.candidate.verification.independentSources < 2);
  return !needsFactLedger || capabilityIds.includes("research.claims");
}
