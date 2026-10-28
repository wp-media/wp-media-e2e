import { constants } from "node:fs";
import { lstat, open, type FileHandle } from "node:fs/promises";
import { dirname } from "node:path";

import { errorCode } from "./error-code";
import {
  checkOwnFolder,
  describeFolderProblem,
  ownFolderRemedy,
  STATE_FOLDER,
} from "./folders";
import {
  assertWaitMs,
  drainTerminal,
  stdoutTerminal,
  TERMINAL_BACKLOG_BYTES,
  type Terminal,
} from "../src/common/terminal/stream";
import { safeLine } from "./text";

export type { Terminal } from "../src/common/terminal/stream";
/**
 * The most bytes left waiting for the terminal before its lines are skipped (the shared bound, a live
 * region's too): about 4,000 ordinary lines, so a slow terminal loses none, and a stalled one costs at
 * most this much memory. Bytes indeed: the logger writes its lines UTF-8 encoded, which the stream
 * counts by the byte (a string it would count by UTF-16 unit, a third of the bytes of a `✔`).
 */
export { TERMINAL_BACKLOG_BYTES };

/**
 * The orchestrator's own log: one line per event, written to the terminal as `HH:MM:SS <scope>  <text>`
 * and appended to `orchestrator.log` as `<ISO date, time and offset> <scope>  <text>` — the file
 * lives across days and starts, so each of its lines carries its own date and offset
 * ({@link localIsoTime}): a `grep` or a `tail` still dates it, and the hour a fall-back to winter time
 * repeats reads twice with two offsets. Never a run's output — runs interleave, and each has its
 * `run.log`. Every line is masked and made one line ({@link safeLine}) before it goes anywhere.
 *
 * The file keeps every line; the terminal is best-effort. It may vanish under the process — an SSH
 * session closed outside `tmux` leaves writes failing with `EIO`, a closed pipe with `EPIPE` — so its
 * first failure stops terminal writes for good. It may stall — a paused terminal, a pipe nobody reads —
 * so standard output is made non-blocking where Node allows it ({@link stdoutTerminal}: its limits are
 * there), and while more than {@link TERMINAL_BACKLOG_BYTES} wait for it, its lines are skipped and
 * counted, and the count shown when it takes a line again. Being non-blocking, the terminal takes a
 * line after it is written, so {@link Logger.flush} and {@link Logger.close} wait for it too, within
 * their bound: a `process.exit` right after them would otherwise cut what it had not taken yet. The
 * file is written through one queue, in call order, and its failure never reaches the caller: a log
 * must not stop what it logs.
 *
 * The {@link Logger} interface is deliberately small, so a structured logger can later sit behind it
 * without touching its callers.
 */

/** The orchestrator's log. */
export interface Logger {
  /**
   * Logs one line, timestamped now: offered to the terminal at once, queued for the file. A failing
   * output never makes it throw. A text of several lines is flattened into one; after
   * {@link Logger.close} it is dropped.
   *
   * @param scope - who speaks: `orchestrator`, or a task's id.
   * @param text - what happened.
   */
  line(scope: string, text: string): void;
  /**
   * Settles once every line logged so far is in the file (or failed to be) and taken by the terminal
   * ({@link drainTerminal}; not waited for once the terminal is gone), or after `maxWaitMs` — a file
   * write that hangs (a stalled network mount) or a paused terminal must not hang its caller. Never
   * rejects.
   *
   * @param maxWaitMs - the longest wait; {@link DEFAULT_WAIT_MS} by default.
   * @throws {@link RangeError} when `maxWaitMs` is not a whole number of milliseconds a timer takes.
   */
  flush(maxWaitMs?: number): Promise<void>;
  /**
   * Stops taking lines, flushes — the file and the terminal, as {@link Logger.flush} —, then closes the
   * file, waiting `maxWaitMs` at most for all of it: what is still unwritten then is given up, and the
   * file is left to the process's end. Call it before `process.exit`, which drops what the terminal has
   * not taken. Idempotent (the first call's wait applies); never rejects.
   *
   * @param maxWaitMs - the longest wait; {@link DEFAULT_WAIT_MS} by default.
   * @throws {@link RangeError} when `maxWaitMs` is not a whole number of milliseconds a timer takes.
   */
  close(maxWaitMs?: number): Promise<void>;
}

/** Where the file's lines go: the open `orchestrator.log`, or a stand-in. */
export interface LogFile {
  /**
   * Appends text; rejects when it could not — maybe after writing part of it.
   *
   * @param text - the text.
   */
  append(text: string): Promise<void>;
  /** Closes it; rejects when it could not. */
  close(): Promise<void>;
}

/** How a logger is made. */
export interface LoggerOptions {
  /** The file every line is appended to. */
  readonly file: LogFile;
  /** The terminal; standard output by default ({@link stdoutTerminal}). */
  readonly terminal?: Terminal;
  /** Secret values to mask wherever a line holds them (`allSecretValues(config, tasks)`). */
  readonly secrets?: readonly string[];
  /** The clock a line's time is read from; local time is shown. */
  readonly now?: () => Date;
}

/** The longest scope a line shows, in code points: a task's id is four. */
export const MAX_SCOPE_LENGTH = 40;

/** The longest text a line shows, in code points: an outcome line with its report path fits. */
export const MAX_TEXT_LENGTH = 2_000;

/** How long {@link Logger.flush} and {@link Logger.close} wait at most, by default. */
export const DEFAULT_WAIT_MS = 5_000;

/** The scope of the logger's own lines about its outputs; three characters, so never a task's id. */
const LOG_SCOPE = "log";

/**
 * How `orchestrator.log` is opened: appended to — it lives across starts — and created `0600` when
 * missing, but never through a symbolic link in the log's own place (`O_NOFOLLOW`, `ELOOP`; a link
 * among the folders above is followed, which is why {@link openLogger} checks the log's folder), and
 * never waiting on a FIFO (`O_NONBLOCK`: one with no reader is refused, `ENXIO`; one with a reader
 * opens, and is refused by type after). A folder is refused by the open itself (`EISDIR`).
 */
const LOG_FLAGS =
  constants.O_WRONLY |
  constants.O_APPEND |
  constants.O_CREAT |
  constants.O_NOFOLLOW |
  constants.O_NONBLOCK;

/** The mode the log is created with, and tightened to. */
const LOG_MODE = 0o600;

/**
 * Two digits.
 *
 * @param part - a whole number from 0 to 99.
 * @returns it, zero-padded.
 */
function twoDigits(part: number): string {
  return String(part).padStart(2, "0");
}

/**
 * A time as the terminal shows it: local `HH:MM:SS`, each part two digits.
 *
 * @param at - the time.
 * @returns e.g. `09:05:03`.
 */
export function clockTime(at: Date): string {
  return [at.getHours(), at.getMinutes(), at.getSeconds()]
    .map(twoDigits)
    .join(":");
}

/**
 * A time as the file shows it: local ISO 8601 date and time with the offset from UTC,
 * `2026-10-13T10:15:30+02:00`. Every line stands alone — a `grep` or a `tail` still dates it — and
 * the offset tells apart the two hours a fall-back to winter time repeats.
 *
 * @param at - the time.
 * @returns e.g. `2026-10-13T10:15:30+02:00`; UTC is `+00:00`.
 */
export function localIsoTime(at: Date): string {
  const offset = -at.getTimezoneOffset();
  const sign = offset < 0 ? "-" : "+";
  const date = [
    String(at.getFullYear()).padStart(4, "0"),
    twoDigits(at.getMonth() + 1),
    twoDigits(at.getDate()),
  ].join("-");
  const zone = `${sign}${twoDigits(Math.floor(Math.abs(offset) / 60))}:${twoDigits(Math.abs(offset) % 60)}`;
  return `${date}T${clockTime(at)}${zone}`;
}

/**
 * What a line says, without its time: `<scope>  <text>` — two spaces after the scope, so the text
 * stands apart from it whatever its length. Scope and text each pass through {@link safeLine}:
 * masked, one line, cut.
 *
 * @param scope - who speaks.
 * @param text - what happened.
 * @param secrets - secret values to mask.
 * @returns the line's body.
 */
function formatBody(
  scope: string,
  text: string,
  secrets: readonly string[],
): string {
  return `${safeLine(scope, MAX_SCOPE_LENGTH, secrets)}  ${safeLine(text, MAX_TEXT_LENGTH, secrets)}`;
}

/**
 * One terminal line, without its line end: `HH:MM:SS <scope>  <text>` ({@link clockTime}).
 *
 * @param at - when.
 * @param scope - who speaks.
 * @param text - what happened.
 * @param secrets - secret values to mask.
 * @returns the line.
 */
export function formatLine(
  at: Date,
  scope: string,
  text: string,
  secrets: readonly string[] = [],
): string {
  return `${clockTime(at)} ${formatBody(scope, text, secrets)}`;
}

/**
 * One file line, without its line end: `<ISO time> <scope>  <text>` ({@link localIsoTime}).
 *
 * @param at - when.
 * @param scope - who speaks.
 * @param text - what happened.
 * @param secrets - secret values to mask.
 * @returns the line.
 */
export function formatFileLine(
  at: Date,
  scope: string,
  text: string,
  secrets: readonly string[] = [],
): string {
  return `${localIsoTime(at)} ${formatBody(scope, text, secrets)}`;
}

/**
 * Makes a logger over an open file.
 *
 * @param options - the file, the terminal, the secrets, the clock.
 * @returns the logger.
 */
export function createLogger(options: LoggerOptions): Logger {
  return new TwoWayLogger(options);
}

/**
 * Opens `orchestrator.log` ({@link openLogFile}) and makes a logger over it. When the file had a wider
 * mode than `0600`, it was tightened, and the first line says so.
 *
 * @param path - the log's path, in the state directory: its folder must exist, be this user's, and no
 *   one else may write in it — the lock's own rule ({@link STATE_FOLDER}) — so no one else can put a
 *   link or another file in the log's place.
 * @param options - the terminal, the secrets, the clock.
 * @returns the logger.
 * @throws {@link Error} when the folder is refused, or the log cannot be opened or is refused
 *   ({@link openLogFile}).
 */
export async function openLogger(
  path: string,
  options: Omit<LoggerOptions, "file"> = {},
): Promise<Logger> {
  const folder = dirname(path);
  const check = await checkOwnFolder(folder, STATE_FOLDER);
  if (check.kind !== "ok")
    throw new Error(
      `The orchestrator's log folder ${folder} ${describeFolderProblem(check)}: it must be this user's, and no one else may write in it${check.kind === "notFolder" ? "" : ` (${ownFolderRemedy(folder, check, STATE_FOLDER)})`}.`,
    );
  const opened = await openLogFile(path);
  const logger = createLogger({ ...options, file: opened.file });
  if (opened.tightenedFrom !== undefined)
    logger.line(
      LOG_SCOPE,
      `${path} was mode ${formatMode(opened.tightenedFrom)}: now ${formatMode(LOG_MODE)}`,
    );
  return logger;
}

/** An opened log, and the mode it was tightened from, if it was. */
export interface OpenedLogFile {
  /** The log, open for appending. */
  readonly file: LogFile;
  /** The mode it had, when wider than `0600` and tightened. */
  readonly tightenedFrom?: number;
}

/** How {@link openLogFile} opens a file: `fs.promises.open`'s shape. */
export type OpenFile = (
  path: string,
  flags: number,
  mode: number,
) => Promise<FileHandle>;

/** What {@link pathKind} reads of a path: `lstat`'s shape. */
export type LstatPath = (path: string) => Promise<{
  /** Whether it is a symbolic link (`lstat` never follows one). */
  isSymbolicLink(): boolean;
  /** Whether it is a FIFO, which an append would block on. */
  isFIFO(): boolean;
  /** Whether it is a socket. */
  isSocket(): boolean;
  /** Whether it is a folder. */
  isDirectory(): boolean;
  /** Whether it is a block device. */
  isBlockDevice(): boolean;
  /** Whether it is a character device: a terminal, `/dev/null`. */
  isCharacterDevice(): boolean;
}>;

/**
 * Opens a log for appending, refusing what it must not write into: anything but a regular file (a
 * link, a FIFO, a socket, a folder, a device), a file of another user's, or one with a second hard
 * link — a name for another file of this user's, which lines would then be appended to. A file this
 * user owns with a wider mode is tightened to `0600` rather than refused: the lines are masked, so
 * nothing was exposed, and the start need not fail over it.
 *
 * @param path - the log's path.
 * @param openFile - how a file is opened; `fs.promises.open` by default.
 * @returns the log, and the mode it had when tightened.
 * @throws {@link Error} naming the path and what is wrong, or the open's error code and what is in the
 *   log's place.
 */
export async function openLogFile(
  path: string,
  openFile: OpenFile = open,
): Promise<OpenedLogFile> {
  let handle: FileHandle;
  try {
    handle = await openFile(path, LOG_FLAGS, LOG_MODE);
  } catch (error) {
    const kind = await pathKind(path);
    throw new Error(
      `The orchestrator's log cannot be opened (${systemCode(error)}): ${path}${kind === undefined ? "" : ` is ${kind}, not a regular file`}.`,
      { cause: error },
    );
  }
  try {
    const stats = await handle.stat();
    const refusal = refuseLogFile(stats, process.getuid?.());
    if (refusal !== undefined)
      throw new Error(`The orchestrator's log is refused: ${path} ${refusal}.`);
    // Special bits included, so a set-id bit is cleared with the rest.
    const mode = stats.mode & 0o7777;
    if ((mode & ~LOG_MODE) !== 0) await handle.chmod(LOG_MODE);
    return {
      file: fileOf(handle),
      ...((mode & ~LOG_MODE) !== 0 ? { tightenedFrom: mode } : {}),
    };
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

/**
 * A failed call's code for a message: the system error's code (`ELOOP`), or `errno N` for one Node
 * has no name for — macOS refuses to open a socket with errno 102, which Node calls
 * `Unknown system error -102`.
 *
 * @param error - what was thrown.
 * @returns the code.
 */
export function systemCode(error: unknown): string {
  const code = errorCode(error);
  if (code !== undefined && /^E[A-Z0-9]+$/.test(code)) return code;
  const errno =
    typeof error === "object" && error !== null && "errno" in error
      ? error.errno
      : undefined;
  if (typeof errno === "number") return `errno ${String(Math.abs(errno))}`;
  return code ?? "unknown error";
}

/**
 * What is in a path's place when it is no regular file, for a message only: an open's error code
 * does not say it (Linux answers `ENXIO` for a socket as for a FIFO with no reader). Read after the
 * open failed, so a race can only mislabel a message, never let a file through.
 *
 * @param path - the path.
 * @param lstatPath - how it is read; `fs.promises.lstat` by default.
 * @returns `a symbolic link`, `a FIFO`, `a socket`, `a folder` or `a device`; `undefined` for a
 *   regular file, a missing path, or one that cannot be read.
 */
export async function pathKind(
  path: string,
  lstatPath: LstatPath = lstat,
): Promise<string | undefined> {
  try {
    const stats = await lstatPath(path);
    if (stats.isSymbolicLink()) return "a symbolic link";
    if (stats.isFIFO()) return "a FIFO";
    if (stats.isSocket()) return "a socket";
    if (stats.isDirectory()) return "a folder";
    if (stats.isBlockDevice() || stats.isCharacterDevice()) return "a device";
    return undefined;
  } catch {
    return undefined;
  }
}

/** What {@link refuseLogFile} reads of a file. */
export interface LogFileStats {
  /** Its owner. */
  readonly uid: number;
  /** How many names it has. */
  readonly nlink: number;
  /** Whether it is a regular file. */
  isFile(): boolean;
}

/**
 * Why an open file must not be the log, if it must not.
 *
 * @param stats - the open file's.
 * @param uid - this process's user, when the platform has one.
 * @returns the reason, or `undefined` when it may be.
 */
export function refuseLogFile(
  stats: LogFileStats,
  uid: number | undefined,
): string | undefined {
  if (!stats.isFile()) return "is not a regular file";
  if (uid !== undefined && stats.uid !== uid) return "is another user's";
  if (stats.nlink !== 1) return "has another hard link";
  return undefined;
}

/**
 * A file handle as a {@link LogFile}.
 *
 * @param handle - opened for appending.
 * @returns the log file over it.
 */
function fileOf(handle: FileHandle): LogFile {
  return {
    append: (text) => handle.appendFile(text),
    close: () => handle.close(),
  };
}

/**
 * A mode as `ls` would show its digits.
 *
 * @param mode - the permission bits.
 * @returns e.g. `0644`.
 */
function formatMode(mode: number): string {
  return `0${mode.toString(8).padStart(3, "0")}`;
}

/**
 * Settles when `work` does, or after `ms`, whichever comes first. The timer does not keep the process
 * alive, and is cleared when the work wins.
 *
 * @param work - a promise that never rejects.
 * @param ms - the longest wait.
 * @returns a promise that never rejects.
 */
function within(work: Promise<void>, ms: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
    timer.unref();
  });
  return Promise.race([work, timeout]).finally(() => {
    clearTimeout(timer);
  });
}

/**
 * Each terminal's logger listeners. A terminal gets one `error` listener of its own, for the process's
 * life — an `error` from a write already issued may come after every logger closed, and an `error`
 * event nobody listens to crashes the process — which passes the error to the loggers still open.
 * A closed logger leaves the set, so it is not kept alive by the terminal, and however many loggers a
 * process makes, a terminal has one listener.
 */
const terminalWatchers = new WeakMap<Terminal, Set<(error: Error) => void>>();

/**
 * Has `onError` told of the terminal's `error` events until the returned function is called.
 *
 * @param terminal - the terminal.
 * @param onError - what to call with an error.
 * @returns the function that stops it.
 */
function watchTerminal(
  terminal: Terminal,
  onError: (error: Error) => void,
): () => void {
  let watchers = terminalWatchers.get(terminal);
  if (watchers === undefined) {
    const created = new Set<(error: Error) => void>();
    terminalWatchers.set(terminal, created);
    terminal.on("error", (error) => {
      for (const watcher of [...created]) watcher(error);
    });
    watchers = created;
  }
  const own = watchers;
  own.add(onError);
  return () => {
    own.delete(onError);
  };
}

/** A line in both its forms, each with its line end. */
interface StampedLine {
  /** `HH:MM:SS …`, for the terminal. */
  readonly terminal: string;
  /** `<ISO time> …`, for the file. */
  readonly file: string;
}

/** The logger {@link createLogger} hands out. */
class TwoWayLogger implements Logger {
  /** The file's writes, one after another. Never rejects. */
  private queue: Promise<void> = Promise.resolve();
  /** Set once the terminal failed: it is not written again. */
  private terminalGone = false;
  /** Set once a file write failed, so the failure is told once. */
  private fileFailed = false;
  /**
   * Set while the last append failed: it may have written part of its line (a disk filling up), so
   * the next append starts a line of its own rather than finish that one — an empty line, when the
   * failed one wrote nothing, which is the cheaper mistake.
   */
  private breakLine = false;
  /** Lines the terminal skipped since it last took one, while too much waited for it. */
  private skipped = 0;
  /** The close in progress or done; set, no line is taken any more. */
  private closing: Promise<void> | undefined;
  /** Where the terminal's lines go. */
  private readonly terminal: Terminal;
  /** Secret values every line is masked of. */
  private readonly secrets: readonly string[];
  /** The clock a line's time is read from. */
  private readonly now: () => Date;
  /** Stops this logger hearing the terminal's `error` events; called on close. */
  private readonly unwatch: () => void;

  /** @param options - see {@link LoggerOptions}. */
  constructor(private readonly options: LoggerOptions) {
    this.terminal = options.terminal ?? stdoutTerminal();
    this.secrets = options.secrets ?? [];
    this.now = options.now ?? (() => new Date());
    this.unwatch = watchTerminal(this.terminal, (error) => {
      this.loseTerminal(error);
    });
  }

  /**
   * {@inheritDoc Logger.line}
   *
   * @param scope - who speaks: `orchestrator`, or a task's id.
   * @param text - what happened.
   */
  line(scope: string, text: string): void {
    if (this.closing !== undefined) return;
    const line = this.stamp(scope, text);
    // Queued first, so a terminal that throws has its failure told after the line it failed on.
    this.enqueue(line.file);
    this.toTerminal(line.terminal);
  }

  /**
   * {@inheritDoc Logger.flush}
   *
   * @param maxWaitMs - the longest wait.
   * @returns once flushed, or the wait is over; never rejects.
   */
  flush(maxWaitMs: number = DEFAULT_WAIT_MS): Promise<void> {
    assertWaitMs(maxWaitMs);
    const deadline = performance.now() + maxWaitMs;
    // The file first: a failed write is told to the terminal, which is then waited for with it.
    return within(
      this.queue.then(() => this.drain(deadline)),
      maxWaitMs,
    );
  }

  /**
   * {@inheritDoc Logger.close}
   *
   * @param maxWaitMs - the longest wait; the first call's applies.
   * @returns once closed, or the wait is over; never rejects.
   */
  close(maxWaitMs: number = DEFAULT_WAIT_MS): Promise<void> {
    if (this.closing !== undefined) return this.closing;
    assertWaitMs(maxWaitMs);
    const deadline = performance.now() + maxWaitMs;
    this.unwatch();
    this.closing = within(
      this.queue.then(async () => {
        await Promise.all([
          this.options.file.close().catch(() => undefined),
          this.drain(deadline),
        ]);
      }),
      maxWaitMs,
    );
    return this.closing;
  }

  /**
   * Waits until the terminal has taken every line written to it, or the deadline passed; at once when
   * the terminal is gone. Never rejects.
   *
   * @param deadline - when to give up, on `performance.now()`'s clock.
   */
  private async drain(deadline: number): Promise<void> {
    if (this.terminalGone) return;
    const left = Math.max(0, Math.ceil(deadline - performance.now()));
    await drainTerminal(this.terminal, left);
  }

  /**
   * A line, read off the clock now, in both forms — through {@link formatLine} and
   * {@link formatFileLine}, so the formatters the specs pin are the ones that run.
   *
   * @param scope - who speaks.
   * @param text - what happened.
   * @returns the terminal's and the file's line, each with its line end.
   */
  private stamp(scope: string, text: string): StampedLine {
    const at = this.now();
    return {
      terminal: `${formatLine(at, scope, text, this.secrets)}\n`,
      file: `${formatFileLine(at, scope, text, this.secrets)}\n`,
    };
  }

  /**
   * Offers a line to the terminal, unless it is gone. While more than
   * {@link TERMINAL_BACKLOG_BYTES} wait for it, the line is skipped and counted; the next line it
   * takes is preceded by the count.
   *
   * @param line - the line, with its line end.
   */
  private toTerminal(line: string): void {
    if (this.terminalGone) return;
    if (this.terminal.writableLength > TERMINAL_BACKLOG_BYTES) {
      this.skipped++;
      return;
    }
    if (this.skipped > 0) {
      const count = this.skipped;
      this.skipped = 0;
      this.writeTerminal(
        this.stamp(
          LOG_SCOPE,
          `${String(count)} ${count === 1 ? "line" : "lines"} not shown: the terminal was not keeping up (the log file has them)`,
        ).terminal,
      );
    }
    this.writeTerminal(line);
  }

  /**
   * Writes to the terminal, UTF-8 encoded, so its backlog counts bytes ({@link TERMINAL_BACKLOG_BYTES});
   * a failure, thrown or called back, makes it gone.
   *
   * @param line - the line, with its line end.
   */
  private writeTerminal(line: string): void {
    if (this.terminalGone) return;
    try {
      this.terminal.write(Buffer.from(line, "utf8"), (error) => {
        if (error) this.loseTerminal(error);
      });
    } catch (error) {
      this.loseTerminal(error);
    }
  }

  /**
   * Stops terminal writes for good, and says so in the file — once, however many ways the failure
   * is told (a callback and an `error` event both come for one failed write), and not once closing.
   *
   * @param error - what the terminal failed with.
   */
  private loseTerminal(error: unknown): void {
    if (this.terminalGone) return;
    this.terminalGone = true;
    if (this.closing !== undefined) return;
    this.enqueue(
      this.stamp(
        LOG_SCOPE,
        `terminal gone (${errorCode(error) ?? "unknown error"}): lines go to the file only`,
      ).file,
    );
  }

  /**
   * Queues a line for the file, after every line before it. A failed write is told to the terminal
   * once; later lines are still tried, so a disk that frees up gets them again — the first of them on
   * a line of its own, as the failed one may have left half a line.
   *
   * @param line - the line, with its line end.
   */
  private enqueue(line: string): void {
    this.queue = this.queue.then(async () => {
      try {
        await this.options.file.append(this.breakLine ? `\n${line}` : line);
        this.breakLine = false;
      } catch (error) {
        this.breakLine = true;
        if (this.fileFailed) return;
        this.fileFailed = true;
        this.toTerminal(
          this.stamp(
            LOG_SCOPE,
            `writing the log file failed (${errorCode(error) ?? "unknown error"}): its lines may be missing`,
          ).terminal,
        );
      }
    });
  }
}
