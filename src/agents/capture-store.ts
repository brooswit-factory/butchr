import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CaptureSink } from "./session-limit-watch.js";

/**
 * The real fs-backed CaptureSink (BUTCHR-12). `dir` is created lazily, on
 * first write — most daemons never trigger a capture, so there's no reason
 * to touch disk at startup for a directory that may never be used.
 */
export function createCaptureStore(dir: string): CaptureSink {
  return {
    write: async (name, contents) => {
      mkdirSync(dir, { recursive: true });
      const path = join(dir, name);
      writeFileSync(path, contents);
      return path;
    },
    list: async () => {
      try {
        return readdirSync(dir);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw e;
      }
    },
    remove: async (name) => {
      rmSync(join(dir, name));
    },
  };
}
