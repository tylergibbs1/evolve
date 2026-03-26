import { Database } from "bun:sqlite";
import { cp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  type AgentId,
  type ArchiveEntry,
  type ArchiveSummary,
  type DomainScore,
  agentId,
} from "./types.ts";
import { getAverageScore } from "./selection.ts";

/**
 * Archive backed by bun:sqlite.
 *
 * Every compiled variant enters the archive — there is no minimum score
 * threshold. The archive grows monotonically (matching the papers).
 *
 * Repo snapshots are stored as directories on disk. The SQLite database
 * stores metadata and scores for fast querying.
 */
export class Archive {
  private db: Database;
  private stmts: ReturnType<typeof prepareStatements>;

  constructor(private outputDir: string) {
    const dbPath = join(outputDir, "archive.db");
    this.db = new Database(dbPath);
    this.db.run("PRAGMA journal_mode = WAL");
    this.db.run("PRAGMA busy_timeout = 5000");
    this.db.run("PRAGMA synchronous = NORMAL");
    this.db.run("PRAGMA foreign_keys = ON");
    this.initSchema();
    this.stmts = prepareStatements(this.db);
  }

  private initSchema(): void {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS agents (
        id TEXT PRIMARY KEY,
        parent_id TEXT,
        generation INTEGER NOT NULL,
        repo_path TEXT NOT NULL,
        compiled_children_count INTEGER NOT NULL DEFAULT 0,
        valid_parent INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        diff_from_parent TEXT NOT NULL DEFAULT '',
        FOREIGN KEY (parent_id) REFERENCES agents(id)
      )
    `);
    // Migration: add valid_parent column if upgrading from older schema
    try {
      this.db.run("ALTER TABLE agents ADD COLUMN valid_parent INTEGER NOT NULL DEFAULT 1");
    } catch {
      // Column already exists
    }
    this.db.run(`
      CREATE TABLE IF NOT EXISTS scores (
        agent_id TEXT NOT NULL,
        domain TEXT NOT NULL,
        train_score REAL NOT NULL,
        validation_score REAL,
        test_score REAL,
        PRIMARY KEY (agent_id, domain),
        FOREIGN KEY (agent_id) REFERENCES agents(id)
      )
    `);
    this.db.run(
      "CREATE INDEX IF NOT EXISTS idx_agents_generation ON agents(generation)",
    );
  }

  /**
   * Add a new agent variant to the archive.
   *
   * The agent's repo directory is copied into the archive's output directory
   * to create an immutable snapshot.
   */
  async add(
    id: AgentId,
    parentId: AgentId | null,
    generation: number,
    repoPath: string,
    scores: DomainScore[],
    diff: string,
  ): Promise<void> {
    // Copy repo to archive storage
    const snapshotPath = join(this.outputDir, "snapshots", id);
    await mkdir(join(this.outputDir, "snapshots"), { recursive: true });
    await cp(repoPath, snapshotPath, { recursive: true });

    this.stmts.insertAgent.run(
      id,
      parentId,
      generation,
      snapshotPath,
      new Date().toISOString(),
      diff,
    );

    for (const score of scores) {
      this.stmts.insertScore.run(
        id,
        score.domain,
        score.trainScore,
        score.validationScore,
        score.testScore,
      );
    }
  }

  /** Increment the compiled children count for a parent agent. */
  incrementChildCount(parentId: AgentId): void {
    this.stmts.incrementChildren.run(parentId);
  }

  /**
   * Mark a parent as invalid so it won't be selected again.
   * Called when a child fails compilation — the parent consistently
   * produces broken lineages.
   */
  invalidateParent(parentId: AgentId): void {
    this.stmts.invalidateParent.run(parentId);
  }

  /** Get all entries in the archive. */
  entries(): ArchiveEntry[] {
    const rows = this.stmts.getAllAgents.all() as AgentRow[];
    return rows.map((row) => this.rowToEntry(row));
  }

  /** Get a single entry by ID. */
  get(id: AgentId): ArchiveEntry | null {
    const row = this.stmts.getAgent.get(id) as AgentRow | null;
    if (!row) return null;
    return this.rowToEntry(row);
  }

  /** Get the top-k agents by average score. */
  topK(k: number): ArchiveEntry[] {
    const all = this.entries();
    return all.sort((a, b) => getAverageScore(b) - getAverageScore(a)).slice(0, k);
  }

  /** Get the current size of the archive. */
  size(): number {
    const row = this.db.query("SELECT COUNT(*) as count FROM agents").get() as {
      count: number;
    };
    return row.count;
  }

  /** Generate a summary for the meta agent (no internal details exposed). */
  summary(): ArchiveSummary {
    const all = this.entries();
    if (all.length === 0) {
      return { totalAgents: 0, bestScore: 0, averageScore: 0, topAgents: [] };
    }

    const avgScores = all.map(getAverageScore);
    const sorted = [...all].sort(
      (a, b) => getAverageScore(b) - getAverageScore(a),
    );

    return {
      totalAgents: all.length,
      bestScore: Math.max(...avgScores),
      averageScore: avgScores.reduce((a, b) => a + b, 0) / avgScores.length,
      topAgents: sorted.slice(0, 5).map((e) => ({
        id: e.id,
        score: getAverageScore(e),
        generation: e.generation,
      })),
    };
  }

  /** Clean up and close the database. */
  close(): void {
    this.db.close();
  }

  private rowToEntry(row: AgentRow): ArchiveEntry {
    const scoreRows = this.stmts.getScores.all(row.id) as ScoreRow[];
    return {
      id: agentId(row.id),
      parentId: row.parent_id ? agentId(row.parent_id) : null,
      generation: row.generation,
      repoSnapshot: row.repo_path,
      scores: scoreRows.map((s) => ({
        domain: s.domain,
        trainScore: s.train_score,
        validationScore: s.validation_score,
        testScore: s.test_score,
      })),
      compiledChildrenCount: row.compiled_children_count,
      validParent: row.valid_parent === 1,
      metadata: {
        createdAt: new Date(row.created_at),
        diffFromParent: row.diff_from_parent,
      },
    };
  }
}

interface AgentRow {
  id: string;
  parent_id: string | null;
  generation: number;
  repo_path: string;
  compiled_children_count: number;
  valid_parent: number;
  created_at: string;
  diff_from_parent: string;
}

interface ScoreRow {
  domain: string;
  train_score: number;
  validation_score: number | null;
  test_score: number | null;
}

function prepareStatements(db: Database) {
  return {
    insertAgent: db.prepare(`
      INSERT INTO agents (id, parent_id, generation, repo_path, created_at, diff_from_parent)
      VALUES (?, ?, ?, ?, ?, ?)
    `),
    insertScore: db.prepare(`
      INSERT INTO scores (agent_id, domain, train_score, validation_score, test_score)
      VALUES (?, ?, ?, ?, ?)
    `),
    incrementChildren: db.prepare(`
      UPDATE agents SET compiled_children_count = compiled_children_count + 1 WHERE id = ?
    `),
    invalidateParent: db.prepare(`
      UPDATE agents SET valid_parent = 0 WHERE id = ?
    `),
    getAllAgents: db.prepare("SELECT * FROM agents ORDER BY generation ASC"),
    getAgent: db.prepare("SELECT * FROM agents WHERE id = ?"),
    getScores: db.prepare("SELECT * FROM scores WHERE agent_id = ?"),
  };
}
