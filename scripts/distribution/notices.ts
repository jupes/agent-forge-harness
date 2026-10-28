import type { Plugin } from "vite";

export type DistributionNotice = {
  readonly fileName: string;
  readonly contents: Uint8Array;
};

export async function readDistributionNotices(
  _repositoryRoot: string,
): Promise<readonly DistributionNotice[]> {
  return [];
}

export function distributionNoticesPlugin(
  _repositoryRoot: string,
): Plugin {
  return {
    name: "agent-forge-distribution-notices",
    apply: "build",
    generateBundle() {},
  };
}

export function writeDistributionNotices(
  _stageRoot: string,
  _notices: readonly DistributionNotice[],
): void {}
