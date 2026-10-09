import pg from "pg";

/*
 * The studio's own Postgres, reached directly (phase 5 spec §4). One small client for the web app, the worker,
 * the owner's commands and the tests: it runs a function (`rpc`), reads or writes rows (`from`), or runs SQL.
 *
 * A client made with `as(userId)` runs every statement in a transaction of its own in which the database is
 * told who is asking (`app.user_id`). The setting lasts for that transaction only, so a pooled connection can
 * never carry one visitor's identity into another's statement. A client without a user sets nothing: the
 * database's functions then see nobody, and row-level security shows it no rows.
 */

export type DbError = { message: string; code?: string };
/** Either the answer or why there is none: checking `error` is what tells them apart. */
export type Result<T> = { data: T; error: null } | { data: null; error: DbError };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const NAME = /^[a-z_][a-z0-9_]*$/;
const OID = { int8: 20, numeric: 1700, timestamptz: 1184, timestamp: 1114, void: 2278 };

/** A table, column or function name, as it may be put into SQL: plain lower-case names only, always quoted. */
function ident(name: string): string {
  if (!NAME.test(name)) throw new Error(`not a plain name: ${JSON.stringify(name)}`);
  return `"${name}"`;
}

/** `fn` or `schema.fn`; a bare name is in `public`. */
function qualified(name: string): { sql: string; bare: string } {
  const parts = name.split(".");
  if (parts.length > 2) throw new Error(`not a function name: ${JSON.stringify(name)}`);
  const [schema, bare] = parts.length === 2 ? parts : ["public", parts[0]];
  return { sql: `${ident(schema)}.${ident(bare)}`, bare };
}

/**
 * Amounts as numbers and times as ISO strings, the way the rest of the code has always been given them. (Money
 * is numeric(12,4) in the database and is compared in ten-thousandths in the code: a double holds it exactly
 * enough to round back, and nothing is added up in JavaScript without rounding.)
 */
const types: pg.CustomTypesConfig = {
  getTypeParser: ((oid: number, format?: string) => {
    if (format !== "binary") {
      if (oid === OID.numeric) return (v: string) => Number(v);
      if (oid === OID.int8) return (v: string) => Number(v);
      if (oid === OID.timestamptz) return (v: string) => (pg.types.getTypeParser(OID.timestamptz) as (v: string) => Date)(v).toISOString();
      if (oid === OID.void) return () => null;
    }
    return pg.types.getTypeParser(oid, format as "text");
  }) as pg.CustomTypesConfig["getTypeParser"],
};

const failure = (err: unknown): DbError => {
  const e = err as { message?: string; code?: string };
  return { message: e?.message ?? String(err), ...(e?.code ? { code: e.code } : {}) };
};

type Filter = { column: string; op: "=" | "<" | ">" | "<=" | ">=" | "<>" | "in" | "is null"; value?: unknown };

/** One read or write of a table, built step by step and run when awaited. */
export class Query<T = Record<string, unknown>> implements PromiseLike<Result<T[]>> {
  private columns = "*";
  private filters: Filter[] = [];
  private sort: Array<{ column: string; ascending: boolean }> = [];
  private max?: number;
  private action: { kind: "select" } | { kind: "insert"; rows: Record<string, unknown>[] } | { kind: "update"; values: Record<string, unknown> } | { kind: "delete" } = { kind: "select" };
  private returning = false;

  constructor(private readonly db: Db, private readonly table: string) {}

  /** The columns to read: `"a,b"` or `"*"`. After `insert`, `update` or `delete`, asks for the rows they touched. */
  select(columns = "*"): this {
    this.columns = columns.trim() === "*" ? "*" : columns.split(",").map((c) => ident(c.trim())).join(", ");
    if (this.action.kind !== "select") this.returning = true;
    return this;
  }
  insert(rows: Record<string, unknown> | Record<string, unknown>[]): this {
    this.action = { kind: "insert", rows: Array.isArray(rows) ? rows : [rows] };
    return this;
  }
  update(values: Record<string, unknown>): this {
    this.action = { kind: "update", values };
    return this;
  }
  delete(): this {
    this.action = { kind: "delete" };
    return this;
  }
  private where(column: string, op: Filter["op"], value?: unknown): this {
    this.filters.push({ column, op, value });
    return this;
  }
  eq(column: string, value: unknown): this {
    return value === null ? this.where(column, "is null") : this.where(column, "=", value);
  }
  neq = (column: string, value: unknown): this => this.where(column, "<>", value);
  lt = (column: string, value: unknown): this => this.where(column, "<", value);
  gt = (column: string, value: unknown): this => this.where(column, ">", value);
  lte = (column: string, value: unknown): this => this.where(column, "<=", value);
  gte = (column: string, value: unknown): this => this.where(column, ">=", value);
  in = (column: string, values: unknown[]): this => this.where(column, "in", values);
  order(column: string, opts: { ascending?: boolean } = {}): this {
    this.sort.push({ column, ascending: opts.ascending ?? true });
    return this;
  }
  limit(n: number): this {
    this.max = n;
    return this;
  }

  private build(): { sql: string; params: unknown[] } {
    const params: unknown[] = [];
    const p = (value: unknown) => `$${params.push(value)}`;
    const table = `public.${ident(this.table)}`;
    const where = this.filters.length
      ? ` where ${this.filters
          .map((f) =>
            f.op === "is null" ? `${ident(f.column)} is null` : f.op === "in" ? `${ident(f.column)} = any(${p(f.value)})` : `${ident(f.column)} ${f.op} ${p(f.value)}`,
          )
          .join(" and ")}`
      : "";
    const back = this.returning ? ` returning ${this.columns}` : "";
    if (this.action.kind === "insert") {
      const rows = this.action.rows;
      if (rows.length === 0) throw new Error("nothing to insert");
      const names = Object.keys(rows[0]);
      const values = rows.map((row) => `(${names.map((name) => p(row[name])).join(", ")})`).join(", ");
      return { sql: `insert into ${table} (${names.map(ident).join(", ")}) values ${values}${back}`, params };
    }
    if (this.action.kind === "update") {
      const sets = Object.entries(this.action.values).map(([name, value]) => `${ident(name)} = ${p(value)}`).join(", ");
      return { sql: `update ${table} set ${sets}${where}${back}`, params };
    }
    if (this.action.kind === "delete") return { sql: `delete from ${table}${where}${back}`, params };
    const order = this.sort.length ? ` order by ${this.sort.map((s) => `${ident(s.column)} ${s.ascending ? "asc" : "desc"}`).join(", ")}` : "";
    const limit = this.max === undefined ? "" : ` limit ${p(this.max)}`;
    return { sql: `select ${this.columns} from ${table}${where}${order}${limit}`, params };
  }

  private async run(): Promise<Result<T[]>> {
    try {
      const { sql, params } = this.build();
      return { data: await this.db.query<T>(sql, params), error: null };
    } catch (err) {
      return { data: null, error: failure(err) };
    }
  }
  then<A = Result<T[]>, B = never>(ok?: ((value: Result<T[]>) => A | PromiseLike<A>) | null, fail?: ((reason: unknown) => B | PromiseLike<B>) | null): PromiseLike<A | B> {
    return this.run().then(ok, fail);
  }
  /** Exactly one row, or an error. */
  async single(): Promise<Result<T>> {
    const { data, error } = await this.run();
    if (error) return { data: null, error };
    if (data.length !== 1) return { data: null, error: { message: `expected one row, found ${data.length}`, code: "ONE_ROW" } };
    return { data: data[0], error: null };
  }
  /** One row, or null when there is none. */
  async maybeSingle(): Promise<Result<T | null>> {
    const { data, error } = await this.run();
    if (error) return { data: null, error };
    if (data.length > 1) return { data: null, error: { message: `expected at most one row, found ${data.length}`, code: "ONE_ROW" } };
    return { data: data[0] ?? null, error: null };
  }
}

export class Db {
  private constructor(private readonly pool: pg.Pool, private readonly userId?: string) {}

  /** `max`: connections kept at most; a web process serves many visitors, a command needs one. */
  static connect(url: string, opts: { max?: number } = {}): Db {
    // allowExitOnIdle: a command or a test that has finished is not kept alive by connections nobody is using
    const pool = new pg.Pool({ connectionString: url, max: opts.max ?? 10, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 10_000, allowExitOnIdle: true, types });
    // a connection that drops while idle must not take the process down with it; the next query gets a new one
    pool.on("error", () => {});
    return new Db(pool);
  }

  /** The same pool, asking as this user. The id must come from a verified session or a job's checked data. */
  as(userId: string): Db {
    if (!UUID.test(userId)) throw new Error("a user id must be a UUID");
    return new Db(this.pool, userId);
  }

  /** Runs one statement; throws what the database raised (`message` is a function's own word, e.g. `insufficient_credit`). */
  async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
    return (await this.raw(sql, params)).rows as T[];
  }

  private async raw(sql: string, params: unknown[]): Promise<pg.QueryResult> {
    if (!this.userId) return this.pool.query(sql, params);
    const client = await this.pool.connect();
    let broken = false;
    try {
      await client.query("begin");
      // `true`: for this transaction only
      await client.query("select set_config('app.user_id', $1, true)", [this.userId]);
      const result = await client.query(sql, params);
      await client.query("commit");
      return result;
    } catch (err) {
      await client.query("rollback").catch(() => {
        // a connection that cannot even roll back is not put back among the others
        broken = true;
      });
      throw err;
    } finally {
      client.release(broken);
    }
  }

  /**
   * Calls a function with named arguments. `data` is its value: a scalar, null for one that returns nothing, or
   * its rows when it returns a table.
   */
  async rpc<T = unknown>(name: string, args: Record<string, unknown> = {}): Promise<Result<T>> {
    try {
      const fn = qualified(name);
      const names = Object.keys(args);
      const list = names.map((arg, i) => `${ident(arg)} => $${i + 1}`).join(", ");
      const result = await this.raw(`select * from ${fn.sql}(${list})`, names.map((arg) => args[arg]));
      const scalar = result.fields.length === 1 && result.fields[0].name === fn.bare;
      const data = scalar ? ((result.rows[0] as Record<string, unknown> | undefined)?.[fn.bare] ?? null) : result.rows;
      return { data: data as T, error: null };
    } catch (err) {
      return { data: null, error: failure(err) };
    }
  }

  from<T = Record<string, unknown>>(table: string): Query<T> {
    return new Query<T>(this, table);
  }

  async end(): Promise<void> {
    await this.pool.end();
  }
}
