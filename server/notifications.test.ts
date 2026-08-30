import { describe, expect, test } from "bun:test";

import { notifyAccessRequest } from "./notifications";

describe("access request notifications", () => {
  test("sends the pending request to the configured internal endpoint", async () => {
    let received: { url: string; init?: RequestInit } | undefined;
    const fetcher = (async (input, init) => {
      received = { url: String(input), init };
      return new Response(null, { status: 204 });
    }) as typeof fetch;

    const sent = await notifyAccessRequest(
      {
        githubLogin: "new-user",
        deviceName: "New User's Mac",
        reviewUrl: "https://media.hsichen.dev/admin",
      },
      {
        url: "http://bot-core:3000/api/internal/media-access-request",
        secret: "notification-secret",
      },
      fetcher,
    );

    expect(sent).toBe(true);
    expect(received?.url).toBe(
      "http://bot-core:3000/api/internal/media-access-request",
    );
    expect(received?.init?.headers).toEqual({
      Authorization: "Bearer notification-secret",
      "Content-Type": "application/json",
    });
    expect(JSON.parse(String(received?.init?.body))).toEqual({
      githubLogin: "new-user",
      deviceName: "New User's Mac",
      reviewUrl: "https://media.hsichen.dev/admin",
    });
  });

  test("stays disabled when no internal endpoint is configured", async () => {
    const sent = await notifyAccessRequest(
      {
        githubLogin: "new-user",
        deviceName: "New User's Mac",
        reviewUrl: "https://media.hsichen.dev/admin",
      },
      { url: "", secret: "" },
    );

    expect(sent).toBe(false);
  });
});
