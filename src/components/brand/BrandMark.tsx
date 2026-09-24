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
 *
 * Plain <img>, deliberately, like the avatar on the agents page: next/image
 * asks the runtime to build an absolute URL for the optimiser, and under the
 * test runner there is no host to build one from, so every page that draws the
 * shell dies on "Invalid URL". The file is 7 KB and already the right size -
 * there is nothing for the optimiser to do.
 */
/**
 * Next's build turns a static image import into `{ src, width, height }`; the
 * test runner's bundler hands back the path as a plain string. Reading both
 * means the mark draws under either, rather than silently losing its src in
 * every test that renders the shell.
 */
const src = (mark as unknown as { src?: string }).src ?? (mark as unknown as string)

export function BrandMark({ size = 28 }: { size?: number }) {
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={src} alt="" width={size} height={size} className="shrink-0 rounded-md" />
  )
}
