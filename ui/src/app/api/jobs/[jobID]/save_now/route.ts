import { NextRequest, NextResponse } from 'next/server';
import { PrismaClient } from '@prisma/client';
import { markJobSaveNow } from '@/liveControls/server';

const prisma = new PrismaClient();

export async function GET(request: NextRequest, { params }: { params: { jobID: string } }) {
  const { jobID } = await params;

  const job = await markJobSaveNow(prisma, jobID);

  console.log(`Job ${jobID} marked to save on next step`);

  return NextResponse.json(job);
}
