import { describe, it, expect } from 'vitest'
import type { WooOrder } from '@/lib/woo/map'
import { buildNyceOrder, NyceOrderError, isWarehouseShop } from './nyce-order'

/**
 * Selected 3PL's warehouse (NYCE) takes one XML file per order. Philip: use
 * exactly the same template and client code as Ledtek's (LTAS_CO4902.xml).
 */

const order = (over: Partial<WooOrder> = {}): WooOrder => ({
  id: 9001,
  number: '31005',
  status: 'processing',
  currency: 'NOK',
  date_created_gmt: '2026-01-11T23:30:00', // 00:30 on 12 Jan in Oslo
  discount_total: '0',
  discount_tax: '0',
  shipping_total: '0',
  shipping_tax: '0',
  total_tax: '0',
  total: '0',
  coupon_lines: [],
  line_items: [
    { id: 1, product_id: 11, sku: 'PANPIZOVEBRU', name: 'Oven', quantity: 1, subtotal: '0', total: '0' },
    { id: 2, product_id: 12, sku: 'PANPIZOVECOV', name: 'Cover', quantity: 2, subtotal: '0', total: '0' },
  ],
  billing: { first_name: 'Kari', last_name: 'Nordmann', country: 'NO' },
  shipping: {
    first_name: 'Kari',
    last_name: 'Nordmann',
    address_1: 'Testveien 1',
    address_2: '',
    city: 'Røyneberg',
    postcode: '4052',
    country: 'NO',
  },
  ...over,
})

const NOW = new Date('2026-01-12T05:32:09.492Z') // 06:32:09.492 in Oslo

const EXPECTED = `<?xml version="1.0" encoding="utf-8"?>
<NYCE.LOGIC xmlns="http://nyce.se/schemas/nyce.logic/3.0/integration">
	<Envelope>
		<MessageId>2026011206320931005</MessageId>
		<MessageType>SELECTED3PL_CUSTOMER_ORDER</MessageType>
		<Version>3.7</Version>
		<Sender>NYCE.LOGIC</Sender>
		<Created>2026-01-12T06:32:09.492+01:00</Created>
		<Warehouse>JKPG01</Warehouse>
		<Client>LTAS</Client>
	</Envelope>
	<Data>
		<CustomerOrder>
			<Number>31005</Number>
			<Currency>
				<Currency Code="NOK"/>
			</Currency>
			<CustomProperties>
				<CustomerOrderCustomProperty>
					<Name>SO nr</Name>
					<Value>31005</Value>
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
							<String>Testveien 1</String>
						</AddressLines>
						<City>Røyneberg</City>
						<Country Code="NO"/>
						<ZipCode>4052</ZipCode>
					</Address>
					<Currency Code="NOK"/>
					<DeliveryCustomerName>Kari Nordmann</DeliveryCustomerName>
					<DeliveryWay>
						<DeliveryWay Code="342_NO"/>
					</DeliveryWay>
					<Priority Code="NORMAL"/>
					<Name>Kari Nordmann</Name>
					<Code>31005</Code>
				</Customer>
			</DeliveryCustomer>
			<DeliveryCustomerAddress>
				<Address>
					<AddressLines>
						<String>Testveien 1</String>
					</AddressLines>
					<City>Røyneberg</City>
					<Country Code="NO"/>
					<Contacts>
						<Contact>
							<Name>Kari Nordmann</Name>
						</Contact>
					</Contacts>
					<ZipCode>4052</ZipCode>
					<MainContact>
						<Contact>
							<Name>Kari Nordmann</Name>
						</Contact>
					</MainContact>
				</Address>
			</DeliveryCustomerAddress>
			<DeliveryCustomerName>Kari Nordmann</DeliveryCustomerName>
			<Lines>
				<CustomerOrderLine>
					<Position>1</Position>
					<Item Sku="PANPIZOVEBRU"/>
					<OrderQuantity>1</OrderQuantity>
					<OriginalQuantity>1</OriginalQuantity>
					<Quantity>1</Quantity>
				</CustomerOrderLine>
				<CustomerOrderLine>
					<Position>2</Position>
					<Item Sku="PANPIZOVECOV"/>
					<OrderQuantity>2</OrderQuantity>
					<OriginalQuantity>2</OriginalQuantity>
					<Quantity>2</Quantity>
				</CustomerOrderLine>
			</Lines>
			<OrderDate>2026-01-12T00:00:00</OrderDate>
			<OrderType>
				<Code>Normal</Code>
			</OrderType>
			<DeliveryWay>
				<DeliveryWay Code="342_NO"/>
			</DeliveryWay>
			<RequestedDeliveryDate>2026-01-12T00:00:00</RequestedDeliveryDate>
		</CustomerOrder>
	</Data>
</NYCE.LOGIC>
`

describe('buildNyceOrder', () => {
  it('writes the order in exactly the Ledtek template', () => {
    const file = buildNyceOrder(order(), NOW)
    expect(file.xml).toBe(EXPECTED)
  })

  it('names the file like the Ledtek file', () => {
    expect(buildNyceOrder(order(), NOW).fileName).toBe('LTAS_CO31005.xml')
  })

  it('puts the second address line under the first', () => {
    const xml = buildNyceOrder(order({ shipping: { ...order().shipping, address_2: 'Leil. 3' } }), NOW).xml
    expect(xml).toContain('<String>Testveien 1</String>\n\t\t\t\t\t\t\t<String>Leil. 3</String>')
  })

  it('uses the billing address when the order has no shipping address', () => {
    const xml = buildNyceOrder(
      order({
        shipping: { country: '' },
        billing: { first_name: 'Ola', last_name: 'Hansen', address_1: 'Bakken 2', city: 'Oslo', postcode: '0150', country: 'NO' },
      }),
      NOW,
    ).xml
    expect(xml).toContain('<String>Bakken 2</String>')
    expect(xml).toContain('<DeliveryCustomerName>Ola Hansen</DeliveryCustomerName>')
  })

  it('escapes characters that would break the file', () => {
    const xml = buildNyceOrder(order({ shipping: { ...order().shipping, address_1: 'Fish & <Chips> "1"' } }), NOW).xml
    expect(xml).toContain('<String>Fish &amp; &lt;Chips&gt; &quot;1&quot;</String>')
  })

  it('refuses a country the warehouse has given no delivery code for', () => {
    const de = order({ shipping: { ...order().shipping, country: 'DE' } })
    expect(() => buildNyceOrder(de, NOW)).toThrow(NyceOrderError)
    expect(() => buildNyceOrder(de, NOW)).toThrow('No warehouse delivery code for DE yet')
  })

  it('refuses a product with no SKU, which the warehouse cannot pick', () => {
    const bad = order({
      line_items: [{ id: 1, product_id: 11, sku: '', name: 'Gift card', quantity: 1, subtotal: '0', total: '0' }],
    })
    expect(() => buildNyceOrder(bad, NOW)).toThrow('"Gift card" has no SKU')
  })

  it('refuses an order with no address', () => {
    const bad = order({ shipping: { ...order().shipping, address_1: '' }, billing: { country: 'NO' } })
    expect(() => buildNyceOrder(bad, NOW)).toThrow('Order 31005 has no delivery address')
  })
})

describe('isWarehouseShop', () => {
  it('is panetti.com only', () => {
    expect(isWarehouseShop('https://panetti.com')).toBe(true)
    expect(isWarehouseShop('https://www.panetti.com/')).toBe(true)
    expect(isWarehouseShop('https://panetti.no')).toBe(false)
    expect(isWarehouseShop('https://www.panetti.fi')).toBe(false)
    expect(isWarehouseShop(null)).toBe(false)
    expect(isWarehouseShop('not a url')).toBe(false)
  })
})
