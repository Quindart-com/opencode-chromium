import { generateKeyPairSync, randomUUID } from "node:crypto";
import { z } from "zod";
import { configuredRegistryOrigin, signedRegistryRequest } from "../../../src/site-registry/client.ts";
import { patternForPage, patternWindow, validPattern, type PatternSite } from "../../../src/site-registry/patterns.ts";
import { inTransaction } from "./config.ts";
import type { Database } from "./database.ts";

const signerRow = z.object({ id: z.string(), site: z.enum(["hacker-news", "npm"]), period: z.number(),
  grant_id: z.string(), secret: z.string(), withdrawing: z.number(), attempts: z.number() });
type TabInfo = { id?: unknown; url?: unknown; incognito?: unknown; controlled?: unknown; sessionId?: unknown; pendingUrl?: unknown };
type Ticket = { profile: string; sessionId: string; tabId: number; url: string; grant: string; site: PatternSite; task: string; until: number };
type Dependencies = { origin(): string; now(): number; send: typeof signedRegistryRequest;
  tab(sessionId: string, tabId: number): Promise<TabInfo>; activeProfile(): string | null; recording(): boolean };
type Options = Pick<Dependencies, "tab" | "activeProfile" | "recording"> & Partial<Dependencies>;

export class PatternSharing {
  private readonly deps: Dependencies;
  private readonly tickets = new Map<string, Ticket>();
  private sending: { profile: string; controller: AbortController } | null = null;
  constructor(private db: Database, options: Options) {
    this.deps = { now: Date.now, send: signedRegistryRequest, origin: configuredRegistryOrigin, ...options };
    db.exec(`
      CREATE TABLE IF NOT EXISTS pattern_consent_v1 (
        profile TEXT NOT NULL, origin TEXT NOT NULL, grant_id TEXT NOT NULL, PRIMARY KEY(profile, origin));
      CREATE TABLE IF NOT EXISTS pattern_signers_v1 (
        id TEXT PRIMARY KEY, profile TEXT NOT NULL, origin TEXT NOT NULL, grant_id TEXT NOT NULL,
        site TEXT NOT NULL, period INTEGER NOT NULL, secret TEXT NOT NULL, withdrawing INTEGER NOT NULL DEFAULT 0,
        attempted INTEGER NOT NULL DEFAULT 0, due INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0,
        UNIQUE(profile, origin, grant_id, site, period));
      CREATE INDEX IF NOT EXISTS pattern_due_v1 ON pattern_signers_v1(profile,origin,due);
      CREATE TABLE IF NOT EXISTS pattern_tasks_v1 (
        signer TEXT NOT NULL REFERENCES pattern_signers_v1(id) ON DELETE CASCADE,
        task TEXT NOT NULL, delivered INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(signer,task));
      CREATE TABLE IF NOT EXISTS pattern_preferences_v1 (profile TEXT PRIMARY KEY);
      INSERT OR IGNORE INTO pattern_preferences_v1 SELECT profile FROM pattern_consent_v1;
      INSERT OR IGNORE INTO pattern_preferences_v1 SELECT profile FROM pattern_signers_v1 WHERE withdrawing=1;`);
  }

  private origin() {
    try { return this.deps.origin(); } catch { return null; }
  }
  grant(profile: string) {
    const origin = this.origin();
    if (!origin) return null;
    const row = this.db.prepare("SELECT grant_id FROM pattern_consent_v1 WHERE profile=? AND origin=?").get(profile, origin);
    return row ? z.object({ grant_id: z.string() }).parse(row).grant_id : null;
  }
  /** True once the profile has chosen a contribution setting, even if it later turned sharing off. */
  chosen(profile: string) {
    return Boolean(this.db.prepare("SELECT 1 FROM pattern_preferences_v1 WHERE profile=?").get(profile));
  }
  /**
   * Turning on Action Memory next to its sharing note is the agreement. Profiles that
   * already chose keep their setting, so an opt-out survives later Action Memory changes.
   */
  applyDefault(profile: string) {
    const origin = this.origin();
    if (!origin) return false;
    inTransaction(this.db, () => {
      const inserted = this.db.prepare("INSERT OR IGNORE INTO pattern_preferences_v1 VALUES(?)").run(profile);
      if (Number(inserted.changes)) {
        this.db.prepare("INSERT INTO pattern_consent_v1 VALUES(?,?,?)").run(profile, origin, randomUUID());
      }
    });
    return true;
  }
  configure(profile: string, enable: boolean) {
    const origin = this.origin();
    if (enable && !origin) throw Error("Configure the registry before enabling pattern sharing.");
    inTransaction(this.db, () => {
      this.db.prepare("INSERT OR IGNORE INTO pattern_preferences_v1 VALUES(?)").run(profile);
      if (enable && origin) {
        this.db.prepare("INSERT OR IGNORE INTO pattern_consent_v1 VALUES(?,?,?)").run(profile, origin, randomUUID());
      } else {
        // Also revoke a previously configured destination after a destination change.
        this.db.prepare("DELETE FROM pattern_consent_v1 WHERE profile=?").run(profile);
        this.db.prepare("DELETE FROM pattern_signers_v1 WHERE profile=? AND attempted=0").run(profile);
        this.db.prepare("DELETE FROM pattern_tasks_v1 WHERE signer IN (SELECT id FROM pattern_signers_v1 WHERE profile=?)").run(profile);
        this.db.prepare("UPDATE pattern_signers_v1 SET withdrawing=1,due=0,attempts=0 WHERE profile=?").run(profile);
      }
    });
    if (!enable) {
      if (this.sending?.profile === profile) this.sending.controller.abort();
      for (const [key, ticket] of this.tickets) if (ticket.profile === profile) this.tickets.delete(key);
    }
    return Boolean(this.grant(profile));
  }

  private async page(profile: string, sessionId: string, tabId: number) {
    if (this.deps.activeProfile() !== profile || !this.deps.recording()) return null;
    const tab = await this.deps.tab(sessionId, tabId);
    return this.deps.activeProfile() === profile && tab.id === tabId && tab.controlled === true &&
      tab.incognito === false && !tab.pendingUrl && tab.sessionId === sessionId && typeof tab.url === "string" ? tab.url : null;
  }
  async begin(profile: string, grant: string, sessionId: string, tabId: number, label: string) {
    if (label.length > 120 || this.grant(profile) !== grant) return null;
    const url = await this.page(profile, sessionId, tabId);
    const pattern = url && patternForPage(url, label);
    if (!url || !pattern || this.grant(profile) !== grant) return null;
    const id = randomUUID();
    if (this.tickets.size >= 128) this.tickets.delete(this.tickets.keys().next().value!);
    this.tickets.set(id, { profile, sessionId, tabId, url, grant, ...pattern, until: this.deps.now() + 60000 });
    return id;
  }
  async confirm(profile: string, id: string, sessionId: string, tabId: number, observation?: { url: string; record(site: PatternSite, task: string): boolean }) {
    const ticket = this.tickets.get(id);
    this.tickets.delete(id);
    if (!ticket || ticket.profile !== profile || ticket.sessionId !== sessionId || ticket.tabId !== tabId ||
        ticket.until < this.deps.now() || ticket.grant !== this.grant(profile)) return;
    if ((observation && observation.url !== ticket.url) || await this.page(profile, sessionId, tabId) !== ticket.url) return;
    const origin = this.origin();
    if (!origin) return;
    inTransaction(this.db, () => {
      if (ticket.grant !== this.grant(profile) || !this.deps.recording() || this.deps.activeProfile() !== profile) return;
      if (observation && !observation.record(ticket.site, ticket.task)) return;
      const period = patternWindow(this.deps.now());
      const key = [profile, origin, ticket.grant, ticket.site, period] as const;
      const existing = this.db.prepare("SELECT id FROM pattern_signers_v1 WHERE profile=? AND origin=? AND grant_id=? AND site=? AND period=?").get(...key);
      const signer = existing ? z.object({ id: z.string() }).parse(existing).id : randomUUID();
      if (!existing) {
        const pem = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
        this.db.prepare("INSERT INTO pattern_signers_v1(id,profile,origin,grant_id,site,period,secret) VALUES(?,?,?,?,?,?,?)").run(signer, ...key, pem);
      }
      this.db.prepare("INSERT OR IGNORE INTO pattern_tasks_v1(signer,task) VALUES(?,?)").run(signer, ticket.task);
    });
  }

  async flush() {
    if (this.sending) return;
    const profile = this.deps.activeProfile(), origin = this.origin(), now = this.deps.now();
    this.db.prepare("DELETE FROM pattern_signers_v1 WHERE period < ?").run(patternWindow(now) - 1);
    if (!profile || !origin) return;
    const grant = this.grant(profile);
    const pending = this.db.prepare(`SELECT * FROM pattern_signers_v1 s WHERE profile=? AND origin=? AND due<=? AND
      (withdrawing=1 OR (grant_id=? AND EXISTS(SELECT 1 FROM pattern_tasks_v1 t WHERE t.signer=s.id AND delivered=0)))
      ORDER BY withdrawing DESC, due LIMIT 1`).get(profile, origin, now, this.deps.recording() ? grant : null);
    if (!pending) return;
    const row = signerRow.parse(pending);
    const tasks = this.db.prepare("SELECT task FROM pattern_tasks_v1 WHERE signer=? AND delivered=0 ORDER BY task LIMIT 8").all(row.id)
      .map(value => z.object({ task: z.string() }).parse(value).task);
    if (!row.withdrawing && (!tasks.length || !tasks.every(task => validPattern(row.site, task)))) return;
    const payload = { v: 1, site: row.site, window: row.period, ...(row.withdrawing ? {} : { tasks }) };
    const controller = new AbortController();
    this.sending = { profile, controller };
    try {
      // Claim before transport. If the host dies after sending, opt-out still schedules deletion.
      const lease = this.db.prepare("UPDATE pattern_signers_v1 SET attempted=1,due=? WHERE id=? AND due<=? AND withdrawing=? AND (withdrawing=1 OR EXISTS(SELECT 1 FROM pattern_consent_v1 WHERE profile=? AND origin=? AND grant_id=?))")
        .run(now + 60000, row.id, now, row.withdrawing, profile, origin, row.grant_id);
      if (!Number(lease.changes)) return;
      const result = await this.deps.send(origin, row.withdrawing ? "forget-patterns" : "patterns", payload, row.secret, controller.signal);
      z.strictObject({ ok: z.literal(true) }).parse(result);
      inTransaction(this.db, () => {
        if (row.withdrawing) this.db.prepare("DELETE FROM pattern_signers_v1 WHERE id=?").run(row.id);
        else {
          for (const task of tasks) this.db.prepare("UPDATE pattern_tasks_v1 SET delivered=1 WHERE signer=? AND task=?").run(row.id, task);
          this.db.prepare("UPDATE pattern_signers_v1 SET attempts=0,due=0 WHERE id=? AND withdrawing=0").run(row.id);
        }
      });
    } catch {
      const delay = Math.min(24 * 3600000, 60000 * 2 ** Math.min(11, row.attempts));
      this.db.prepare("UPDATE pattern_signers_v1 SET due=?,attempts=attempts+1 WHERE id=? AND withdrawing=?").run(now + delay, row.id, row.withdrawing);
    } finally { this.sending = null; }
  }
  close() {
    this.tickets.clear();
    this.sending?.controller.abort();
  }
}
