/** A small product picture, or a quiet placeholder when the shop has none. */
export function Thumb({ src, alt }: { src: string | null; alt: string }) {
  if (!src) return <span aria-hidden="true" className="h-8 w-8 shrink-0 rounded-md bg-panel" />
  // eslint-disable-next-line @next/next/no-img-element -- shop images are arbitrary remote hosts
  return <img src={src} alt={alt} className="h-8 w-8 shrink-0 rounded-md object-cover" />
}
