import type { OpenGlassClient } from "./client.js";

export interface WitnessOptions {
  client: OpenGlassClient;
  sessionId: string;
  contentType?: string;
}

/**
 * Wraps an existing "send" function so every call is witnessed by OpenGlass first —
 * same call signature, same return value, zero changes to your own send logic or its
 * caller. The message is signed and posted to OpenGlass *before* `send` actually runs,
 * so a witnessed record exists even if delivery itself then fails.
 *
 * ```js
 * const send = witness(rawSendToCounterparty, { client, sessionId });
 * await send({ text: "hello" }); // witnessed, then delivered exactly like rawSendToCounterparty did
 * ```
 */
export function witness<Args extends unknown[], Ret>(
  send: (...args: Args) => Ret | Promise<Ret>,
  opts: WitnessOptions,
): (...args: Args) => Promise<Ret> {
  return async (...args: Args): Promise<Ret> => {
    const payload = args.length === 1 ? args[0] : args;
    await opts.client.sendMessage(opts.sessionId, payload, { contentType: opts.contentType });
    return send(...args);
  };
}
