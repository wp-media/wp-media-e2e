import {
  detectCapabilities,
  type Environment,
  type OutputStream,
  type TerminalCapabilities,
} from "../../src/common/terminal/capabilities";
import { terminalWidth } from "../../src/common/terminal/layout";
import { createPalette, type Palette } from "../../src/common/terminal/palette";

/**
 * What the orchestrator's terminal can show, decided from its own stream and the standard variables
 * — never an `E2E_*` one: the orchestrator reads none (`E2E_OUTPUT` is the suite's switch). Unlike
 * the suite, a pipe never gets colour, even under `FORCE_COLOR`: a piped orchestrator is a log.
 */

/** How the status table is laid out on a stream. */
export interface TableView {
  readonly capabilities: TerminalCapabilities;
  /** Its columns: `columns`, else `COLUMNS`, else 80; 20–120. */
  readonly width: number;
  /** Its lines: the terminal's rows less two (the cursor's line, and one to spare); absent unsized. */
  readonly height?: number;
  /** Symbols by the capabilities, colour off: the table is plain. */
  readonly palette: Palette;
}

/**
 * The orchestrator's capabilities on a stream.
 *
 * @param env - the process's environment.
 * @param stream - its standard output: `isTTY`, `columns`, `rows`.
 * @returns the capabilities: `forceColorWithoutTty: false`, mode `auto`, context `run`.
 */
export function orchestratorCapabilities(
  env: Environment,
  stream: OutputStream,
): TerminalCapabilities {
  return detectCapabilities({ env, stream, forceColorWithoutTty: false });
}

/**
 * The status table's layout on a stream.
 *
 * @param env - the process's environment.
 * @param stream - its standard output.
 * @returns the capabilities, width, height and a colourless palette.
 */
export function tableView(env: Environment, stream: OutputStream): TableView {
  const capabilities = orchestratorCapabilities(env, stream);
  const rows = stream.rows;
  return {
    capabilities,
    width: terminalWidth({ stream, env }),
    ...(typeof rows === "number" && Number.isInteger(rows) && rows > 0
      ? { height: Math.max(0, rows - 2) }
      : {}),
    palette: createPalette({ ...capabilities, color: false }),
  };
}
