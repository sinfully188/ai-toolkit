import { NextResponse } from 'next/server';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

export async function PATCH(request: Request, { params }: { params: Promise<{ jobID: string }> }) {
  try {
    const { jobID } = await params;
    const body = await request.json();
    const rawPowerPercent = Number(body?.powerPercent);

    if (!Number.isFinite(rawPowerPercent)) {
      return NextResponse.json({ error: 'powerPercent must be a number.' }, { status: 400 });
    }

    const powerPercent = Math.min(100, Math.max(0, Math.round(rawPowerPercent)));
    const stepPauseSeconds = Math.round((((100 - powerPercent) / 100) * 0.25) * 1000) / 1000;

    const job = await prisma.job.findUnique({ where: { id: jobID } });
    if (!job) {
      return NextResponse.json({ error: 'Job not found.' }, { status: 404 });
    }

    const jobConfig = JSON.parse(job.job_config);
    if (!jobConfig?.config?.process?.[0]?.train) {
      return NextResponse.json({ error: 'Job config is missing train settings.' }, { status: 400 });
    }

    jobConfig.config.process[0].train.step_pause_seconds = stepPauseSeconds;

    await prisma.job.update({
      where: { id: jobID },
      data: {
        job_config: JSON.stringify(jobConfig),
      },
    });

    return NextResponse.json({ powerPercent, stepPauseSeconds });
  } catch (error) {
    console.error(error);
    return NextResponse.json({ error: 'Failed to update live throttle.' }, { status: 500 });
  }
}