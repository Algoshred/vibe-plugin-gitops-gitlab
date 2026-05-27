# @vibecontrols/vibe-plugin-gitops-gitlab

GitLab provider for the [`@vibecontrols/vibe-plugin-gitops`](https://npmjs.com/package/@vibecontrols/vibe-plugin-gitops) meta plugin.

## Install

```bash
vibe plugin install @vibecontrols/vibe-plugin-gitops          # meta (once)
vibe plugin install @vibecontrols/vibe-plugin-gitops-gitlab
```

## Auth

Personal Access Token (`api` scope). Self-hosted instances supported via `meta.host`:

```bash
vibe gitops auth set gitlab glpat-xxxxxxxxxxxxxxxxxxxx
```

Self-hosted GitLab:

```bash
curl -X POST "${AGENT_URL}/api/profiles/default/gitops/gitlab/auth" \
  -H "x-agent-api-key: $KEY" \
  -d '{"kind":"pat","token":"glpat-xxx","meta":{"host":"https://gitlab.acme.com"}}'
```

## License

Proprietary — see LICENSE.
