import { PrismaClient } from '@prisma/client'
import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3'

// Reuse the client across hot reloads in dev, so we don't exhaust connections.
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient }

// Prisma 7 requires an explicit driver adapter — there is no default Rust engine.
const adapter = new PrismaBetterSqlite3({ url: process.env.DATABASE_URL! })

export const db = globalForPrisma.prisma ?? new PrismaClient({ adapter })

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = db
