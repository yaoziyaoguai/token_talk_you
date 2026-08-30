export interface PodcastChapterPlanItem {
  title: string;
  minutes: number;
}

export function podcastChapterPlanIssues(
  chapters: PodcastChapterPlanItem[],
  targetMinutes: number,
): string[] {
  const issues: string[] = [];
  if (chapters.length < 3) issues.push("节目蓝图至少需要 3 个章节");
  const maximumChapters = Math.max(3, Math.ceil(targetMinutes / 10));
  if (chapters.length > maximumChapters) issues.push(`目标 ${targetMinutes} 分钟最多安排 ${maximumChapters} 个章节，避免切分过密`);
  if (chapters.some((chapter) => chapter.minutes < 2)) issues.push("每个章节至少需要 2 分钟");
  if (chapters.some((chapter) => chapter.title.trim().length > 45)) issues.push("章节标题不能超过 45 个字符");
  const plannedMinutes = chapters.reduce((total, chapter) => total + chapter.minutes, 0);
  if (plannedMinutes < targetMinutes * 0.9 || plannedMinutes > targetMinutes * 1.1) {
    issues.push(`蓝图时长 ${plannedMinutes} 分钟偏离目标 ${targetMinutes} 分钟`);
  }
  return issues;
}
