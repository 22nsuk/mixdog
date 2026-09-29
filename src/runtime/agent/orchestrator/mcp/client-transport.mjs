/**
 * mcp/client-transport.mjs — building the SDK transport a server config asks
 * for: autoDetect (port discovered from a live service), streamable HTTP, SSE,
 * WebSocket, or a stdio child.
 */
import { readServicePort } from '../../../shared/service-discovery.mjs';
import {
  AUTO_DETECT_PORTS,
  expandEnvVars,
  mcpUrlForLog,
  normalizeMcpTransportUrl,
  resolveMcpHttpHeaders,
  resolveMcpStdioEnvironment,
  resolveMcpTransportKind,
  scrubMcpConnectionMessage,
} from './client-config.mjs';

/**
 * Auto-detect: the port of a running service from its pid-validated discovery
 * advert. `advert` names it so a connect failure can distrust it — a pid-live
 * advert can point at a recycled-pid corpse port, and this transport has no
 * other health probe of its own.
 */
function resolveAutoDetectUrl(name, cfg) {
  const spec = AUTO_DETECT_PORTS[cfg.autoDetect];
  if (!spec) throw new Error(`Unknown autoDetect target: "${cfg.autoDetect}"`);
  const port = readServicePort(spec.discovery, { requirePid: false });
  if (!port) throw new Error(`autoDetect server "${name}": live service advert missing`);
  if (!Number.isFinite(port) || port < 1 || port > 65535) {
    throw new Error(`autoDetect server "${name}": invalid port value`);
  }
  return { url: `http://127.0.0.1:${port}${spec.endpoint}`, advert: { service: spec.discovery, port } };
}

function requestInitFor(cfg) {
  const headers = resolveMcpHttpHeaders(cfg);
  return headers && Object.keys(headers).length > 0 ? { requestInit: { headers } } : undefined;
}

/** Returns { transport, autoDetectAdvert }. */
export function createMcpTransport({ name, cfg, sdk, log }) {
  const { StdioClientTransport, StreamableHTTPClientTransport, SSEClientTransport, WebSocketClientTransport } = sdk;
  const kind = resolveMcpTransportKind(cfg);
  if (kind === 'autoDetect') {
    const { url, advert } = resolveAutoDetectUrl(name, cfg);
    log(`[mcp-client] Connecting "${name}" via autoDetect HTTP: ${url}\n`);
    return { transport: new StreamableHTTPClientTransport(new URL(url)), autoDetectAdvert: advert };
  }
  if (kind === 'http' || kind === 'sse') {
    const Transport = kind === 'http' ? StreamableHTTPClientTransport : SSEClientTransport;
    const url = normalizeMcpTransportUrl(expandEnvVars(String(cfg.url ?? '')), kind);
    const opts = requestInitFor(cfg);
    log(`[mcp-client] Connecting "${name}" via ${kind.toUpperCase()}: ${mcpUrlForLog(url)}\n`);
    return {
      transport: opts ? new Transport(new URL(url), opts) : new Transport(new URL(url)),
      autoDetectAdvert: null,
    };
  }
  if (kind === 'ws') {
    // WebSocketClientTransport ctor takes only a URL; headers are ignored.
    const url = normalizeMcpTransportUrl(expandEnvVars(String(cfg.url ?? '')), 'ws');
    log(`[mcp-client] Connecting "${name}" via WebSocket: ${mcpUrlForLog(url)}\n`);
    return { transport: new WebSocketClientTransport(new URL(url)), autoDetectAdvert: null };
  }
  if (kind === 'stdio') {
    const transport = new StdioClientTransport({
      command: expandEnvVars(String(cfg.command ?? '')),
      args: Array.isArray(cfg.args) ? expandEnvVars(cfg.args) : cfg.args,
      cwd: cfg.cwd,
      env: resolveMcpStdioEnvironment(cfg),
      stderr: cfg.stderr ?? 'pipe',
    });
    transport.stderr?.on?.('data', (chunk) => {
      log(`[mcp:${name}:stderr] ${scrubMcpConnectionMessage(chunk, cfg)}`);
    });
    return { transport, autoDetectAdvert: null };
  }
  throw new Error(
    `Invalid config for "${name}": need autoDetect, type (stdio/http/sse/ws), url (http), or command (stdio)`
  );
}
