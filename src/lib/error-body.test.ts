import { describe, expect, it } from 'vitest'
import { readableErrorBody } from './error-body'

/**
 * What WordPress serves when a site has a fatal error, tabs and newlines as
 * shipped. Its first 300 characters — the window the Woo client used to keep —
 * are entirely <head>: doctype, three metas and the opening of <title>. The one
 * sentence a person needs sits in <body>, past the cut, which is how a client
 * came to read `WooCommerce responded 500: <!DOCTYPE html> <html lang="nb-NO">`
 * off his dashboard.
 */
const WP_ERROR_PAGE = `<!DOCTYPE html>
<html lang="nb-NO">
<head>
	<meta http-equiv="Content-Type" content="text/html; charset=UTF-8" />
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<meta name='robots' content='max-image-preview:large, noindex, follow' />
	<title>WordPress &rsaquo; Feil</title>
	<style type="text/css">
	html { background: #f1f1f1; }
	body { max-width: 700px; margin: 2em auto; }
	</style>
</head>
<body id="error-page">
	<div class="wp-die-message"><p>Det har oppstatt en kritisk feil pa nettstedet ditt.</p></div>
</body>
</html>`

describe('readableErrorBody', () => {
  it('keeps the sentence the error page is actually reporting', () => {
    expect(readableErrorBody(WP_ERROR_PAGE)).toContain('kritisk feil')
  })

  it('leaves no markup for a reader to trip over', () => {
    const out = readableErrorBody(WP_ERROR_PAGE)
    expect(out).not.toMatch(/[<>]/)
    expect(out).not.toContain('DOCTYPE')
  })

  /**
   * A WordPress error page carries several kilobytes of inline CSS. Stripping
   * tags without dropping their contents first turns that into the "message".
   */
  it('drops stylesheet text, which is long and says nothing', () => {
    expect(readableErrorBody(WP_ERROR_PAGE)).not.toContain('background')
  })

  it('decodes the entities that stripping would otherwise leave behind', () => {
    expect(readableErrorBody('<p>Bad &amp; broken</p>')).toBe('Bad & broken')
  })

  // Most of our integrations answer with JSON or a bare string. Those were
  // already readable and must pass through untouched.
  it('leaves a plain-text body exactly as it is', () => {
    expect(readableErrorBody('rest_no_route: no route was found')).toBe(
      'rest_no_route: no route was found',
    )
  })

  it('leaves a JSON body exactly as it is', () => {
    expect(readableErrorBody('{"code":"woocommerce_rest_cannot_view"}')).toBe(
      '{"code":"woocommerce_rest_cannot_view"}',
    )
  })

  /**
   * A gateway error page is often a styled shell with the only words in the
   * title — the reason this falls back rather than giving up.
   */
  it('falls back to the page title when the body carries no words', () => {
    const gateway = '<html><head><title>502 Bad Gateway</title></head><body><div></div></body></html>'
    expect(readableErrorBody(gateway)).toBe('502 Bad Gateway')
  })

  it('returns nothing rather than punctuation when the page is all markup', () => {
    expect(readableErrorBody('<html><body><br></body></html>')).toBe('')
  })

  it('collapses the whitespace an indented page is full of', () => {
    expect(readableErrorBody('<body>\n\n\tone\n\ttwo\n</body>')).toBe('one two')
  })

  it('caps the length, because an error line is not a document', () => {
    expect(readableErrorBody('x'.repeat(500)).length).toBeLessThanOrEqual(200)
  })
})
