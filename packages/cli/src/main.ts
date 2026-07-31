/**
 * Executable entry for the full gitiviz CLI. esbuild bundles this file into
 * plugins/claude-code/scripts/analyze.mjs (the bundle banner supplies the
 * shebang — no shebang here or the artifact would have two).
 */
import { runCli } from "./index.js";

process.exitCode = await runCli(process.argv.slice(2));
