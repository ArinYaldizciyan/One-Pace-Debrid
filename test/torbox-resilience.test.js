import { describe, it, expect, vi } from 'vitest';
import {
  TorboxUnavailable,
  torboxRequest,
  findTorrent,
  handleResolve,
} from '../src/index.js';

// Mimics what Cloudflare returns when Torbox's origin is unreachable:
// a plain-text body, not JSON. This is what crashed the worker in prod.
function cfErrorResponse(code = 521) {
  return {
    ok: false,
    status: code,
    headers: { get: (h) => (h.toLowerCase() === 'content-type' ? 'text/plain; charset=UTF-8' : null) },
    text: async () => `error code: ${code}\n`,
    json: async () => { throw new SyntaxError(`Unexpected token 'e', "error code: ${code}\n" is not valid JSON`); },
  };
}

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (h) => (h.toLowerCase() === 'content-type' ? 'application/json' : null) },
    text: async () => JSON.stringify(body),
    json: async () => body,
  };
}

const NO_DELAY = { delayMs: 0, reqId: 'test' };

describe('torboxRequest', () => {
  it('parses a normal JSON response', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ success: true, data: [] }));
    const out = await torboxRequest('https://api.torbox.app/x', {}, { ...NO_DELAY, fetchImpl });
    expect(out).toEqual({ success: true, data: [] });
  });

  it('throws TorboxUnavailable (not SyntaxError) on a 521 text body', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(cfErrorResponse(521));
    await expect(
      torboxRequest('https://api.torbox.app/x', {}, { ...NO_DELAY, fetchImpl, retries: 0 })
    ).rejects.toBeInstanceOf(TorboxUnavailable);
  });

  it('records the upstream status on the error', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(cfErrorResponse(520));
    await expect(
      torboxRequest('https://api.torbox.app/x', {}, { ...NO_DELAY, fetchImpl, retries: 0 })
    ).rejects.toMatchObject({ status: 520 });
  });

  it('retries a 5xx and succeeds when the retry works', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(cfErrorResponse(521))
      .mockResolvedValueOnce(jsonResponse({ success: true, data: [{ id: 1 }] }));
    const out = await torboxRequest('https://api.torbox.app/x', {}, { ...NO_DELAY, fetchImpl, retries: 2 });
    expect(out.success).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('retries on a network throw', async () => {
    const fetchImpl = vi.fn()
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce(jsonResponse({ success: true }));
    const out = await torboxRequest('https://api.torbox.app/x', {}, { ...NO_DELAY, fetchImpl, retries: 2 });
    expect(out.success).toBe(true);
  });

  it('gives up after exhausting retries', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(cfErrorResponse(521));
    await expect(
      torboxRequest('https://api.torbox.app/x', {}, { ...NO_DELAY, fetchImpl, retries: 2 })
    ).rejects.toBeInstanceOf(TorboxUnavailable);
    expect(fetchImpl).toHaveBeenCalledTimes(3); // initial + 2 retries
  });

  it('does NOT retry a 4xx — those are not transient', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ success: false, error: 'AUTH_ERROR' }, 403));
    const out = await torboxRequest('https://api.torbox.app/x', {}, { ...NO_DELAY, fetchImpl, retries: 2 });
    expect(out.success).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('throws TorboxUnavailable on a 200 carrying a non-JSON body', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => 'text/html' },
      text: async () => '<html>maintenance</html>',
      json: async () => { throw new SyntaxError('not json'); },
    });
    await expect(
      torboxRequest('https://api.torbox.app/x', {}, { ...NO_DELAY, fetchImpl, retries: 0 })
    ).rejects.toBeInstanceOf(TorboxUnavailable);
  });
});

describe('findTorrent', () => {
  it('propagates TorboxUnavailable rather than throwing SyntaxError', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(cfErrorResponse(521));
    await expect(
      findTorrent('KEY', 'abc', 'r1', { ...NO_DELAY, fetchImpl, retries: 0 })
    ).rejects.toBeInstanceOf(TorboxUnavailable);
  });

  it('returns null (not an error) when the API answers 403 AUTH_ERROR', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({ success: false, error: 'AUTH_ERROR', detail: 'try again' }, 403)
    );
    const out = await findTorrent('KEY', 'abc', 'r1', { ...NO_DELAY, fetchImpl, retries: 0 });
    expect(out).toBeNull();
  });
});

describe('handleResolve — upstream outage behaviour', () => {
  it('returns a retryable 503 with Retry-After instead of a 500 when Torbox 521s', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(cfErrorResponse(521));
    const res = await handleResolve('abc123', 5, 'KEY', null, { ...NO_DELAY, fetchImpl, retries: 0 });
    expect(res.status).toBe(503);
    expect(res.headers.get('Retry-After')).toBeTruthy();
  });

  it('returns 503 when the requestdl call itself returns a 521 text body', async () => {
    const torrent = {
      id: 79701944,
      hash: 'abc123',
      active: false,
      download_finished: true,
      download_present: true,
      download_state: 'cached',
      files: [
        { id: 11, name: 'Marineford 01.mkv', size: 341651778 },
        { id: 12, name: 'Marineford 06.mkv', size: 212022000 },
      ],
    };
    const fetchImpl = vi.fn()
      // findTorrent -> mylist
      .mockResolvedValueOnce(jsonResponse({ success: true, data: [torrent] }))
      // requestdl -> Cloudflare 521, no Location header
      .mockResolvedValueOnce(cfErrorResponse(521));

    const res = await handleResolve('abc123', 1, 'KEY', null, { ...NO_DELAY, fetchImpl, retries: 0 });
    expect(res.status).toBe(503);
  });

  it('still redirects normally when Torbox is healthy', async () => {
    const torrent = {
      id: 79701944,
      hash: 'abc123',
      active: false,
      download_finished: true,
      download_present: true,
      download_state: 'cached',
      files: [
        { id: 11, name: 'Marineford 01.mkv', size: 341651778 },
        { id: 12, name: 'Marineford 06.mkv', size: 212022000 },
      ],
    };
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ success: true, data: [torrent] }))
      .mockResolvedValueOnce({
        ok: false,
        status: 307,
        headers: { get: (h) => (h === 'Location' ? 'https://cdn.torbox/file.mkv' : null) },
        text: async () => '',
        json: async () => ({}),
      });

    const res = await handleResolve('abc123', 1, 'KEY', null, { ...NO_DELAY, fetchImpl, retries: 0 });
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe('https://cdn.torbox/file.mkv');
  });
});
