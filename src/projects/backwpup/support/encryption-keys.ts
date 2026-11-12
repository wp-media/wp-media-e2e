import { generateKeyPair, randomBytes } from "node:crypto";
import { promisify } from "node:util";

/**
 * The keys one scenario encrypts and decrypts backups with, made for that scenario alone.
 *
 * **Random, and never written in a feature.** A key spelled out in a feature would be the same in
 * every run and in the repository; these are drawn fresh for each scenario and reach a command only
 * through a placeholder — `{encryption key}`, `{another encryption key}`, `{public key file}`,
 * `{private key file}` — and `describeCli` hides a `--key=` value again in any failure message.
 *
 * - **Hex keys** are 64 hex characters — 32 bytes, AES-256, the length BackWPup's own settings
 *   generate. The plugin never checks a key's length: one that does not come out as 16, 24 or 32
 *   bytes crashes `backup-encrypt`, a plugin bug no scenario steps on.
 * - **The RSA pair** is 2048-bit, its public half as SPKI PEM and its private half as PKCS#8 PEM — the
 *   forms measured to round-trip through both commands. Its files are placed in the scenario's
 *   private folder, which only the identity site commands run as may enter, and go when it goes.
 *
 * Nothing is made until a placeholder asks, so a scenario naming none costs nothing.
 */

/** The hex keys a scenario can name, in its placeholders' words. */
export const HEX_KEY_NAMES = [
  "encryption key",
  "another encryption key",
] as const;

/** One of {@link HEX_KEY_NAMES}. */
export type HexKeyName = (typeof HEX_KEY_NAMES)[number];

/** The bytes in each hex key: AES-256's 32. */
const HEX_KEY_BYTES = 32;

/** Draws one hex key of {@link HEX_KEY_BYTES} random bytes. */
function drawHexKey(): string {
  return randomBytes(HEX_KEY_BYTES).toString("hex");
}

/** The key pair's files, by their names in the private folder. */
export const KEY_FILES = {
  public: "scenario-public.pem",
  private: "scenario-private.pem",
} as const;

/** The part of the scenario's private folder the keys need — so a test can hand in a stand-in. */
export interface KeyFolder {
  place(name: string, content: string): Promise<void>;
  relativePathTo(name: string): Promise<string>;
}

/** An RSA key pair, both halves PEM-encoded. */
export interface PemKeyPair {
  readonly publicKey: string;
  readonly privateKey: string;
}

/** Generates an RSA-2048 pair in the PEM forms BackWPup reads: SPKI and PKCS#8. */
export async function generatePemKeyPair(): Promise<PemKeyPair> {
  const { publicKey, privateKey } = await promisify(generateKeyPair)("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  return { publicKey, privateKey };
}

/** One scenario's keys — see the module comment. */
export class ScenarioKeys {
  /** Where the key pair's files go: the scenario's private folder. */
  private readonly folder: KeyFolder;

  /** How the key pair is made — {@link generatePemKeyPair}, unless a test says otherwise. */
  private readonly generate: () => Promise<PemKeyPair>;

  /** How a hex key is drawn — at random, unless a test says otherwise. */
  private readonly draw: () => string;

  /** Each hex key drawn so far, by name. */
  private readonly hex = new Map<HexKeyName, string>();

  /** The key pair's placement, once asked for. */
  private placed: Promise<void> | undefined;

  /**
   * @param folder - the scenario's private folder.
   * @param generate - how to make the key pair.
   * @param draw - how to draw a hex key.
   */
  constructor(
    folder: KeyFolder,
    generate: () => Promise<PemKeyPair> = generatePemKeyPair,
    draw: () => string = drawHexKey,
  ) {
    this.folder = folder;
    this.generate = generate;
    this.draw = draw;
  }

  /**
   * A hex key, drawn the first time it is named and the same for the rest of the scenario — and never
   * the same as the other one, since a scenario decrypting with "the wrong key" means a different one.
   */
  hexKey(name: HexKeyName): string {
    let key = this.hex.get(name);
    if (key === undefined) {
      const drawn = new Set(this.hex.values());
      do {
        key = this.draw();
      } while (drawn.has(key));
      this.hex.set(name, key);
    }
    return key;
  }

  /**
   * The key pair's public half, as a command run in WP-CLI's working directory reaches its file.
   *
   * @throws {@link Error} if the pair could not be made or placed in the private folder.
   */
  async publicKeyFile(): Promise<string> {
    await this.placePair();
    return this.folder.relativePathTo(KEY_FILES.public);
  }

  /**
   * The key pair's private half, as a command run in WP-CLI's working directory reaches its file.
   *
   * @throws {@link Error} if the pair could not be made or placed in the private folder.
   */
  async privateKeyFile(): Promise<string> {
    await this.placePair();
    return this.folder.relativePathTo(KEY_FILES.private);
  }

  /** Makes the pair and places both files the first time either is asked for. */
  private placePair(): Promise<void> {
    this.placed ??= (async () => {
      const pair = await this.generate();
      await this.folder.place(KEY_FILES.public, pair.publicKey);
      await this.folder.place(KEY_FILES.private, pair.privateKey);
    })();
    return this.placed;
  }
}
