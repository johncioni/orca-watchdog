#!/usr/bin/env node
// Loopback Statuspage stub for E2E: answers a scripted sequence of indicators
// (last value repeats). Usage: node status-stub.mjs <port> major,none
import http from 'node:http';

export function startStub(port, sequence) {
  let i = 0;
  const server = http.createServer((req, res) => {
    const indicator = sequence[Math.min(i++, sequence.length - 1)];
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ page: { name: 'stub' }, status: { indicator, description: indicator } }));
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve({
    port: server.address().port,
    close: () => new Promise((r) => server.close(r)),
  })));
}

export function startGcpStub(port, product, sequence) {
  let i = 0;
  const server = http.createServer((req, res) => {
    const state = sequence[Math.min(i++, sequence.length - 1)];
    const incident = {
      id: 'stub-incident', number: '1', begin: '2026-09-15T12:00:00+00:00',
      created: '2026-09-15T12:01:00+00:00',
      end: state === 'open' ? null : '2026-09-15T13:00:00+00:00',
      modified: '2026-09-15T13:01:00+00:00', external_desc: 'Stub incident', updates: [],
      most_recent_update: { created: '2026-09-15T12:01:00+00:00', modified: '2026-09-15T13:01:00+00:00',
        when: '2026-09-15T13:01:00+00:00', text: 'Stub update', status: state === 'open' ? 'SERVICE_DISRUPTION' : 'AVAILABLE' },
      status_impact: 'SERVICE_DISRUPTION', severity: 'medium', service_key: 'stub', service_name: 'Stub',
      affected_products: [{ title: product, id: 'stub-product', current_title: product }],
      uri: 'https://status.cloud.google.com/incidents/stub-incident',
      currently_affected_locations: [], previously_affected_locations: [],
    };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(state === 'none' ? [] : [incident]));
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve({
    port: server.address().port,
    close: () => new Promise((r) => server.close(r)),
  })));
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const [port, mode, product, gcpSeq] = process.argv.slice(2);
  if (mode === '--gcp') {
    const stub = await startGcpStub(Number(port), product, gcpSeq.split(','));
    console.log(`status stub on http://127.0.0.1:${stub.port}/incidents.json serving ${gcpSeq}`);
  } else {
    const stub = await startStub(Number(port), mode.split(','));
    console.log(`status stub on http://127.0.0.1:${stub.port}/api/v2/status.json serving ${mode}`);
  }
}
