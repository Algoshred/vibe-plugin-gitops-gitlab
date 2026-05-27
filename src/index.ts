/**
 * @vibecontrols/vibe-plugin-gitops-gitlab
 *
 * GitLab provider plugin. Registers a GitLabProvider implementation under
 * type "gitops" with name "gitlab" in the agent's service registry.
 */

import {
  BoundLogger,
  createLifecycleHooks,
  ProviderRegistry,
  TelemetryEmitter,
} from "@vibecontrols/plugin-sdk";
import type {
  HostServices,
  ProfileContext,
  VibePlugin,
  VibePluginFactory,
} from "@vibecontrols/plugin-sdk/contract";

import { GitLabProvider } from "./provider.js";

const PLUGIN_NAME = "gitops-gitlab";
const PLUGIN_VERSION = "0.1.0";
const PROVIDER_NAME = "gitlab";

let provider: GitLabProvider | null = null;

export const createPlugin: VibePluginFactory = (
  _ctx: ProfileContext,
): VibePlugin => {
  const telemetry = new TelemetryEmitter(PLUGIN_NAME, PLUGIN_VERSION);

  const lifecycle = createLifecycleHooks({
    name: PLUGIN_NAME,
    telemetryEventName: "gitops.provider.ready",
    onInit: async (hostServices: HostServices) => {
      const log = new BoundLogger(hostServices.logger, PLUGIN_NAME);
      provider = new GitLabProvider(hostServices);
      await provider.init();
      new ProviderRegistry(hostServices).registerProvider(
        "gitops",
        PROVIDER_NAME,
        provider,
      );
      telemetry.emit("gitops.provider.ready", { provider: PROVIDER_NAME });
      log.info("GitLab gitops provider registered");
    },
    onShutdown: async () => {
      provider = null;
    },
  });

  return {
    capabilities: {
      storage: "rw",
      secrets: "rw",
      telemetry: true,
      audit: true,
    },
    name: PLUGIN_NAME,
    version: PLUGIN_VERSION,
    description:
      "GitLab provider for the GitOps meta plugin. Supports gitlab.com + self-hosted via REST v4.",
    tags: ["backend", "provider", "integration"],

    onServerStart: lifecycle.onServerStart,
    onServerStop: lifecycle.onServerStop,
  };
};

export default createPlugin;
export { GitLabProvider } from "./provider.js";
export type * from "./types.js";
