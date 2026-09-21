import Image from 'next/image'
import mark from './panetti-mark.png'

/**
 * The Panetti "P", as it sits beside the product name in the sidebar and on
 * every signed-out page.
 *
 * Imported rather than read from /public on purpose: an imported image is
 * served from /_next/static, which the middleware's matcher leaves alone, so
 * the sign-in page can show it to somebody who is not signed in yet.
 *
 * `panetti-icon-source.png` beside this file is Philip's original, 1024 px.
 * Everything else was cut from it: this mark (128 px), src/app/favicon.ico
 * (16, 32, 48), src/app/icon.png (512) and src/app/apple-icon.png (180). The
 * strokes are hairlines, so the sizes under 128 px were thickened before
 * shrinking or the letter vanishes in a browser tab.
 */
export function BrandMark({ size = 28 }: { size?: number }) {
  return <Image src={mark} alt="" width={size} height={size} className="shrink-0 rounded-md" priority />
}
