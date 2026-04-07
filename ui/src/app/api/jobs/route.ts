import { NextResponse } from 'next/server';
import { PrismaClient } from '@prisma/client';
import { isMac } from '@/helpers/basic';
import fs from 'fs';
import path from 'path';
import sqlite3 from 'sqlite3';
import { getTrainingFolder } from '@/server/settings';

const prisma = new PrismaClient();

export const runtime = 'nodejs';

type JobPowerSummary = {
  averagePowerW: number;
  peakPowerW: number;
  totalEnergyWh: number;
  estimatedCost: number | null;
  currency: string | null;
  sampleCount: number;
  finalStatus: string | null;
};

function openDb(filename: string) {
  const db = new sqlite3.Database(filename);
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

async function readPowerSummary(jobName: string): Promise<JobPowerSummary | null> {
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

async function attachPowerSummary(job: any) {
  return {
    ...job,
    powerSummary: await readPowerSummary(job.name),
  };
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const id = searchParams.get('id');

  try {
    if (id) {
      const job = await prisma.job.findUnique({
        where: { id },
      });
      return NextResponse.json(job ? await attachPowerSummary(job) : null);
    }

    const jobs = await prisma.job.findMany({
      orderBy: { created_at: 'desc' },
    });
    return NextResponse.json({ jobs: await Promise.all(jobs.map(attachPowerSummary)) });
  } catch (error) {
    console.error(error);
    return NextResponse.json({ error: 'Failed to fetch training data' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { id, name, job_config } = body;
    let gpu_ids: string = body.gpu_ids;

    if (isMac()) {
      gpu_ids = "mps";
    }

    if (id) {
      // Update existing training
      const training = await prisma.job.update({
        where: { id },
        data: {
          name,
          gpu_ids,
          job_config: JSON.stringify(job_config),
        },
      });
      return NextResponse.json(training);
    } else {
      // find the highest queue position and add 1000
      const highestQueuePosition = await prisma.job.aggregate({
        _max: {
          queue_position: true,
        },
      });
      const newQueuePosition = (highestQueuePosition._max.queue_position || 0) + 1000;

      // Create new training
      const training = await prisma.job.create({
        data: {
          name,
          gpu_ids,
          job_config: JSON.stringify(job_config),
          queue_position: newQueuePosition,
        },
      });
      return NextResponse.json(training);
    }
  } catch (error: any) {
    if (error.code === 'P2002') {
      // Handle unique constraint violation, 409=Conflict
      return NextResponse.json({ error: 'Job name already exists' }, { status: 409 });
    }
    console.error(error);
    // Handle other errors
    return NextResponse.json({ error: 'Failed to save training data' }, { status: 500 });
  }
}
