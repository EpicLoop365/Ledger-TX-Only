import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import nodePolyfills from "rollup-plugin-polyfill-node";
import { execSync } from "child_process";

// Grab git info at build time
// Vercel provides VERCEL_GIT_COMMIT_SHA etc. when not in a git repo
const gitCommit = (() => {
  if (process.env.VERCEL_GIT_COMMIT_SHA) return process.env.VERCEL_GIT_COMMIT_SHA;
  try { return execSync("git rev-parse HEAD").toString().trim(); }
  catch { return "unknown"; }
})();

const gitCommitShort = gitCommit.slice(0, 7);

const gitBranch = (() => {
  if (process.env.VERCEL_GIT_COMMIT_REF) return process.env.VERCEL_GIT_COMMIT_REF;
  try { return execSync("git rev-parse --abbrev-ref HEAD").toString().trim(); }
  catch { return "unknown"; }
})();

const gitDirty = (() => {
  if (process.env.VERCEL) return false; // Vercel builds from clean commits
  try { return execSync("git status --porcelain").toString().trim().length > 0; }
  catch { return false; }
})();

const buildTime = new Date().toISOString();

export default defineConfig({
  plugins: [react()],
  define: {
    global: "globalThis",
    __GIT_COMMIT__: JSON.stringify(gitCommit),
    __GIT_COMMIT_SHORT__: JSON.stringify(gitCommitShort),
    __GIT_BRANCH__: JSON.stringify(gitBranch),
    __GIT_DIRTY__: JSON.stringify(gitDirty),
    __BUILD_TIME__: JSON.stringify(buildTime),
  },
  resolve: {
    alias: {
      buffer: "buffer",
    },
  },
  optimizeDeps: {
    esbuildOptions: {
      define: {
        global: "globalThis",
      },
    },
  },
  build: {
    rollupOptions: {
      plugins: [nodePolyfills()],
    },
  },
});
