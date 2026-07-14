import { NextResponse } from 'next/server'
import { z } from 'zod'
import { currentUser } from '@/lib/auth/current-user'
import { assertAdmin, AuthError } from '@/lib/auth/guard'
import { db } from '@/lib/db'
import { toMinor } from '@/lib/money'
import { utcDay } from '@/lib/dates'
import { CATEGORIES, CATEGORY_GROUPS } from '@/lib/expense-categories'

export { CATEGORIES }

const Body = z.object({
  shopId: z.string().min(1),
  label: z.string().min(1),
  category: z.string().min(1),
  amount: z.number().min(0),
  currency: z.string().length(3),
  recurrence: z.enum(['ONE_TIME', 'DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY']),
  startDate: z.string(),
  endDate: z.string().nullable().optional(),
  active: z.boolean().default(true),
})

export async function GET(req: Request) {
  try {
    assertAdmin(await currentUser())

    const shopId = new URL(req.url).searchParams.get('shopId')
    if (!shopId) return NextResponse.json({ error: 'shopId is required' }, { status: 400 })

    const expenses = await db.operationalExpense.findMany({
      where: { shopId },
      orderBy: { label: 'asc' },
    })

    // Send the grouped shape so the picker can show headings (Overhead, Marketing, …).
    return NextResponse.json({ expenses, categories: CATEGORIES, categoryGroups: CATEGORY_GROUPS })
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: 403 })
    return NextResponse.json({ error: 'Could not load expenses' }, { status: 500 })
  }
}

export async function POST(req: Request) {
  try {
    assertAdmin(await currentUser())

    const parsed = Body.safeParse(await req.json())
    if (!parsed.success) return NextResponse.json({ error: 'Invalid expense' }, { status: 400 })
    const d = parsed.data

    const expense = await db.operationalExpense.create({
      data: {
        shopId: d.shopId,
        label: d.label,
        category: d.category,
        amount: toMinor(d.amount),
        currency: d.currency.toUpperCase(),
        recurrence: d.recurrence,
        startDate: utcDay(new Date(d.startDate)),
        endDate: d.endDate ? utcDay(new Date(d.endDate)) : null,
        active: d.active,
      },
    })

    return NextResponse.json({ expense })
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: 403 })
    return NextResponse.json({ error: 'Could not save the expense' }, { status: 500 })
  }
}
