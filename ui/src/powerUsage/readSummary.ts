import fs from 'fs';
import path from 'path';
import sqlite3 from 'sqlite3';
import { getTrainingFolder } from '@/server/settings';
import type { PowerUsageSummary } from '@/powerUsage/types';

function openDb(filename: string) {
  const readonlyUri = `file:${filename}?mode=ro&immutable=1`;
  const db = new sqlite3.Database(readonlyUri, sqlite3.OPEN_READONLY | sqlite3.OPEN_URI);
  db.configure('busyTimeout', 30_000);
  return db;
}

function all<T = any>(db: sqlite3.Database, sql: string, params: any[] = []) {
  return new Promise<T[]>((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows as T[]);
    });
  });
}

function closeDb(db: sqlite3.Database) {
  return new Promise<void>((resolve, reject) => {
    db.close(err => (err ? reject(err) : resolve()));
  });
}

export async function readPowerSummary(jobName: string): Promise<PowerUsageSummary | null> {
  const trainingFolder = await getTrainingFolder();
  const logPath = path.join(trainingFolder, jobName, 'power_log.db');

  if (!fs.existsSync(logPath)) {
    return null;
  }

  const db = openDb(logPath);
  try {
    const rows = await all<{ key: string; value: string }>(
      db,
      'SELECT key, value FROM metadata WHERE key IN (?, ?, ?, ?, ?, ?, ?)',
      ['average_power_w', 'peak_power_w', 'total_energy_wh', 'estimated_cost', 'sample_count', 'currency', 'final_status']
    );
    const metadata = Object.fromEntries(rows.map(row => [row.key, row.value]));
    const sampleCount = Number.parseInt(metadata.sample_count ?? '0', 10);

    if (!Number.isFinite(sampleCount) || sampleCount <= 0) {
      return null;
    }

    const parseFloatOrNull = (value?: string) => {
      if (value == null || value.trim() === '') {
        return null;
      }
      const parsed = Number.parseFloat(value);
      return Number.isFinite(parsed) ? parsed : null;
    };

    return {
      averagePowerW: parseFloatOrNull(metadata.average_power_w) ?? 0,
      peakPowerW: parseFloatOrNull(metadata.peak_power_w) ?? 0,
      totalEnergyWh: parseFloatOrNull(metadata.total_energy_wh) ?? 0,
      estimatedCost: parseFloatOrNull(metadata.estimated_cost),
      currency: metadata.currency?.trim() ? metadata.currency : null,
      sampleCount,
      finalStatus: metadata.final_status?.trim() ? metadata.final_status : null,
    };
  } catch {
    return null;
  } finally {
    await closeDb(db);
  }
}
