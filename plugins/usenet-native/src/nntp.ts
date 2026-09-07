import { isIP } from "node:net";
import { connect as connectTls, type ConnectionOptions, type TLSSocket } from "node:tls";
import { setTimeout as delay } from "node:timers/promises";
import type { NntpArticle, NntpServerConfig, NntpTransport } from "./engine.js";

export type NntpErrorCode =
  | "NNTP_AUTH_FAILED"
  | "NNTP_BAD_RESPONSE"
  | "NNTP_CERTIFICATE"
  | "NNTP_CLOSED"
  | "NNTP_CONNECT_TIMEOUT"
  | "NNTP_RESPONSE_TOO_LARGE"
  | "NNTP_RESPONSE_TIMEOUT"
  | "ARTICLE_MISSING";

export class NntpError extends Error {
  readonly code: NntpErrorCode;

  constructor(code: NntpErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = "NntpError";
  }
}

export interface TlsNntpServerConfig extends NntpServerConfig {
  readonly tls: true;
  readonly ca?: string;
  readonly connectTimeoutMs?: number;
  readonly responseTimeoutMs?: number;
  readonly maxArticleBytes?: number;
}

interface LineWaiter {
  readonly resolve: (line: string) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
}

function boundedInteger(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new NntpError("NNTP_BAD_RESPONSE", `NNTP limit must be an integer from ${min} to ${max}`);
  }
  return value;
}

function safeMessageId(value: string): string {
  const id = value.trim();
  if (id.length === 0 || id.length > 998 || /[\r\n\0]/.test(id)) {
    throw new NntpError("NNTP_BAD_RESPONSE", "invalid NNTP message id");
  }
  return id.startsWith("<") && id.endsWith(">") ? id : `<${id}>`;
}

class NntpConnection {
  readonly #server: TlsNntpServerConfig;
  readonly #connectTimeoutMs: number;
  readonly #responseTimeoutMs: number;
  readonly #maxArticleBytes: number;
  #socket: TLSSocket | null = null;
  #buffer = "";
  readonly #lines: string[] = [];
  readonly #waiters: LineWaiter[] = [];
  #closed = false;

  constructor(server: TlsNntpServerConfig) {
    this.#server = server;
    this.#connectTimeoutMs = boundedInteger(server.connectTimeoutMs, 8_000, 250, 60_000);
    this.#responseTimeoutMs = boundedInteger(server.responseTimeoutMs, 12_000, 250, 120_000);
    this.#maxArticleBytes = boundedInteger(server.maxArticleBytes, 64 * 1024 * 1024, 1_024, 512 * 1024 * 1024);
  }

  get usable(): boolean {
    return !this.#closed && this.#socket !== null && !this.#socket.destroyed;
  }

  async connect(): Promise<void> {
    if (this.usable) return;
    if (this.#closed) throw new NntpError("NNTP_CLOSED", "NNTP connection is closed");

    const options: ConnectionOptions = {
      host: this.#server.host,
      port: this.#server.port,
      rejectUnauthorized: true,
      minVersion: "TLSv1.2",
      ...(this.#server.ca ? { ca: this.#server.ca } : {}),
      ...(isIP(this.#server.host) === 0 ? { servername: this.#server.host } : {}),
    };
    const socket = connectTls(options);
    this.#socket = socket;
    socket.setEncoding("latin1");
    socket.on("data", (chunk: string) => this.#onData(chunk));
    socket.on("error", (error) => this.#fail(error));
    socket.on("close", () => this.#fail(new NntpError("NNTP_CLOSED", "NNTP connection closed")));

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new NntpError("NNTP_CONNECT_TIMEOUT", "NNTP TLS connection timed out"));
      }, this.#connectTimeoutMs);
      const onSecure = () => {
        clearTimeout(timer);
        socket.off("error", onInitialError);
        resolve();
      };
      const onInitialError = (error: Error) => {
        clearTimeout(timer);
        socket.off("secureConnect", onSecure);
        const certificateFailure = /certificate|self[- ]signed|hostname|issuer|altname/i.test(error.message);
        reject(new NntpError(certificateFailure ? "NNTP_CERTIFICATE" : "NNTP_CLOSED", certificateFailure
          ? "NNTP TLS certificate validation failed"
          : "NNTP TLS connection failed"));
      };
      socket.once("secureConnect", onSecure);
      socket.once("error", onInitialError);
    });

    const greeting = await this.#readResponseLine();
    const greetingCode = this.#statusCode(greeting);
    if (greetingCode !== 200 && greetingCode !== 201) {
      this.destroy();
      throw new NntpError("NNTP_BAD_RESPONSE", `NNTP server rejected the connection (${greetingCode || "invalid response"})`);
    }
    await this.#authenticate();
  }

  async article(messageId: string): Promise<NntpArticle> {
    await this.connect();
    const id = safeMessageId(messageId);
    this.#write(`ARTICLE ${id}`);
    const status = await this.#readResponseLine();
    const code = this.#statusCode(status);
    if (code === 430) throw new NntpError("ARTICLE_MISSING", `article ${id} is unavailable on ${this.#server.name}`);
    if (code !== 220) throw new NntpError("NNTP_BAD_RESPONSE", `NNTP ARTICLE failed (${code || "invalid response"})`);

    const lines: string[] = [];
    let received = 0;
    for (;;) {
      const line = await this.#nextLine();
      if (line === ".") break;
      const decoded = line.startsWith("..") ? line.slice(1) : line;
      received += Buffer.byteLength(decoded, "latin1") + 2;
      if (received > this.#maxArticleBytes) {
        this.destroy();
        throw new NntpError("NNTP_RESPONSE_TOO_LARGE", `NNTP article exceeds ${this.#maxArticleBytes} bytes`);
      }
      lines.push(decoded);
    }

    const bodyStart = lines.indexOf("");
    const bodyLines = bodyStart >= 0 ? lines.slice(bodyStart + 1) : lines;
    return { messageId: id, body: `${bodyLines.join("\r\n")}\r\n` };
  }

  async close(): Promise<void> {
    if (this.usable) {
      try {
        this.#write("QUIT");
      } catch {
        // The connection is already unusable. destroy() below is authoritative.
      }
    }
    this.destroy();
  }

  destroy(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#socket?.destroy();
    this.#socket = null;
    this.#fail(new NntpError("NNTP_CLOSED", "NNTP connection closed"));
  }

  async #authenticate(): Promise<void> {
    if (!this.#server.username) return;
    if (!this.#server.password) {
      this.destroy();
      throw new NntpError("NNTP_AUTH_FAILED", "NNTP password is not configured");
    }
    this.#write(`AUTHINFO USER ${this.#server.username}`);
    const userResponse = await this.#readResponseLine();
    const userCode = this.#statusCode(userResponse);
    if (userCode === 281) return;
    if (userCode !== 381) {
      this.destroy();
      throw this.#authenticationError(userResponse);
    }
    this.#write(`AUTHINFO PASS ${this.#server.password}`);
    const passResponse = await this.#readResponseLine();
    const passCode = this.#statusCode(passResponse);
    if (passCode !== 281) {
      this.destroy();
      throw this.#authenticationError(passResponse);
    }
  }

  #authenticationError(response: string): NntpError {
    // Keep provider credentials and arbitrary server text out of operational events.
    const reason = /too many connections|connection limit|maximum.*connections|simultaneous/i.test(response)
      ? "connection limit reached"
      : /quota|download limit|bandwidth limit|traffic limit/i.test(response) ? "account download limit reached"
      : /expired|disabled|suspended|inactive/i.test(response) ? "account inactive"
      : /invalid.*(?:user|pass|credential)|incorrect.*(?:user|pass|credential)/i.test(response) ? "credentials rejected"
      : "access rejected";
    return new NntpError("NNTP_AUTH_FAILED", `NNTP authentication failed (${this.#statusCode(response) || "invalid response"}): ${reason}`);
  }

  #write(line: string): void {
    if (!this.usable || !this.#socket) throw new NntpError("NNTP_CLOSED", "NNTP connection is not open");
    if (/[\r\n\0]/.test(line)) throw new NntpError("NNTP_BAD_RESPONSE", "invalid NNTP command");
    this.#socket.write(`${line}\r\n`, "latin1");
  }

  async #readResponseLine(): Promise<string> {
    return this.#nextLine();
  }

  #statusCode(line: string): number {
    return /^\d{3}(?:\s|-)/.test(line) ? Number(line.slice(0, 3)) : 0;
  }

  #nextLine(): Promise<string> {
    const ready = this.#lines.shift();
    if (ready !== undefined) return Promise.resolve(ready);
    if (this.#closed) return Promise.reject(new NntpError("NNTP_CLOSED", "NNTP connection closed"));
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = this.#waiters.findIndex((waiter) => waiter.timer === timer);
        if (index >= 0) this.#waiters.splice(index, 1);
        this.destroy();
        reject(new NntpError("NNTP_RESPONSE_TIMEOUT", "NNTP server response timed out"));
      }, this.#responseTimeoutMs);
      this.#waiters.push({ resolve, reject, timer });
    });
  }

  #onData(chunk: string): void {
    this.#buffer += chunk;
    for (;;) {
      const end = this.#buffer.indexOf("\r\n");
      if (end < 0) break;
      const line = this.#buffer.slice(0, end);
      this.#buffer = this.#buffer.slice(end + 2);
      const waiter = this.#waiters.shift();
      if (waiter) {
        clearTimeout(waiter.timer);
        waiter.resolve(line);
      } else {
        this.#lines.push(line);
      }
    }
    if (Buffer.byteLength(this.#buffer, "latin1") > this.#maxArticleBytes) {
      this.destroy();
    }
  }

  #fail(error: Error): void {
    while (this.#waiters.length > 0) {
      const waiter = this.#waiters.shift()!;
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  }
}

interface PoolWaiter {
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
}

/**
 * Small bounded pool for one configured Usenet server. A connection handles
 * one ARTICLE command at a time and is reused after a successful response.
 */
export class TlsNntpTransport implements NntpTransport {
  readonly #server: TlsNntpServerConfig;
  readonly #maxConnections: number;
  readonly #connections = new Set<NntpConnection>();
  readonly #idle: NntpConnection[] = [];
  readonly #waiters: PoolWaiter[] = [];
  #active = 0;
  #closed = false;

  constructor(server: TlsNntpServerConfig) {
    if (!server.tls) throw new NntpError("NNTP_BAD_RESPONSE", "implicit TLS is required");
    if (!server.host || /[\r\n\0]/.test(server.host)) throw new NntpError("NNTP_BAD_RESPONSE", "invalid NNTP host");
    if (!Number.isInteger(server.port) || server.port < 1 || server.port > 65_535) {
      throw new NntpError("NNTP_BAD_RESPONSE", "invalid NNTP port");
    }
    this.#server = server;
    this.#maxConnections = boundedInteger(server.maxConnections, 2, 1, 32);
  }

  async connect(): Promise<void> {
    await this.#withConnection(async () => undefined);
  }

  async article(messageId: string): Promise<NntpArticle> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.#withConnection((connection) => connection.article(messageId));
      } catch (error) {
        const code = (error as { code?: string }).code ?? "";
        if (this.#closed || attempt >= 2 || !["NNTP_CLOSED", "NNTP_CONNECT_TIMEOUT", "NNTP_RESPONSE_TIMEOUT", "ECONNRESET", "ETIMEDOUT", "EPIPE", "ECONNREFUSED"].includes(code)) throw error;
        await delay(250 * 2 ** attempt);
      }
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    while (this.#waiters.length > 0) {
      const waiter = this.#waiters.shift()!;
      clearTimeout(waiter.timer);
      waiter.reject(new NntpError("NNTP_CLOSED", "NNTP transport closed"));
    }
    await Promise.allSettled([...this.#connections].map((connection) => connection.close()));
    this.#connections.clear();
    this.#idle.length = 0;
  }

  async #withConnection<T>(run: (connection: NntpConnection) => Promise<T>): Promise<T> {
    await this.#acquirePermit();
    let connection = this.#idle.pop();
    if (!connection) {
      connection = new NntpConnection(this.#server);
      this.#connections.add(connection);
    }
    try {
      await connection.connect();
      return await run(connection);
    } catch (error) {
      // A complete 430 response leaves the session usable. Reconnecting for every
      // missing article can hit provider connection limits during PAR2 recovery.
      if ((error as { code?: string }).code !== "ARTICLE_MISSING") {
        connection.destroy();
        this.#connections.delete(connection);
      }
      throw error;
    } finally {
      if (connection.usable && !this.#closed) this.#idle.push(connection);
      this.#releasePermit();
    }
  }

  #acquirePermit(): Promise<void> {
    if (this.#closed) return Promise.reject(new NntpError("NNTP_CLOSED", "NNTP transport closed"));
    if (this.#active < this.#maxConnections) {
      this.#active += 1;
      return Promise.resolve();
    }
    const timeoutMs = boundedInteger(this.#server.responseTimeoutMs, 12_000, 250, 120_000);
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = this.#waiters.findIndex((waiter) => waiter.timer === timer);
        if (index >= 0) this.#waiters.splice(index, 1);
        reject(new NntpError("NNTP_RESPONSE_TIMEOUT", "NNTP connection pool wait timed out"));
      }, timeoutMs);
      this.#waiters.push({ resolve, reject, timer });
    });
  }

  #releasePermit(): void {
    const waiter = this.#waiters.shift();
    if (waiter) {
      clearTimeout(waiter.timer);
      waiter.resolve();
      return;
    }
    this.#active = Math.max(0, this.#active - 1);
  }
}
