import pg from "pg";
import type { Pool as PoolType, PoolConfig } from "pg";

const { Pool } = pg;

export interface DatabaseBoundary {
  readonly configured: boolean;
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: T[] }>;
  transaction?<T>(callback: (database: DatabaseBoundary) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

class UnconfiguredDatabase implements DatabaseBoundary {
  readonly configured = false;

  async query(): Promise<{ rows: never[] }> {
    throw new Error("database_not_configured");
  }

  async close(): Promise<void> {}
}

class PostgresDatabase implements DatabaseBoundary {
  readonly configured = true;

  constructor(private readonly pool: PoolType) {}

  async query<T extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: T[] }> {
    const result = await this.pool.query<T>(text, values ? [...values] : undefined);
    return { rows: result.rows };
  }

  async transaction<T>(callback: (database: DatabaseBoundary) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    const transactionDatabase: DatabaseBoundary = {
      configured: true,
      query: async <R extends Record<string, unknown> = Record<string, unknown>>(text: string, values?: readonly unknown[]) => {
        const result = await client.query<R>(text, values ? [...values] : undefined);
        return { rows: result.rows };
      },
      close: async () => {},
    };
    try {
      await client.query("BEGIN");
      const result = await callback(transactionDatabase);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

export function createDatabase(databaseUrl: string | undefined, ssl: boolean): DatabaseBoundary {
  if (!databaseUrl) return new UnconfiguredDatabase();
  const poolConfig: PoolConfig = { connectionString: databaseUrl, max: 10 };
  if (ssl) poolConfig.ssl = { rejectUnauthorized: true };
  return new PostgresDatabase(new Pool(poolConfig));
}
