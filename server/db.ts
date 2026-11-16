import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Transfer } from './providers/types.ts';

export type FetchMode = 'recent' | 'oldest' | 'payers';
export type AccountKind = 'wallet' | 'program';

export interface FetchState {
  fetchedAt: number;
  rowLimit: number;
  rows: number;
  complete: boolean;
  /** Самый свежий слот, загруженный этим запросом: с него продолжается догрузка новых переводов. */
  topSlot?: number | null;
}

/** Покупки одного токена в одном слоте разными транзакциями: кошелёк → совпадения. */
export interface CoBuy {
  wallet: string;
  mints: Set<string>;
  slots: Set<number>;
  /** Покупки цели и этого кошелька, давшие совпадение. */
  records: Transfer[];
}

/** SOL и стейблкоины — не «покупки токена». */
const NOT_TOKENS = [
  'So11111111111111111111111111111111111111111',
  'So11111111111111111111111111111111111111112',
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
];

const CHUNK = 400;

/**
 * Кэш в SQLite. Все загруженные переводы лежат в одной таблице, поэтому история любого кошелька,
 * загруженная однажды, служит обратным индексом для всех следующих поисков.
 */
export function createDb(file: string) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA busy_timeout = 10000;
    CREATE TABLE IF NOT EXISTS transfers (
      key TEXT PRIMARY KEY,
      signature TEXT NOT NULL,
      slot INTEGER NOT NULL,
      block_time INTEGER,
      from_addr TEXT NOT NULL,
      to_addr TEXT NOT NULL,
      mint TEXT NOT NULL,
      amount_raw TEXT NOT NULL,
      decimals INTEGER NOT NULL,
      ui_amount REAL NOT NULL
    );
    CREATE INDEX IF NOT EXISTS transfers_from ON transfers(from_addr);
    CREATE INDEX IF NOT EXISTS transfers_to ON transfers(to_addr);
    CREATE INDEX IF NOT EXISTS transfers_mint_slot ON transfers(mint, slot);
    CREATE TABLE IF NOT EXISTS fetches (
      address TEXT NOT NULL,
      mode TEXT NOT NULL,
      fetched_at INTEGER NOT NULL,
      row_limit INTEGER NOT NULL,
      rows INTEGER NOT NULL,
      complete INTEGER NOT NULL,
      PRIMARY KEY (address, mode)
    );
    CREATE TABLE IF NOT EXISTS accounts (
      address TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      checked_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS tracked (address TEXT PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS fee_payers (
      payer TEXT NOT NULL,
      wallet TEXT NOT NULL,
      tx_count INTEGER NOT NULL,
      PRIMARY KEY (payer, wallet)
    );
    CREATE INDEX IF NOT EXISTS fee_payers_wallet ON fee_payers(wallet);
    CREATE TABLE IF NOT EXISTS pool_windows (
      pool TEXT NOT NULL,
      from_time INTEGER NOT NULL,
      to_time INTEGER NOT NULL,
      fetched_at INTEGER NOT NULL,
      PRIMARY KEY (pool, from_time, to_time)
    );
    CREATE TABLE IF NOT EXISTS pool_transfers (
      pool TEXT NOT NULL,
      key TEXT NOT NULL,
      signature TEXT NOT NULL,
      slot INTEGER NOT NULL,
      block_time INTEGER,
      from_addr TEXT NOT NULL,
      to_addr TEXT NOT NULL,
      mint TEXT NOT NULL,
      amount_raw TEXT NOT NULL,
      decimals INTEGER NOT NULL,
      ui_amount REAL NOT NULL,
      PRIMARY KEY (pool, key)
    );
    CREATE INDEX IF NOT EXISTS pool_transfers_time ON pool_transfers(pool, block_time);
    CREATE TABLE IF NOT EXISTS services (
      address TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      category TEXT NOT NULL,
      checked_at INTEGER NOT NULL
    );
  `);
  // Миграция: колонка top_slot появилась 15.11.2026.
  if (!(db.prepare('PRAGMA table_info(fetches)').all() as any[]).some((c) => c.name === 'top_slot')) {
    db.exec('ALTER TABLE fetches ADD COLUMN top_slot INTEGER');
  }

  const insertStmt = db.prepare(
    `INSERT OR IGNORE INTO transfers (key, signature, slot, block_time, from_addr, to_addr, mint, amount_raw, decimals, ui_amount)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const ofStmt = db.prepare(`SELECT * FROM transfers WHERE from_addr = ?1 OR to_addr = ?1 ORDER BY slot DESC`);
  const getFetchStmt = db.prepare(`SELECT * FROM fetches WHERE address = ? AND mode = ?`);
  const setFetchStmt = db.prepare(
    `INSERT INTO fetches (address, mode, fetched_at, row_limit, rows, complete, top_slot) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(address, mode) DO UPDATE SET fetched_at = excluded.fetched_at, row_limit = excluded.row_limit, rows = excluded.rows,
       complete = excluded.complete, top_slot = excluded.top_slot`,
  );
  const setAccountStmt = db.prepare(
    `INSERT INTO accounts (address, kind, checked_at) VALUES (?, ?, ?)
     ON CONFLICT(address) DO UPDATE SET kind = excluded.kind, checked_at = excluded.checked_at`,
  );

  const toTransfer = (r: any): Transfer => ({
    key: r.key,
    signature: r.signature,
    slot: r.slot,
    blockTime: r.block_time ?? null,
    from: r.from_addr,
    to: r.to_addr,
    mint: r.mint,
    amountRaw: r.amount_raw,
    decimals: r.decimals,
    uiAmount: r.ui_amount,
  });

  function tx<T>(fn: () => T): T {
    db.exec('BEGIN');
    try {
      const out = fn();
      db.exec('COMMIT');
      return out;
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }

  function chunks<T>(items: T[]): T[][] {
    const out: T[][] = [];
    for (let i = 0; i < items.length; i += CHUNK) out.push(items.slice(i, i + CHUNK));
    return out;
  }

  return {
    insertTransfers(rows: Transfer[]): void {
      if (rows.length === 0) return;
      // Одинаковые переводы внутри одной транзакции различаем порядковым номером.
      const seen = new Map<string, number>();
      tx(() => {
        for (const t of rows) {
          const base = `${t.signature}:${t.from}:${t.to}:${t.mint}:${t.amountRaw}`;
          const n = seen.get(base) ?? 0;
          seen.set(base, n + 1);
          insertStmt.run(`${base}:${n}`, t.signature, t.slot, t.blockTime, t.from, t.to, t.mint, t.amountRaw, t.decimals, t.uiAmount);
        }
      });
    },

    /** Все известные переводы кошелька, новые сверху. */
    transfersOf(address: string): Transfer[] {
      return ofStmt.all(address).map(toTransfer);
    },

    getFetch(address: string, mode: FetchMode): FetchState | null {
      const r: any = getFetchStmt.get(address, mode);
      return r ? { fetchedAt: r.fetched_at, rowLimit: r.row_limit, rows: r.rows, complete: !!r.complete, topSlot: r.top_slot ?? null } : null;
    },

    setFetch(address: string, mode: FetchMode, state: FetchState): void {
      setFetchStmt.run(address, mode, state.fetchedAt, state.rowLimit, state.rows, state.complete ? 1 : 0, state.topSlot ?? null);
    },

    getAccounts(addresses: string[]): Map<string, AccountKind> {
      const out = new Map<string, AccountKind>();
      for (const part of chunks(addresses)) {
        const rows: any[] = db.prepare(`SELECT address, kind FROM accounts WHERE address IN (${part.map(() => '?').join(',')})`).all(...part);
        for (const r of rows) out.set(r.address, r.kind);
      }
      return out;
    },

    setAccounts(entries: Iterable<[string, AccountKind]>): void {
      const now = Math.floor(Date.now() / 1000);
      tx(() => {
        for (const [address, kind] of entries) setAccountStmt.run(address, kind, now);
      });
    },

    syncTracked(addresses: string[]): void {
      tx(() => {
        db.exec('DELETE FROM tracked');
        const stmt = db.prepare('INSERT OR IGNORE INTO tracked (address) VALUES (?)');
        for (const a of addresses) stmt.run(a);
      });
    },

    /** Переводы из кэша, где одна сторона — из candidates, а другая — из списка отслеживания. */
    linksToTracked(candidates: string[]): Transfer[] {
      const out: Transfer[] = [];
      for (const part of chunks(candidates)) {
        const marks = part.map(() => '?').join(',');
        const rows: any[] = db
          .prepare(
            `SELECT t.* FROM transfers t JOIN tracked k ON k.address = t.to_addr WHERE t.from_addr IN (${marks})
             UNION
             SELECT t.* FROM transfers t JOIN tracked k ON k.address = t.from_addr WHERE t.to_addr IN (${marks})`,
          )
          .all(...part, ...part);
        out.push(...rows.map(toTransfer));
      }
      return out;
    },

    /**
     * Кто ещё получал те же токены в том же слоте, что и address, но другой транзакцией.
     * Совпадения внутри одной транзакции — маршрутизация обмена через пулы, их пропускаем.
     * Покупку, которую в том же слоте получили больше maxCrowd известных кошельков (запуск токена, раздача), не считаем.
     */
    coBuysOf(address: string, maxCrowd = 8, slotWindow = Number(process.env.COBUY_SLOT_WINDOW ?? 0)): CoBuy[] {
      const marks = NOT_TOKENS.map(() => '?').join(',');
      const buys = (db.prepare(`SELECT * FROM transfers WHERE to_addr = ? AND mint NOT IN (${marks})`).all(address, ...NOT_TOKENS) as any[]).map(toTransfer);
      const same = db.prepare('SELECT * FROM transfers WHERE mint = ? AND slot BETWEEN ? AND ? AND to_addr != ? AND signature != ?');
      const out = new Map<string, CoBuy>();
      for (const b of buys) {
        const rows = (same.all(b.mint, b.slot - slotWindow, b.slot + slotWindow, address, b.signature) as any[]).map(toTransfer).filter((r) => r.from !== address);
        const who = new Set(rows.map((r) => r.to));
        if (who.size === 0 || who.size > maxCrowd) continue;
        for (const r of rows) {
          const c = out.get(r.to) ?? out.set(r.to, { wallet: r.to, mints: new Set(), slots: new Set(), records: [] }).get(r.to)!;
          c.mints.add(b.mint);
          c.slots.add(b.slot);
          if (!c.records.some((x) => x.key === b.key)) c.records.push(b);
          c.records.push(r);
        }
      }
      return [...out.values()];
    },

    /** Кто оплачивал комиссии за транзакции wallet (по выборке последних транзакций); заменяет прежние данные. */
    setFeePayers(wallet: string, payers: Map<string, number>): void {
      tx(() => {
        db.prepare('DELETE FROM fee_payers WHERE wallet = ?').run(wallet);
        const ins = db.prepare('INSERT INTO fee_payers (payer, wallet, tx_count) VALUES (?, ?, ?)');
        for (const [payer, n] of payers) if (payer !== wallet) ins.run(payer, wallet, n);
      });
    },

    /** Плательщики комиссий за wallet: [{ payer, n }]. */
    payersOf(wallet: string): Array<{ payer: string; n: number }> {
      return (db.prepare('SELECT payer, tx_count AS n FROM fee_payers WHERE wallet = ? ORDER BY tx_count DESC').all(wallet) as any[]).map((r) => ({ payer: r.payer, n: r.n }));
    },

    /** За чьи транзакции платил payer: [{ wallet, n }]. */
    paidBy(payer: string): Array<{ wallet: string; n: number }> {
      return (db.prepare('SELECT wallet, tx_count AS n FROM fee_payers WHERE payer = ? ORDER BY tx_count DESC').all(payer) as any[]).map((r) => ({ wallet: r.wallet, n: r.n }));
    },

    /** Адрес, ранее распознанный как биржа или сервис (не старше maxAgeSec). */
    getService(address: string, maxAgeSec: number): { label: string; category: string } | null {
      const r: any = db.prepare('SELECT label, category, checked_at FROM services WHERE address = ?').get(address);
      if (!r || Math.floor(Date.now() / 1000) - r.checked_at > maxAgeSec) return null;
      return { label: r.label, category: r.category };
    },

    setService(address: string, label: string, category: string): void {
      db.prepare(
        `INSERT INTO services (address, label, category, checked_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(address) DO UPDATE SET label = excluded.label, category = excluded.category, checked_at = excluded.checked_at`,
      ).run(address, label, category, Math.floor(Date.now() / 1000));
    },

    /** Первый и последний известный перевод каждого адреса (unix-секунды, по block_time); адреса без переводов не возвращаются. */
    activityOf(addresses: string[]): Map<string, { first: number | null; last: number | null }> {
      const out = new Map<string, { first: number | null; last: number | null }>();
      const merge = (a: string, first: number | null, last: number | null) => {
        const cur = out.get(a);
        if (!cur) return void out.set(a, { first, last });
        if (first != null && (cur.first == null || first < cur.first)) cur.first = first;
        if (last != null && (cur.last == null || last > cur.last)) cur.last = last;
      };
      for (const part of chunks(addresses)) {
        const marks = part.map(() => '?').join(',');
        for (const col of ['from_addr', 'to_addr']) {
          const rows: any[] = db
            .prepare(`SELECT ${col} AS a, MIN(block_time) AS f, MAX(block_time) AS l FROM transfers WHERE ${col} IN (${marks}) GROUP BY ${col}`)
            .all(...part);
          for (const r of rows) merge(r.a, r.f ?? null, r.l ?? null);
        }
      }
      return out;
    },

    /** Состояния загрузок по адресам: адрес → режим → состояние. */
    fetchStatesOf(addresses: string[]): Map<string, Partial<Record<FetchMode, FetchState>>> {
      const out = new Map<string, Partial<Record<FetchMode, FetchState>>>();
      for (const part of chunks(addresses)) {
        const rows: any[] = db.prepare(`SELECT * FROM fetches WHERE address IN (${part.map(() => '?').join(',')})`).all(...part);
        for (const r of rows) {
          const m = out.get(r.address) ?? out.set(r.address, {}).get(r.address)!;
          m[r.mode as FetchMode] = { fetchedAt: r.fetched_at, rowLimit: r.row_limit, rows: r.rows, complete: !!r.complete, topSlot: r.top_slot ?? null };
        }
      }
      return out;
    },

    /**
     * История пула за [from, to] из кэша поиска бандла (отдельно от transfers, чтобы чужие сделки пула не попадали
     * в обратный индекс). null — такой промежуток целиком ещё не загружался.
     */
    getPoolWindow(pool: string, from: number, to: number): Transfer[] | null {
      const hit = db.prepare('SELECT 1 FROM pool_windows WHERE pool = ? AND from_time <= ? AND to_time >= ? LIMIT 1').get(pool, from, to);
      if (!hit) return null;
      return (db.prepare('SELECT * FROM pool_transfers WHERE pool = ? AND block_time BETWEEN ? AND ? ORDER BY slot').all(pool, from, to) as any[]).map(toTransfer);
    },

    /** Сохраняет прочитанный целиком промежуток истории пула. Конец не позже чем минута назад: свежие сделки ещё дописываются. */
    setPoolWindow(pool: string, from: number, to: number, rows: Transfer[]): void {
      const now = Math.floor(Date.now() / 1000);
      const end = Math.min(to, now - 60);
      tx(() => {
        const ins = db.prepare(
          `INSERT OR IGNORE INTO pool_transfers (pool, key, signature, slot, block_time, from_addr, to_addr, mint, amount_raw, decimals, ui_amount)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        );
        const seen = new Map<string, number>();
        for (const t of rows) {
          const base = `${t.signature}:${t.from}:${t.to}:${t.mint}:${t.amountRaw}`;
          const n = seen.get(base) ?? 0;
          seen.set(base, n + 1);
          ins.run(pool, `${base}:${n}`, t.signature, t.slot, t.blockTime, t.from, t.to, t.mint, t.amountRaw, t.decimals, t.uiAmount);
        }
        if (end > from) db.prepare('INSERT OR REPLACE INTO pool_windows (pool, from_time, to_time, fetched_at) VALUES (?, ?, ?, ?)').run(pool, from, end, now);
      });
    },

    /** Сколько отслеживаемых кошельков уже имеют загруженную историю. */
    indexedCount(): number {
      const r: any = db.prepare(`SELECT COUNT(DISTINCT f.address) AS n FROM fetches f JOIN tracked k ON k.address = f.address`).get();
      return Number(r?.n ?? 0);
    },

    close(): void {
      db.close();
    },
  };
}

export type Db = ReturnType<typeof createDb>;
