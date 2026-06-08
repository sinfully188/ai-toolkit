import { NextResponse } from 'next/server';
import { PrismaClient } from '@prisma/client';
import { updateJobThrottle } from '@/liveControls/server';

const prisma = new PrismaClient();

export async function PATCH(request: Request, { params }: { params: Promise<{ jobID: string }> }) {
  try {
    const { jobID } = await params;
    const body = await request.json();
    const rawPowerPercent = Number(body?.powerPercent);

    if (!Number.isFinite(rawPowerPercent)) {
      return NextResponse.json({ error: 'powerPercent must be a number.' }, { status: 400 });
    }

    const result = await updateJobThrottle(prisma, jobID, rawPowerPercent);
    if ('error' in result) {
      return NextResponse.json({ error: result.error }, { status: result.status });
    }

    return NextResponse.json(result);
  } catch (error) {
    console.error(error);
    return NextResponse.json({ error: 'Failed to update live throttle.' }, { status: 500 });
  }
}