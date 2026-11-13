import type { WooAddress, WooOrder } from '@/lib/woo/map'

/**
 * One panetti.com order as the XML file Selected 3PL's warehouse system (NYCE)
 * reads. Philip, 2026-11-13: "exactly same template and same client code as
 * ledtek" - so every fixed value below is copied from Ledtek's LTAS_CO4902.xml.
 */

export class NyceOrderError extends Error {}

/** Only panetti.com sends its orders to the warehouse this way. */
const WAREHOUSE_SHOP_HOST = 'panetti.com'

export function isWarehouseShop(wooUrl: string | null, host = process.env.WAREHOUSE_SHOP_HOST || WAREHOUSE_SHOP_HOST): boolean {
  if (!wooUrl) return false
  try {
    return new URL(wooUrl).hostname.replace(/^www\./, '') === host
  } catch {
    return false
  }
}

/**
 * The warehouse's delivery code per destination country. Selected 3PL gives
 * these; Norway's is the one on Ledtek's file. A country missing here is
 * refused rather than sent with a guessed code.
 */
export const DELIVERY_WAYS: Record<string, string> = {
  NO: '342_NO',
}

const ZONE = 'Europe/Oslo'

/** Wall-clock parts of `d` in Oslo, plus the offset ("+01:00"). */
function osloParts(d: Date) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: ZONE,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
      timeZoneName: 'longOffset',
    })
      .formatToParts(d)
      .map((p) => [p.type, p.value]),
  )
  const offset = parts.timeZoneName === 'GMT' ? '+00:00' : parts.timeZoneName.replace('GMT', '')
  return { ...parts, offset } as Record<string, string>
}

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

const t = (s: string | undefined) => (s ?? '').trim()

/** The shipping address, or the billing one when the order has none. */
function deliveryAddress(o: WooOrder): WooAddress {
  const s = o.shipping ?? {}
  return t(s.address_1) ? s : (o.billing ?? {})
}

export function buildNyceOrder(o: WooOrder, now: Date): { fileName: string; xml: string } {
  const a = deliveryAddress(o)
  const name = [t(a.first_name), t(a.last_name)].filter(Boolean).join(' ')
  const country = t(a.country).toUpperCase()
  if (!t(a.address_1) || !t(a.city) || !t(a.postcode) || !country || !name) {
    throw new NyceOrderError(`Order ${o.number} has no delivery address`)
  }
  const way = DELIVERY_WAYS[country]
  if (!way) throw new NyceOrderError(`No warehouse delivery code for ${country} yet`)

  const lines = o.line_items.filter((l) => l.quantity > 0)
  for (const l of lines) {
    if (!t(l.sku)) throw new NyceOrderError(`"${l.name}" has no SKU`)
  }

  const c = osloParts(now)
  const ms = String(now.getUTCMilliseconds()).padStart(3, '0')
  const placed = osloParts(new Date(`${o.date_created_gmt}Z`))
  const orderDay = `${placed.year}-${placed.month}-${placed.day}T00:00:00`
  const number = esc(o.number)
  const currency = esc(o.currency.toUpperCase())
  const addressLines = [t(a.address_1), t(a.address_2)]
    .filter(Boolean)
    .map((l) => `<String>${esc(l)}</String>`)
  const lineBlock = (indent: string) => addressLines.join(`\n${indent}`)
  const contact = (indent: string) =>
    `<Contact>\n${indent}\t<Name>${esc(name)}</Name>\n${indent}</Contact>`

  const xml = `<?xml version="1.0" encoding="utf-8"?>
<NYCE.LOGIC xmlns="http://nyce.se/schemas/nyce.logic/3.0/integration">
	<Envelope>
		<MessageId>${c.year}${c.month}${c.day}${c.hour}${c.minute}${c.second}${number}</MessageId>
		<MessageType>SELECTED3PL_CUSTOMER_ORDER</MessageType>
		<Version>3.7</Version>
		<Sender>NYCE.LOGIC</Sender>
		<Created>${c.year}-${c.month}-${c.day}T${c.hour}:${c.minute}:${c.second}.${ms}${c.offset}</Created>
		<Warehouse>JKPG01</Warehouse>
		<Client>LTAS</Client>
	</Envelope>
	<Data>
		<CustomerOrder>
			<Number>${number}</Number>
			<Currency>
				<Currency Code="${currency}"/>
			</Currency>
			<CustomProperties>
				<CustomerOrderCustomProperty>
					<Name>SO nr</Name>
					<Value>${number}</Value>
				</CustomerOrderCustomProperty>
				<CustomerOrderCustomProperty>
					<Name>Slot ref.</Name>
					<Value></Value>
				</CustomerOrderCustomProperty>
				<CustomerOrderCustomProperty>
					<Name>YourRef</Name>
					<Value></Value>
				</CustomerOrderCustomProperty>
			</CustomProperties>
			<DeliveryCustomer>
				<Customer>
					<Address>
						<AddressLines>
							${lineBlock('\t\t\t\t\t\t\t')}
						</AddressLines>
						<City>${esc(t(a.city))}</City>
						<Country Code="${esc(country)}"/>
						<ZipCode>${esc(t(a.postcode))}</ZipCode>
					</Address>
					<Currency Code="${currency}"/>
					<DeliveryCustomerName>${esc(name)}</DeliveryCustomerName>
					<DeliveryWay>
						<DeliveryWay Code="${esc(way)}"/>
					</DeliveryWay>
					<Priority Code="NORMAL"/>
					<Name>${esc(name)}</Name>
					<Code>${number}</Code>
				</Customer>
			</DeliveryCustomer>
			<DeliveryCustomerAddress>
				<Address>
					<AddressLines>
						${lineBlock('\t\t\t\t\t\t')}
					</AddressLines>
					<City>${esc(t(a.city))}</City>
					<Country Code="${esc(country)}"/>
					<Contacts>
						${contact('\t\t\t\t\t\t')}
					</Contacts>
					<ZipCode>${esc(t(a.postcode))}</ZipCode>
					<MainContact>
						${contact('\t\t\t\t\t\t')}
					</MainContact>
				</Address>
			</DeliveryCustomerAddress>
			<DeliveryCustomerName>${esc(name)}</DeliveryCustomerName>
			<Lines>
${lines
  .map(
    (l, i) => `				<CustomerOrderLine>
					<Position>${i + 1}</Position>
					<Item Sku="${esc(t(l.sku))}"/>
					<OrderQuantity>${l.quantity}</OrderQuantity>
					<OriginalQuantity>${l.quantity}</OriginalQuantity>
					<Quantity>${l.quantity}</Quantity>
				</CustomerOrderLine>`,
  )
  .join('\n')}
			</Lines>
			<OrderDate>${orderDay}</OrderDate>
			<OrderType>
				<Code>Normal</Code>
			</OrderType>
			<DeliveryWay>
				<DeliveryWay Code="${esc(way)}"/>
			</DeliveryWay>
			<RequestedDeliveryDate>${orderDay}</RequestedDeliveryDate>
		</CustomerOrder>
	</Data>
</NYCE.LOGIC>
`
  return { fileName: `LTAS_CO${o.number.replace(/[^A-Za-z0-9_-]/g, '')}.xml`, xml }
}
