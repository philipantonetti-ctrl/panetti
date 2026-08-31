import { PrismaClient } from '@prisma/client'
const db = new PrismaClient()
async function main() {
  const rows = await db.supportAgent.findMany({
    where: { avatarUrl: { not: null } },
    select: { name: true, avatarData: true },
  })
  for (const r of rows) {
    console.log(`${r.name}: ${r.avatarData ? `PHOTO STORED (${Math.round(r.avatarData.length / 1024)}KB, ${r.avatarData.slice(5, 15)})` : 'no bytes (bucket refused or not yet fetched)'}`)
  }
  const msgs = await db.supportMessage.count()
  const oldest = await db.supportMessage.findFirst({ orderBy: { createdAt: 'asc' }, select: { createdAt: true } })
  console.log(`messages=${msgs} back to ${oldest?.createdAt.toISOString().slice(0, 10)}`)
  console.log('now:', new Date().toISOString())
}
main().finally(() => db.$disconnect())
