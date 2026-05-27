/**
 * GitLabProvider — implements GitOpsProvider over GitLab REST v4.
 *
 * Storage namespace: `gitops-gitlab`
 *   - `pat:default` → encrypted token + meta (host)
 */

import type { HostServices } from "@vibecontrols/plugin-sdk/contract";
import { BoundLogger } from "@vibecontrols/plugin-sdk";

import {
  GitOpsError,
  type AuthInput,
  type AuthValidation,
  type Branch,
  type Contributor,
  type Environment,
  type GitOpsProvider,
  type HealthSnapshot,
  type IssueSummary,
  type NormalisedRepo,
  type OrgRollup,
  type Pipeline,
  type PipelineAnalytics,
  type PipelineRun,
  type PullRequest,
  type PullRequestAnalytics,
  type RepoPage,
  type SecurityAlert,
  type Webhook,
} from "./types.js";

const STORAGE_NS = "gitops-gitlab";
const KEY_PAT = "pat:default";
const DEFAULT_HOST = "https://gitlab.com";

interface StoredAuth {
  kind: "pat" | "oauth" | "app";
  token: string;
  meta?: Record<string, string>;
  savedAt: string;
}

interface CacheEntry<T> {
  ts: number;
  ttlMs: number;
  value: T;
}

interface GlProject {
  id: number;
  path_with_namespace: string;
  visibility: string;
  default_branch?: string;
  description?: string | null;
  archived: boolean;
  forks_count?: number;
  star_count?: number;
  http_url_to_repo: string;
  web_url: string;
  created_at: string;
  last_activity_at?: string;
  topics?: string[];
}

interface GlMr {
  id: number;
  iid: number;
  title: string;
  state: string;
  draft?: boolean;
  author?: { username: string };
  reviewers?: Array<{ username: string }>;
  created_at: string;
  updated_at: string;
  merged_at?: string | null;
  web_url: string;
  labels?: string[];
  merge_status?: string;
}

interface GlPipeline {
  id: number;
  ref: string;
  status: string;
  source?: string;
  created_at: string;
  updated_at: string;
  started_at?: string;
  finished_at?: string;
  duration?: number;
  web_url: string;
  user?: { username: string };
  sha: string;
}

export class GitLabProvider implements GitOpsProvider {
  readonly name = "gitlab" as const;
  private readonly host: HostServices;
  private readonly log: BoundLogger;
  private token: string | null = null;
  private apiBase = `${DEFAULT_HOST}/api/v4`;
  private readonly cache = new Map<string, CacheEntry<unknown>>();
  private rateLimit: { remaining: number; resetAt: string } | null = null;

  constructor(host: HostServices) {
    this.host = host;
    this.log = new BoundLogger(host.logger, "gitops-gitlab");
  }

  async init(): Promise<void> {
    const stored = await this.loadAuth();
    if (stored) {
      this.token = stored.token;
      this.apiBase = `${stored.meta?.["host"] ?? DEFAULT_HOST}/api/v4`;
      this.log.info("Loaded persisted GitLab PAT");
    }
  }

  private async loadAuth(): Promise<StoredAuth | null> {
    const raw = await this.host.storage?.get<string>(STORAGE_NS, KEY_PAT);
    if (!raw) return null;
    try {
      return typeof raw === "string"
        ? (JSON.parse(raw) as StoredAuth)
        : (raw as StoredAuth);
    } catch {
      return null;
    }
  }

  private headers(): Headers {
    const h = new Headers({
      "User-Agent": "vibecontrols-gitops-gitlab/0.1",
      Accept: "application/json",
    });
    if (this.token) h.set("PRIVATE-TOKEN", this.token);
    return h;
  }

  private mapStatus(status: number, body: string): GitOpsError {
    if (status === 401) return new GitOpsError("AUTH", "GitLab: unauthorized");
    if (status === 403)
      return new GitOpsError("FORBIDDEN", "GitLab: forbidden");
    if (status === 404)
      return new GitOpsError("NOT_FOUND", "GitLab: not found");
    if (status === 429)
      return new GitOpsError("RATE_LIMITED", "GitLab: rate-limited");
    return new GitOpsError(
      "UPSTREAM",
      "GitLab: " + status + " " + body.slice(0, 200),
    );
  }

  private async rest<T>(
    path: string,
    init?: { method?: string; body?: unknown },
  ): Promise<{ data: T; headers: Headers }> {
    const url = path.startsWith("http") ? path : `${this.apiBase}${path}`;
    const res = await fetch(url, {
      method: init?.method ?? "GET",
      headers: this.headers(),
      body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
    });
    const remaining = res.headers.get("ratelimit-remaining");
    const reset = res.headers.get("ratelimit-reset");
    if (remaining && reset) {
      this.rateLimit = {
        remaining: parseInt(remaining, 10),
        resetAt: new Date(parseInt(reset, 10) * 1000).toISOString(),
      };
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw this.mapStatus(res.status, text);
    }
    const data = (await res.json()) as T;
    return { data, headers: res.headers };
  }

  private cached<T>(
    key: string,
    ttlMs: number,
    fn: () => Promise<T>,
  ): Promise<T> {
    const entry = this.cache.get(key) as CacheEntry<T> | undefined;
    if (entry && Date.now() - entry.ts < entry.ttlMs)
      return Promise.resolve(entry.value);
    return fn().then((value) => {
      this.cache.set(key, { ts: Date.now(), ttlMs, value });
      return value;
    });
  }

  private projectId(fqn: string): string {
    // GitLab accepts URL-encoded path-with-namespace as project ID.
    return encodeURIComponent(fqn);
  }

  private mapRepo(p: GlProject): NormalisedRepo {
    return {
      fqn: p.path_with_namespace,
      provider: "gitlab",
      visibility:
        p.visibility === "internal"
          ? "internal"
          : p.visibility === "private"
            ? "private"
            : "public",
      defaultBranch: p.default_branch ?? "main",
      description: p.description ?? undefined,
      topics: p.topics ?? [],
      isArchived: p.archived,
      isFork: false,
      stars: p.star_count,
      forks: p.forks_count,
      url: p.web_url,
      createdAt: p.created_at,
      updatedAt: p.last_activity_at ?? p.created_at,
      pushedAt: p.last_activity_at,
    };
  }

  private mapMr(m: GlMr): PullRequest {
    const merged = m.state === "merged";
    return {
      id: String(m.id),
      number: m.iid,
      title: m.title,
      state: merged ? "merged" : (m.state as "open" | "closed"),
      isDraft: !!m.draft,
      author: m.author?.username ?? "unknown",
      reviewers: (m.reviewers ?? []).map((r) => r.username),
      createdAt: m.created_at,
      updatedAt: m.updated_at,
      mergedAt: m.merged_at ?? undefined,
      durationOpenSeconds: m.merged_at
        ? Math.floor(
            (Date.parse(m.merged_at) - Date.parse(m.created_at)) / 1000,
          )
        : undefined,
      url: m.web_url,
      labels: m.labels ?? [],
    };
  }

  private mapPipeline(p: GlPipeline): PipelineRun {
    return {
      id: String(p.id),
      pipelineName: p.source ?? "pipeline",
      branch: p.ref,
      status:
        p.status === "running"
          ? "running"
          : p.status === "pending" || p.status === "created"
            ? "queued"
            : p.status === "manual"
              ? "waiting"
              : "completed",
      conclusion:
        p.status === "success"
          ? "success"
          : p.status === "failed"
            ? "failure"
            : p.status === "canceled"
              ? "cancelled"
              : p.status === "skipped"
                ? "skipped"
                : undefined,
      startedAt: p.started_at,
      completedAt: p.finished_at,
      durationSeconds: p.duration,
      url: p.web_url,
      actor: p.user?.username ?? "unknown",
      commitSha: p.sha,
    };
  }

  // ── auth lifecycle ─────────────────────────────────────────────────

  async saveCredentials(input: AuthInput): Promise<void> {
    const env: StoredAuth = {
      kind: input.kind,
      token: input.token,
      meta: input.meta,
      savedAt: new Date().toISOString(),
    };
    await this.host.storage?.set(STORAGE_NS, KEY_PAT, JSON.stringify(env));
    this.token = input.token;
    this.apiBase = `${input.meta?.["host"] ?? DEFAULT_HOST}/api/v4`;
    this.cache.clear();
  }

  async validateCredentials(): Promise<AuthValidation> {
    if (!this.token) {
      const stored = await this.loadAuth();
      if (!stored) return { ok: false, message: "No PAT stored" };
      this.token = stored.token;
      this.apiBase = `${stored.meta?.["host"] ?? DEFAULT_HOST}/api/v4`;
    }
    try {
      const { data } = await this.rest<{ username: string }>("/user");
      return { ok: true, account: data.username, scopes: ["api"] };
    } catch (err) {
      return {
        ok: false,
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async rotateCredentials(input: AuthInput): Promise<AuthValidation> {
    await this.saveCredentials(input);
    return this.validateCredentials();
  }

  async revokeCredentials(): Promise<void> {
    await this.host.storage?.delete(STORAGE_NS, KEY_PAT);
    this.token = null;
    this.cache.clear();
  }

  async healthCheck(): Promise<HealthSnapshot> {
    try {
      await this.rest<{ version: string }>("/version");
      return {
        ok: true,
        rateLimit: this.rateLimit ?? undefined,
      };
    } catch (err) {
      return {
        ok: false,
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }

  // ── repos ──────────────────────────────────────────────────────────

  async listRepos(opts: {
    org?: string;
    limit?: number;
    cursor?: string;
  }): Promise<RepoPage> {
    const limit = Math.max(1, Math.min(opts.limit ?? 30, 100));
    const path =
      opts.cursor ??
      (opts.org
        ? `/groups/${encodeURIComponent(opts.org)}/projects?per_page=${limit}&order_by=last_activity_at`
        : `/projects?membership=true&per_page=${limit}&order_by=last_activity_at`);
    const { data, headers } = await this.rest<GlProject[]>(path);
    const items = data.map((p) => this.mapRepo(p));
    const nextPage = headers.get("x-next-page");
    const baseUrl = path.startsWith("http") ? path : `${this.apiBase}${path}`;
    let nextCursor: string | undefined;
    if (nextPage) {
      const u = new URL(baseUrl);
      u.searchParams.set("page", nextPage);
      nextCursor = u.toString();
    }
    return { items, nextCursor };
  }

  async getRepo(fqn: string): Promise<NormalisedRepo> {
    return this.cached(`repo:${fqn}`, 60_000, async () => {
      const { data } = await this.rest<GlProject>(
        `/projects/${this.projectId(fqn)}`,
      );
      return this.mapRepo(data);
    });
  }

  async listBranches(fqn: string): Promise<Branch[]> {
    const { data } = await this.rest<
      Array<{ name: string; protected: boolean; commit: { id: string } }>
    >(`/projects/${this.projectId(fqn)}/repository/branches?per_page=100`);
    return data.map((b) => ({
      name: b.name,
      isProtected: b.protected,
      lastCommitSha: b.commit.id,
    }));
  }

  async listLanguages(fqn: string): Promise<Record<string, number>> {
    return this.cached(`langs:${fqn}`, 5 * 60_000, async () => {
      const { data } = await this.rest<Record<string, number>>(
        `/projects/${this.projectId(fqn)}/languages`,
      );
      return data;
    });
  }

  async listContributors(
    fqn: string,
    opts?: { limit?: number },
  ): Promise<Contributor[]> {
    const limit = Math.max(1, Math.min(opts?.limit ?? 20, 100));
    const { data } = await this.rest<
      Array<{ name: string; commits: number; email?: string }>
    >(
      `/projects/${this.projectId(fqn)}/repository/contributors?per_page=${limit}`,
    );
    return data.map((c) => ({ login: c.name, contributions: c.commits }));
  }

  // ── MRs ─────────────────────────────────────────────────────────────

  async listPullRequests(
    fqn: string,
    opts?: { state?: "open" | "closed" | "all"; limit?: number },
  ): Promise<PullRequest[]> {
    const stateMap: Record<string, string> = {
      open: "opened",
      closed: "closed",
      all: "all",
    };
    const state = stateMap[opts?.state ?? "open"] ?? "opened";
    const limit = Math.max(1, Math.min(opts?.limit ?? 30, 100));
    const { data } = await this.rest<GlMr[]>(
      `/projects/${this.projectId(fqn)}/merge_requests?state=${state}&per_page=${limit}&order_by=updated_at`,
    );
    return data.map((m) => this.mapMr(m));
  }

  async getPullRequest(fqn: string, id: number): Promise<PullRequest> {
    const { data } = await this.rest<GlMr>(
      `/projects/${this.projectId(fqn)}/merge_requests/${id}`,
    );
    return this.mapMr(data);
  }

  async pullRequestAnalytics(fqn: string): Promise<PullRequestAnalytics> {
    const open = await this.listPullRequests(fqn, {
      state: "open",
      limit: 100,
    });
    const merged = await this.listPullRequests(fqn, {
      state: "closed",
      limit: 100,
    });
    const onlyMerged = merged.filter((m) => m.state === "merged");
    const sorted = [...onlyMerged]
      .filter((m) => typeof m.durationOpenSeconds === "number")
      .sort(
        (a, b) => (a.durationOpenSeconds ?? 0) - (b.durationOpenSeconds ?? 0),
      );
    const median = sorted.length
      ? (sorted[Math.floor(sorted.length / 2)]?.durationOpenSeconds ?? 0) / 3600
      : 0;
    return {
      slowest: sorted.slice(-5).reverse(),
      fastest: sorted.slice(0, 5),
      medianAgeHours: Math.round(median * 10) / 10,
      awaitingReview: open,
      awaitingApproval: [],
    };
  }

  // ── issues ──────────────────────────────────────────────────────────

  async listIssues(
    fqn: string,
    opts?: { state?: "open" | "closed"; limit?: number },
  ): Promise<IssueSummary[]> {
    const state = opts?.state === "closed" ? "closed" : "opened";
    const limit = Math.max(1, Math.min(opts?.limit ?? 30, 100));
    const { data } = await this.rest<
      Array<{
        id: number;
        iid: number;
        title: string;
        state: string;
        labels: string[];
        web_url: string;
        created_at: string;
      }>
    >(
      `/projects/${this.projectId(fqn)}/issues?state=${state}&per_page=${limit}`,
    );
    return data.map((i) => ({
      id: String(i.id),
      number: i.iid,
      title: i.title,
      state: i.state,
      labels: i.labels,
      url: i.web_url,
      createdAt: i.created_at,
    }));
  }

  async labelStats(fqn: string): Promise<Record<string, number>> {
    const issues = await this.listIssues(fqn, { state: "open", limit: 100 });
    const out: Record<string, number> = {};
    for (const i of issues)
      for (const l of i.labels) out[l] = (out[l] ?? 0) + 1;
    return out;
  }

  // ── CI ──────────────────────────────────────────────────────────────

  async listPipelines(fqn: string): Promise<Pipeline[]> {
    // GitLab pipelines are not named workflows; use unique sources as "pipelines"
    const runs = await this.listRecentRuns(fqn, { limit: 50 });
    const sources = new Set(runs.map((r) => r.pipelineName));
    return [...sources].map((s) => ({
      id: s,
      name: s,
      state: "active" as const,
    }));
  }

  async listRecentRuns(
    fqn: string,
    opts?: { limit?: number; branch?: string },
  ): Promise<PipelineRun[]> {
    const limit = Math.max(1, Math.min(opts?.limit ?? 30, 100));
    const branchQs = opts?.branch
      ? `&ref=${encodeURIComponent(opts.branch)}`
      : "";
    const { data } = await this.rest<GlPipeline[]>(
      `/projects/${this.projectId(fqn)}/pipelines?per_page=${limit}${branchQs}`,
    );
    return data.map((p) => this.mapPipeline(p));
  }

  async getRun(fqn: string, runId: string): Promise<PipelineRun> {
    const { data } = await this.rest<GlPipeline>(
      `/projects/${this.projectId(fqn)}/pipelines/${runId}`,
    );
    const run = this.mapPipeline(data);
    try {
      const { data: jobs } = await this.rest<
        Array<{
          id: number;
          name: string;
          status: string;
          started_at?: string;
          finished_at?: string;
          duration?: number;
        }>
      >(`/projects/${this.projectId(fqn)}/pipelines/${runId}/jobs`);
      run.jobs = jobs.map((j) => ({
        id: String(j.id),
        name: j.name,
        status: j.status,
        conclusion:
          j.status === "success"
            ? "success"
            : j.status === "failed"
              ? "failure"
              : undefined,
        startedAt: j.started_at,
        completedAt: j.finished_at,
        durationSeconds: j.duration,
      }));
    } catch {
      // jobs optional
    }
    return run;
  }

  async pipelineAnalytics(fqn: string): Promise<PipelineAnalytics> {
    const runs = await this.listRecentRuns(fqn, { limit: 100 });
    const completed = runs.filter((r) => r.status === "completed");
    const succ = completed.filter((r) => r.conclusion === "success").length;
    const durations = completed
      .map((r) => r.durationSeconds ?? 0)
      .filter((d) => d > 0)
      .sort((a, b) => a - b);
    const pct = (p: number) =>
      durations.length === 0
        ? 0
        : (durations[
            Math.min(durations.length - 1, Math.floor(durations.length * p))
          ] ?? 0);
    return {
      successRate: completed.length ? succ / completed.length : 0,
      durationP50: pct(0.5),
      durationP95: pct(0.95),
      slowest: [...completed]
        .sort((a, b) => (b.durationSeconds ?? 0) - (a.durationSeconds ?? 0))
        .slice(0, 5),
      fastest: [...completed]
        .filter((r) => (r.durationSeconds ?? 0) > 0)
        .sort((a, b) => (a.durationSeconds ?? 0) - (b.durationSeconds ?? 0))
        .slice(0, 5),
      running: runs.filter((r) => r.status === "running"),
      queued: runs.filter((r) => r.status === "queued"),
      pendingApproval: runs.filter((r) => r.status === "waiting"),
      totalRunsLast30Days: runs.length,
    };
  }

  async listEnvironments(fqn: string): Promise<Environment[]> {
    try {
      const { data } = await this.rest<
        Array<{
          name: string;
          state: string;
          updated_at?: string;
          external_url?: string;
        }>
      >(`/projects/${this.projectId(fqn)}/environments`);
      return data.map((e) => ({
        name: e.name,
        state: e.state,
        lastDeployedAt: e.updated_at,
        url: e.external_url,
      }));
    } catch {
      return [];
    }
  }

  async listSecurityAlerts(
    fqn: string,
    _opts?: { kind?: SecurityAlert["type"] },
  ): Promise<SecurityAlert[]> {
    // GitLab vulnerability_findings is a premium feature; gracefully return [] otherwise.
    try {
      const { data } = await this.rest<
        Array<{
          id: number;
          name: string;
          severity: string;
          state: string;
          report_type?: string;
          identifiers?: Array<{ external_id?: string; type?: string }>;
          links?: Array<{ url: string }>;
          created_at: string;
        }>
      >(`/projects/${this.projectId(fqn)}/vulnerability_findings?per_page=50`);
      return data.map((v) => ({
        id: String(v.id),
        type:
          v.report_type === "secret_detection"
            ? "secret-scan"
            : v.report_type === "sast"
              ? "code-scan"
              : v.report_type === "dependency_scanning"
                ? "dependency"
                : "advisory",
        severity: (
          v.severity ?? "info"
        ).toLowerCase() as SecurityAlert["severity"],
        state:
          v.state === "resolved"
            ? "fixed"
            : v.state === "dismissed"
              ? "dismissed"
              : "open",
        title: v.name,
        url: v.links?.[0]?.url ?? "",
        cve: v.identifiers?.find((i) => i.type === "cve")?.external_id,
        createdAt: v.created_at,
      }));
    } catch {
      return [];
    }
  }

  async orgRollup(org: string): Promise<OrgRollup> {
    return this.cached(`rollup:${org}`, 5 * 60_000, async () => {
      const first = await this.listRepos({ org, limit: 100 });
      const items = [...first.items];
      let cursor = first.nextCursor;
      let pages = 1;
      while (cursor && pages < 5) {
        const next = await this.listRepos({ cursor });
        items.push(...next.items);
        cursor = next.nextCursor;
        pages++;
      }
      const byVis = { public: 0, private: 0, internal: 0 } as Record<
        "public" | "private" | "internal",
        number
      >;
      const byLang: Record<string, number> = {};
      let archived = 0;
      let stale30d = 0;
      const now = Date.now();
      for (const r of items) {
        byVis[r.visibility] += 1;
        if (r.isArchived) archived++;
        const pushed = Date.parse(r.pushedAt ?? r.updatedAt);
        if (now - pushed > 30 * 24 * 3600 * 1000) stale30d++;
      }
      return {
        totalRepos: items.length,
        byVisibility: byVis,
        byLanguage: byLang,
        archived,
        stale30d,
        totalOpenPRs: 0,
        totalOpenIssues: 0,
      };
    });
  }

  async listWebhooks(fqn: string): Promise<Webhook[]> {
    try {
      const { data } = await this.rest<
        Array<{
          id: number;
          url: string;
          enable_ssl_verification?: boolean;
          push_events?: boolean;
        }>
      >(`/projects/${this.projectId(fqn)}/hooks`);
      return data.map((h) => ({
        id: String(h.id),
        url: h.url,
        events: h.push_events ? ["push"] : [],
        active: true,
      }));
    } catch {
      return [];
    }
  }
}
