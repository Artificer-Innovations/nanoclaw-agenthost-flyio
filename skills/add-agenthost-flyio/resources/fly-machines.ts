/**
 * Thin Fly Machines API client (injectable fetch for tests).
 * @see https://fly.io/docs/machines/api/
 */
import { FLY_MACHINES_API_BASE } from "./fly-shared.js";

export type FetchLike = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

export interface FlyMachinesClientOptions {
  token: string;
  app: string;
  apiBase?: string;
  fetchImpl?: FetchLike;
  /** Max retries on 429 / network errors. */
  maxRetries?: number;
  sleep?: (ms: number) => Promise<void>;
}

export interface FlyVolume {
  id: string;
  name: string;
  region: string;
  size_gb: number;
  state?: string;
}

export interface FlyMachine {
  id: string;
  name?: string;
  state?: string;
  region?: string;
  config?: Record<string, unknown>;
}

export interface CreateVolumeInput {
  name: string;
  region: string;
  sizeGb: number;
}

export interface CreateMachineInput {
  name: string;
  region: string;
  image: string;
  env: Record<string, string>;
  volumeId: string;
  volumeMountPath?: string;
  files?: Array<{ guestPath: string; rawValue: string }>;
  cpus?: number;
  memoryMb?: number;
}

/* v8 ignore start */
function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
/* v8 ignore stop */

export class FlyMachinesClient {
  readonly app: string;
  private readonly token: string;
  private readonly apiBase: string;
  private readonly fetchImpl: FetchLike;
  private readonly maxRetries: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(opts: FlyMachinesClientOptions) {
    this.token = opts.token;
    this.app = opts.app;
    this.apiBase = (opts.apiBase ?? FLY_MACHINES_API_BASE).replace(/\/$/, "");
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.maxRetries = opts.maxRetries ?? 3;
    this.sleep = opts.sleep ?? defaultSleep;
  }

  async createVolume(input: CreateVolumeInput): Promise<FlyVolume> {
    const existing = await this.findVolumeByName(input.name);
    if (existing) return existing;
    try {
      return await this.request<FlyVolume>(
        "POST",
        `/apps/${this.app}/volumes`,
        {
          name: input.name,
          region: input.region,
          size_gb: input.sizeGb,
        },
        { retryNetwork: false },
      );
    } catch (error) {
      // Name collision or ambiguous network after server-side success — reuse.
      const again = await this.findVolumeByName(input.name);
      if (again) return again;
      throw error;
    }
  }

  async getVolume(volumeId: string): Promise<FlyVolume> {
    return this.request<FlyVolume>(
      "GET",
      `/apps/${this.app}/volumes/${volumeId}`,
    );
  }

  async listVolumes(): Promise<FlyVolume[]> {
    const rows = await this.request<FlyVolume[]>(
      "GET",
      `/apps/${this.app}/volumes`,
    );
    return Array.isArray(rows) ? rows : [];
  }

  async findVolumeByName(name: string): Promise<FlyVolume | undefined> {
    const volumes = await this.listVolumes();
    // After teardown, Fly keeps the old name visible in pending_destroy /
    // scheduling_destroy for a while. Reusing those IDs makes createMachine
    // fail with "volume not found". Only reuse attachable volumes so
    // createVolume can mint a fresh one under the same name.
    return volumes.find((v) => {
      if (v.name !== name) return false;
      const state = (v.state ?? "").toLowerCase();
      return !state.includes("destroy") && state !== "dead";
    });
  }

  async createMachine(input: CreateMachineInput): Promise<FlyMachine> {
    const existing = await this.findMachineByName(input.name);
    if (existing) return existing;
    const files = (input.files ?? []).map((f) => ({
      guest_path: f.guestPath,
      raw_value: Buffer.from(f.rawValue, "utf8").toString("base64"),
    }));
    try {
      return await this.request<FlyMachine>(
        "POST",
        `/apps/${this.app}/machines`,
        {
          name: input.name,
          region: input.region,
          config: {
            image: input.image,
            env: input.env,
            auto_destroy: false,
            restart: { policy: "no" },
            guest: {
              cpus: input.cpus ?? 1,
              cpu_kind: "shared",
              memory_mb: input.memoryMb ?? 1024,
            },
            mounts: [
              {
                volume: input.volumeId,
                path: input.volumeMountPath ?? "/workspace",
              },
            ],
            files,
            // NanoClaw owns start/stop — disable Fly autostop.
            services: [],
          },
        },
        { retryNetwork: false },
      );
    } catch (error) {
      const again = await this.findMachineByName(input.name);
      if (again) return again;
      throw error;
    }
  }

  async listMachines(): Promise<FlyMachine[]> {
    const rows = await this.request<FlyMachine[]>(
      "GET",
      `/apps/${this.app}/machines`,
    );
    return Array.isArray(rows) ? rows : [];
  }

  async findMachineByName(name: string): Promise<FlyMachine | undefined> {
    const machines = await this.listMachines();
    return machines.find((m) => m.name === name);
  }

  async getMachine(machineId: string): Promise<FlyMachine> {
    return this.request<FlyMachine>(
      "GET",
      `/apps/${this.app}/machines/${machineId}`,
    );
  }

  async startMachine(machineId: string): Promise<void> {
    await this.request<unknown>(
      "POST",
      `/apps/${this.app}/machines/${machineId}/start`,
    );
  }

  async stopMachine(machineId: string): Promise<void> {
    await this.request<unknown>(
      "POST",
      `/apps/${this.app}/machines/${machineId}/stop`,
    );
  }

  /** Permanently delete a Machine (stops billing for the guest). */
  async deleteMachine(machineId: string, force = true): Promise<void> {
    const q = force ? "?force=true" : "";
    await this.request<unknown>(
      "DELETE",
      `/apps/${this.app}/machines/${machineId}${q}`,
      undefined,
      { retryNetwork: false },
    );
  }

  /** Permanently delete a Volume (stops billing for retained disk). */
  async deleteVolume(volumeId: string): Promise<void> {
    await this.request<unknown>(
      "DELETE",
      `/apps/${this.app}/volumes/${volumeId}`,
      undefined,
      { retryNetwork: false },
    );
  }

  async waitMachine(
    machineId: string,
    state: string,
    // Fly Machines API caps WaitMachineRequest.Timeout at 60s.
    timeoutSec = 60,
  ): Promise<FlyMachine> {
    const capped = Math.min(60, Math.max(1, timeoutSec));
    return this.request<FlyMachine>(
      "GET",
      `/apps/${this.app}/machines/${machineId}/wait?state=${encodeURIComponent(state)}&timeout=${capped}`,
    );
  }

  async updateMachineEnv(
    machineId: string,
    config: Record<string, unknown>,
  ): Promise<FlyMachine> {
    return this.request<FlyMachine>(
      "POST",
      `/apps/${this.app}/machines/${machineId}`,
      { config },
    );
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    opts: { retryNetwork?: boolean; timeoutMs?: number } = {},
  ): Promise<T> {
    const retryNetwork = opts.retryNetwork ?? true;
    const timeoutMs = opts.timeoutMs ?? 30_000;
    let attempt = 0;
    let lastError: unknown;
    while (attempt <= this.maxRetries) {
      try {
        const response = await this.fetchImpl(`${this.apiBase}${path}`, {
          method,
          headers: {
            Authorization: `Bearer ${this.token}`,
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (response.status === 429 && attempt < this.maxRetries) {
          const retryAfter = Number(response.headers.get("retry-after") ?? "1");
          await this.sleep(Math.max(250, retryAfter * 1000));
          attempt += 1;
          continue;
        }
        if (!response.ok) {
          const text = await response.text().catch(() => "");
          throw new Error(
            `Fly Machines API ${method} ${path} failed: ${response.status} ${text}`,
          );
        }
        if (response.status === 204) return undefined as T;
        const text = await response.text();
        if (!text) return undefined as T;
        return JSON.parse(text) as T;
      } catch (error) {
        lastError = error;
        const isNetwork =
          error instanceof TypeError ||
          (error instanceof Error &&
            /fetch|network|ECONN|TimeoutError|aborted|AbortError/i.test(
              error.message,
            ));
        if (!isNetwork || !retryNetwork || attempt >= this.maxRetries) {
          throw error;
        }
        // Jitter so concurrent wakes don't retry Fly in lockstep.
        await this.sleep(250 * 2 ** attempt * (0.5 + Math.random()));
        attempt += 1;
      }
    }
    /* v8 ignore start — loop always throws or returns before falling through */
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
    /* v8 ignore stop */
  }
}

export function createFlyMachinesClientFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  overrides: Partial<FlyMachinesClientOptions> = {},
): FlyMachinesClient {
  const token = (overrides.token ?? env.FLY_API_TOKEN ?? "").trim();
  const app = (overrides.app ?? env.FLY_APP_AGENTS ?? "").trim();
  if (!token) throw new Error("FLY_API_TOKEN is required for fly runtime");
  if (!app) throw new Error("FLY_APP_AGENTS is required for fly runtime");
  return new FlyMachinesClient({
    token,
    app,
    apiBase: overrides.apiBase ?? env.FLY_MACHINES_API_BASE,
    fetchImpl: overrides.fetchImpl,
    maxRetries: overrides.maxRetries,
    sleep: overrides.sleep,
  });
}
