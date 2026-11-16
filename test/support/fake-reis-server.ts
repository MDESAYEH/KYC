import {
  createServer,
  IncomingHttpHeaders,
  IncomingMessage,
  Server,
  ServerResponse,
} from 'node:http';
import { AddressInfo } from 'node:net';

export interface RecordedRequest {
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
  rawBody: string;
  json: unknown;
}

export interface FakeReply {
  status?: number;
  /** Object is JSON-encoded; string is sent verbatim (to simulate invalid JSON). */
  body?: unknown;
  /** Delay before replying (to trigger client timeouts). */
  delayMs?: number;
  /** Destroy the socket instead of replying. */
  destroySocket?: boolean;
}

type Handler = (req: RecordedRequest, issuedTokens: string[]) => FakeReply;

/**
 * In-process fake of the REIS API (127.0.0.1, random port). Issues a distinct token for every
 * authenticate call and, by default, only accepts onboarding requests carrying an issued token
 * in `x-auth-token`. Never contacts a real REIS environment.
 */
export class FakeReisServer {
  readonly requests: RecordedRequest[] = [];
  readonly issuedTokens: string[] = [];
  authHandler: Handler = () => ({ status: 200, body: { token: this.nextToken() } });
  onboardingHandler: Handler = (req, tokens) =>
    tokens.includes(String(req.headers['x-auth-token']))
      ? { status: 200, body: { status: 'CLEAN', reisId: 'R-1', riskCalculationId: 'RC-1' } }
      : { status: 401, body: { message: 'bad token' } };

  private server!: Server;
  private counter = 0;
  baseUrl = '';

  nextToken(): string {
    const token = `fake-token-${++this.counter}`;
    this.issuedTokens.push(token);
    return token;
  }

  async start(): Promise<void> {
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    this.baseUrl = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  requestsTo(path: string): RecordedRequest[] {
    return this.requests.filter((r) => r.path === path);
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const rawBody = Buffer.concat(chunks).toString('utf8');
    let json: unknown;
    try {
      json = JSON.parse(rawBody);
    } catch {
      json = undefined;
    }
    const recorded: RecordedRequest = {
      method: req.method ?? '',
      path: req.url ?? '',
      headers: req.headers,
      rawBody,
      json,
    };
    this.requests.push(recorded);

    let reply: FakeReply;
    if (recorded.path === '/xauth/authenticate/')
      reply = this.authHandler(recorded, this.issuedTokens);
    else if (recorded.path === '/onboarding/v2/searchOnboardCustomer')
      reply = this.onboardingHandler(recorded, this.issuedTokens);
    else reply = { status: 404, body: {} };

    if (reply.delayMs) await new Promise((r) => setTimeout(r, reply.delayMs));
    if (reply.destroySocket) {
      req.socket.destroy();
      return;
    }
    const text = typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body ?? {});
    res.writeHead(reply.status ?? 200, { 'Content-Type': 'application/json' });
    res.end(text);
  }
}
