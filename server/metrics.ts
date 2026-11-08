// Prometheus text exposition, written by hand: a few lines, no client library needed.
const requests = new Map<string, number>();

export function countRequest(method: string, route: string, status: number) {
  const key = `method="${method}",route="${route}",status="${status}"`;
  requests.set(key, (requests.get(key) ?? 0) + 1);
}

export interface Gauges {
  /** Articles by state: draft, review, published. */
  articles: Record<string, number>;
  /** 1 when the settings file on disk could not be applied and an older version is in use. */
  fileError: boolean;
}

export function renderMetrics(version: string, g: Gauges): string {
  const lines = [
    "# HELP openasy_build_info Build information.",
    "# TYPE openasy_build_info gauge",
    `openasy_build_info{product="knowledge-base",version="${version}"} 1`,
    "# HELP openasy_http_requests_total HTTP requests handled.",
    "# TYPE openasy_http_requests_total counter",
    ...[...requests].map(([labels, n]) => `openasy_http_requests_total{${labels}} ${n}`),
    "# HELP openasy_knowledge_base_articles Articles, by state.",
    "# TYPE openasy_knowledge_base_articles gauge",
    ...["draft", "review", "published"].map((s) => `openasy_knowledge_base_articles{state="${s}"} ${g.articles[s] ?? 0}`),
    "# HELP openasy_knowledge_base_config_error 1 when the settings file could not be applied and its last good version is in use.",
    "# TYPE openasy_knowledge_base_config_error gauge",
    `openasy_knowledge_base_config_error ${g.fileError ? 1 : 0}`,
    "# HELP process_uptime_seconds Seconds since the process started.",
    "# TYPE process_uptime_seconds gauge",
    `process_uptime_seconds ${process.uptime().toFixed(0)}`,
  ];
  return lines.join("\n") + "\n";
}
