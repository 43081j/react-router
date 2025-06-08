import type { RequestListener, IncomingMessage, ServerResponse } from "node:http";
import { TLSSocket } from "node:tls";

import type {
  AppLoadContext,
  ServerBuild,
  UNSAFE_MiddlewareEnabled,
  unstable_InitialContext,
} from "react-router";
import { createRequestHandler } from "react-router";
import type { ClientAddress } from "@mjackson/node-fetch-server";
import { createRequestListener as createRequestListener_ } from "@mjackson/node-fetch-server";
import { createReadableStreamFromReadable, writeReadableStreamToWritable } from "./stream";

type MaybePromise<T> = T | Promise<T>;

export interface RequestListenerOptions {
  build: ServerBuild | (() => ServerBuild | Promise<ServerBuild>);
  getLoadContext?: (
    request: Request,
    client: ClientAddress
  ) => UNSAFE_MiddlewareEnabled extends true
    ? MaybePromise<unstable_InitialContext>
    : MaybePromise<AppLoadContext>;
  mode?: string;
}

/**
 * Creates a request listener that handles requests using Node's built-in HTTP server.
 *
 * @param options Options for creating a request listener.
 * @returns A request listener that can be used with `http.createServer`.
 */
export function createRequestListener(
  options: RequestListenerOptions
): RequestListener {
  let handleRequest = createRequestHandler(options.build, options.mode);

  return createRequestListener_(async (request, client) => {
    let loadContext = await options.getLoadContext?.(request, client);
    return handleRequest(request, loadContext);
  });
}

export type RequestHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  next: (err?: unknown) => void
) => Promise<void>;

export function createMiddleware(
  options: RequestListenerOptions
): RequestHandler {
  let handleRequest = createRequestHandler(options.build, options.mode);

  return async (
    req: IncomingMessage,
    res: ServerResponse,
    next: (err?: unknown) => void
  ) => {
    try {
      let request = createRemixRequest(req, res);
      let loadContext = await options.getLoadContext?.(req, res);

      let response = await handleRequest(request, loadContext);

      await sendRemixResponse(res, response);
    } catch (error: unknown) {
      // Express doesn't support async functions, so we have to pass along the
      // error manually using next().
      next(error);
    }
  };
}

export function createRemixRequest(
  req: IncomingMessage,
  res: ServerResponse
): Request {
  // req.hostname doesn't include port information so grab that from
  // `X-Forwarded-Host` or `Host`
  let [, hostnamePortStr] =
    typeof req.headers["X-Forwarded-Host"] === "string"
      ? req.headers["X-Forwarded-Host"].split(":")
      : [];
  let [, hostPortStr] = req.headers["host"]?.split(":") ?? [];
  let hostnamePort = Number.parseInt(hostnamePortStr, 10);
  let hostPort = Number.parseInt(hostPortStr, 10);
  let port = Number.isSafeInteger(hostnamePort)
    ? hostnamePort
    : Number.isSafeInteger(hostPort)
    ? hostPort
    : "";
  // Use req.hostname here as it respects the "trust proxy" setting
  const protocol = req.socket instanceof TLSSocket ? "https" : "http";
  const requestUrl = new URL(
    `${protocol}://${req.headers.host}${req.url ?? ""}`
  );
  let resolvedHost = `${requestUrl.hostname}${port ? `:${port}` : ""}`;
  // Use `req.originalUrl` so Remix is aware of the full path
  let url = new URL(`${protocol}://${resolvedHost}${req.url}`);

  // Abort action/loaders once we can no longer write a response
  let controller: AbortController | null = new AbortController();
  let init: RequestInit = {
    method: req.method,
    headers: createRemixHeaders(req.headers),
    signal: controller.signal,
  };

  // Abort action/loaders once we can no longer write a response iff we have
  // not yet sent a response (i.e., `close` without `finish`)
  // `finish` -> done rendering the response
  // `close` -> response can no longer be written to
  res.on("finish", () => (controller = null));
  res.on("close", () => controller?.abort());

  if (req.method !== "GET" && req.method !== "HEAD") {
    init.body = createReadableStreamFromReadable(req);
    (init as { duplex: "half" }).duplex = "half";
  }

  return new Request(url.href, init);
}

function createRemixHeaders(
  requestHeaders: IncomingMessage["headers"]
): Headers {
  let headers = new Headers();

  for (let [key, values] of Object.entries(requestHeaders)) {
    if (values) {
      if (Array.isArray(values)) {
        for (let value of values) {
          headers.append(key, value);
        }
      } else {
        headers.set(key, values);
      }
    }
  }

  return headers;
}

async function sendRemixResponse(
  res: ServerResponse,
  nodeResponse: Response
): Promise<void> {
  res.statusMessage = nodeResponse.statusText;
  res.statusCode = nodeResponse.status;

  for (let [key, value] of nodeResponse.headers.entries()) {
    res.appendHeader(key, value);
  }

  if (nodeResponse.headers.get("Content-Type")?.match(/text\/event-stream/i)) {
    res.flushHeaders();
  }

  if (nodeResponse.body) {
    await writeReadableStreamToWritable(nodeResponse.body, res);
  } else {
    res.end();
  }
}
