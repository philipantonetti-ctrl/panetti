import Image from 'next/image'
import mark from './panetti-mark.png'

/**
 * The Panetti "P", as it sits beside the product name in the sidebar and on
 * every signed-out page.
 *
 * Imported rather than read from /public on purpose: an imported image is
 * served from /_next/static, which the middleware's matcher leaves alone, so
 * the sign-in page can show it to somebody who is not signed in yet.
 */
export function BrandMark({ size = 28 }: { size?: number }) {
  return <Image src={mark} alt="" width={size} height={size} className="shrink-0 rounded-md" priority />
}
