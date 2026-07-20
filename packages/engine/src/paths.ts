import { homedir } from "node:os";
import { join } from "node:path";
export const shynHome = (): string =>
  process.env.SHYN_HOME ?? join(homedir(), "Library", "Application Support", "shyn");
