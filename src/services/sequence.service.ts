import { prisma, type Tx } from '../config/database';

/** Atomically increment and return a named counter (INSERT ... ON CONFLICT DO UPDATE). */
export async function nextSequence(name: string, tx: Tx = prisma): Promise<number> {
  const row = await tx.sequence.upsert({
    where: { name },
    create: { name, value: 1 },
    update: { value: { increment: 1 } },
  });
  return row.value;
}
