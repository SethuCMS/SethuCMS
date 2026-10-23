/**
 * A browser that opens the gateway address sees a friendly page; programs keep
 * getting JSON answers.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { startGateway, type TestGateway } from './helpers.js';

const BROWSER = { Accept: 'text/html,application/xhtml+xml' };

describe('friendly page for browsers', () => {
  let gateway: TestGateway;
  before(async () => {
    gateway = await startGateway();
  });
  after(async () => {
    await gateway.close();
  });

  it('shows a page at the root when no admin app is bundled', async () => {
    const response = await fetch(gateway.url + '/', { headers: BROWSER });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /text\/html/);
    assert.match(await response.text(), /SethuCMS gateway/);
  });

  it('shows a page instead of a bare 405 for API paths', async () => {
    const response = await fetch(gateway.url + '/v1/auth/logout', {
      headers: BROWSER,
    });
    assert.equal(response.status, 405);
    assert.match(response.headers.get('allow') ?? '', /POST/);
    assert.match(await response.text(), /Open the admin app/);
  });

  it('keeps JSON for programs', async () => {
    const response = await fetch(gateway.url + '/v1/auth/logout', {
      headers: { Accept: 'application/json' },
    });
    assert.equal(response.status, 405);
    const body = (await response.json()) as { error: { code: string } };
    assert.equal(body.error.code, 'METHOD_NOT_ALLOWED');
  });
});
