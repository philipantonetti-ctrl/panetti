import { PrismaClient } from '@prisma/client'
const db = new PrismaClient()
async function main() {
  const n = await db.supportMessage.count()
  const newest = await db.supportMessage.findFirst({ orderBy: { createdAt: 'desc' }, select: { createdAt: true, senderName: true, fromAgent: true } })
  const oldest = await db.supportMessage.findFirst({ orderBy: { createdAt: 'asc' }, select: { createdAt: true } })
  const state = await db.supportSyncState.findFirst({ select: { messageWatermark: true, messageBackfilling: true, ranAt: true, lastError: true } })
  console.log(`messages=${n} newest=${newest?.createdAt.toISOString() ?? '-'} (${newest?.senderName ?? 'customer'}) oldest=${oldest?.createdAt.toISOString() ?? '-'}`)
  console.log('state:', JSON.stringify(state))
}
main().finally(() => db.$disconnect())
