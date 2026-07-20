#!/usr/bin/env tsx
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { join } from "node:path";
// Subpath import (not the "@shyn/engine" barrel) is deliberate: the barrel's
// index.ts re-exports Engine/Embedder/readers/etc. alongside shynHome, and
// esbuild does not tree-shake those unused re-exports away (confirmed: even
// with only `shynHome` imported through the barrel, esbuild still pulls in
// embedder.ts's `await import("node-llama-cpp")` and storage.ts's static
// `import "better-sqlite3-multiple-ciphers"` and fails on their native
// platform packages). mcp-client only ever needs shynHome — importing it via
// this narrower "@shyn/engine/paths" subpath (mirroring @shyn/daemon's
// existing "./rpc" subpath export) keeps the mcpb bundle pure JS, matching
// the "no natives" requirement in scripts/build-mcpb.mjs.
import { shynHome } from "@shyn/engine/paths";
import { buildMcpServer } from "./tools.js";
import { startHelloLoop } from "./hello.js";

const server = buildMcpServer(join(shynHome(), "shyn.sock"));
startHelloLoop(join(shynHome(), "shyn.sock"));
await server.connect(new StdioServerTransport());
