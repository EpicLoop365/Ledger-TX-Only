// Injected at build time by vite.config.ts
declare const __GIT_COMMIT__: string;
declare const __GIT_COMMIT_SHORT__: string;
declare const __GIT_BRANCH__: string;
declare const __GIT_DIRTY__: boolean;
declare const __BUILD_TIME__: string;

export const BUILD_INFO = {
  commit: __GIT_COMMIT__,
  commitShort: __GIT_COMMIT_SHORT__,
  branch: __GIT_BRANCH__,
  dirty: __GIT_DIRTY__,
  buildTime: __BUILD_TIME__,
  repoUrl: "https://github.com/EpicLoop365/Ledger-TX-Only",
};
