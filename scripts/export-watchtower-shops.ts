/**
 * Prints a ready-to-paste WATCHTOWER_SHOPS value using the WooCommerce
 * credentials already stored (encrypted) in this project's database.
 *
 * Each exported shop's `name` is its DOMAIN — the hostname of `wooUrl`, with
 * any leading "www." stripped, e.g. "panetti.se" — not this project's
 * `Shop.name`, which is a display name. Watchtower prints this domain in
 * every Slack status line, so it has to read like a domain.
 *
 * Run from the panetti project root:
 *   npx tsx --env-file=.env scripts/export-watchtower-shops.ts
 *
 * The output contains live API secrets. Paste it straight into the host's
 * environment panel and do not commit it anywhere.
 */
import { PrismaClient } from '@prisma/client'
import { decryptSecret } from '../src/lib/secrets'

const prisma = new PrismaClient()

async function main() {
  const shops = await prisma.shop.findMany({
    where: { active: true },
    orderBy: { name: 'asc' },
  })

  const exported = shops
    .filter((shop) => shop.wooUrl)
    .map((shop) => {
      const url = shop.wooUrl!.replace(/\/$/, '')
      // Watchtower's `name` is the shop's domain, not panetti's `Shop.name`
      // display value — derived from wooUrl's hostname, "www." stripped.
      const name = new URL(url).hostname.replace(/^www\./, '')

      let credentials: { wooKey?: string; wooSecret?: string } = {}
      if (shop.wooKey && shop.wooSecret) {
        try {
          credentials = { wooKey: decryptSecret(shop.wooKey), wooSecret: decryptSecret(shop.wooSecret) }
        } catch (err) {
          // One shop's key failing to decrypt (a rotated AUTH_SECRET, a
          // truncated value, ...) must not blank out the whole export. Export
          // this shop without credentials instead — it keeps being monitored
          // for uptime, it just loses customer notes until it's reconnected.
          const message = err instanceof Error ? err.message : String(err)
          console.error(
            `Could not decrypt WooCommerce credentials for ${name} (panetti shop "${shop.name}"): ` +
              `${message} — exporting it WITHOUT credentials. It will report no customer notes until ` +
              `its key is fixed.`,
          )
        }
      }

      return { name, url, ...credentials }
    })

  const withKeys = exported.filter((shop) => 'wooKey' in shop).length
  console.error(`Exported ${exported.length} shops, ${withKeys} with WooCommerce credentials.`)
  console.error('Paste the line below as WATCHTOWER_SHOPS. It contains secrets — do not commit it.\n')
  console.log(JSON.stringify(exported))
}

main()
  .catch((err) => {
    console.error(err)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
