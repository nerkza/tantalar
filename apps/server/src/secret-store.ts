import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

interface SecretDocument {
  version: 1;
  secrets: Record<string, Record<string, string>>;
}

const EMPTY: SecretDocument = { version: 1, secrets: {} };

/** Server-owned credential file. It is never exposed through plugin storage. */
export class SecretStore {
  readonly #path: string;
  #queue: Promise<void> = Promise.resolve();

  constructor(path: string) {
    this.#path = path;
  }

  async get(owner: string, ref: string): Promise<string | null> {
    const document = await this.#read();
    return document.secrets[owner]?.[ref] ?? null;
  }

  async has(owner: string, ref: string): Promise<boolean> {
    return (await this.get(owner, ref)) !== null;
  }

  async set(owner: string, ref: string, value: string): Promise<void> {
    if (!owner || !ref || !value || value.length > 4096 || /[\0\r\n]/.test(value)) {
      throw new Error("invalid secret value");
    }
    await this.#mutate(async (document) => {
      document.secrets[owner] ??= {};
      document.secrets[owner]![ref] = value;
    });
  }

  async delete(owner: string, ref: string): Promise<boolean> {
    let deleted = false;
    await this.#mutate(async (document) => {
      const values = document.secrets[owner];
      if (!values || !Object.hasOwn(values, ref)) return;
      delete values[ref];
      if (Object.keys(values).length === 0) delete document.secrets[owner];
      deleted = true;
    });
    return deleted;
  }

  async #read(): Promise<SecretDocument> {
    try {
      const parsed = JSON.parse(await readFile(this.#path, "utf8")) as Partial<SecretDocument>;
      return parsed.version === 1 && parsed.secrets && typeof parsed.secrets === "object"
        ? { version: 1, secrets: parsed.secrets }
        : structuredClone(EMPTY);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return structuredClone(EMPTY);
      throw error;
    }
  }

  async #mutate(change: (document: SecretDocument) => Promise<void>): Promise<void> {
    const run = this.#queue.then(async () => {
      const document = await this.#read();
      await change(document);
      await mkdir(dirname(this.#path), { recursive: true, mode: 0o700 });
      const temporary = `${this.#path}.tmp`;
      await writeFile(temporary, JSON.stringify(document), { encoding: "utf8", mode: 0o600 });
      await rename(temporary, this.#path);
      await chmod(this.#path, 0o600);
    });
    this.#queue = run.catch(() => undefined);
    return run;
  }
}
