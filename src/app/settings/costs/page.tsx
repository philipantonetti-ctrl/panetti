import { redirect } from 'next/navigation'
import { currentUser } from '@/lib/auth/current-user'
import { db } from '@/lib/db'
import { CostsClient } from './CostsClient'

export default async function CostsPage() {
  const user = await currentUser()
  if (!user) redirect('/login')
  if (user.role !== 'ADMIN') redirect('/portal')

  const [shops, sources] = await Promise.all([
    db.shop.findMany({
      where: { active: true },
      select: { id: true, name: true, currency: true },
      orderBy: { name: 'asc' },
    }),
    db.shop.findMany({
      where: { active: true, stockSource: true },
      select: { currency: true },
    }),
  ])

  /**
   * The currency the source shops share, or null when there is none to share.
   *
   * Null in two cases: nobody has ticked a stock source, or the ones ticked
   * disagree about currency. Either way the page falls back to one webshop at a
   * time. A cost is stored in minor units of a shop's own currency, so a combined
   * input can only be labelled honestly when every shop behind it uses the same
   * one - and an input labelled with the wrong currency is how a tenfold cost
   * error gets typed in good faith.
   */
  const currencies = [...new Set(sources.map((s) => s.currency))]
  const sourceCurrency = currencies.length === 1 ? currencies[0] : null

  return <CostsClient email={user.email} shops={shops} sourceCurrency={sourceCurrency} />
}
