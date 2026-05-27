import { afterEach, describe, expect, test, mock } from "bun:test";

import { GitLabProvider } from "../src/provider.js";

function setupMockFetch(
  handler: (url: string) => {
    status?: number;
    body?: unknown;
    headers?: Record<string, string>;
  },
) {
  const original = globalThis.fetch;
  globalThis.fetch = mock(async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input.toString();
    const r = handler(url);
    const headers = new Headers(r.headers ?? {});
    if (!headers.has("content-type"))
      headers.set("content-type", "application/json");
    return new Response(JSON.stringify(r.body ?? {}), {
      status: r.status ?? 200,
      headers,
    });
  }) as unknown as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

const stubHost = {
  storage: {
    get: async () => null,
    set: async () => {},
    delete: async () => true,
  },
} as never;

describe("GitLabProvider", () => {
  let restore = () => {};
  afterEach(() => restore());

  test("validates PAT against /user", async () => {
    restore = setupMockFetch((url) => {
      if (url.endsWith("/user")) return { body: { username: "vignesh" } };
      return { body: {} };
    });
    const p = new GitLabProvider(stubHost);
    await p.saveCredentials({ kind: "pat", token: "glpat-abc" });
    const v = await p.validateCredentials();
    expect(v.ok).toBe(true);
    expect(v.account).toBe("vignesh");
  });

  test("listRepos maps fields", async () => {
    restore = setupMockFetch(() => ({
      body: [
        {
          id: 1,
          path_with_namespace: "g/sub/p",
          visibility: "private",
          default_branch: "main",
          archived: false,
          star_count: 3,
          forks_count: 1,
          http_url_to_repo: "g/sub/p.git",
          web_url: "https://gitlab.com/g/sub/p",
          created_at: "2026-01-01T00:00:00Z",
          last_activity_at: "2026-05-20T00:00:00Z",
          topics: ["tag1"],
        },
      ],
    }));
    const p = new GitLabProvider(stubHost);
    await p.saveCredentials({ kind: "pat", token: "glpat-abc" });
    const page = await p.listRepos({ org: "g", limit: 5 });
    expect(page.items[0]?.fqn).toBe("g/sub/p");
    expect(page.items[0]?.provider).toBe("gitlab");
    expect(page.items[0]?.visibility).toBe("private");
  });
});
