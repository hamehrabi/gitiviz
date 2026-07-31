/**
 * Executable entry that runs only the apply-narration command. esbuild
 * bundles this file into plugins/claude-code/scripts/apply-narration.mjs so
 * the plugin can merge a narration response without exposing the full CLI.
 * (The bundle banner supplies the shebang — none here or the artifact would
 * have two.)
 */
import { runCli } from "./index.js";

process.exitCode = await runCli(["apply-narration", ...process.argv.slice(2)]);
