/**
 * The MSG91 request is built by hand from a docs example, and nothing else
 * checks its shape until a real message fails to arrive. These tests pin the
 * payload (bare-digit numbers, `body_N` / `button_1` components, the optional
 * namespace) and the two ways MSG91 reports a refusal — an HTTP error, and a
 * 200 carrying `hasError: true`, which a status check alone would miss.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./usage", () => ({ recordUsage: vi.fn() }));

import { recordUsage } from "./usage";
import { WhatsAppUnavailableError, isWhatsAppConfigured, sendWhatsAppTemplate } from "./whatsapp";

const fetchMock = vi.fn();

const reply = (status: number, body: unknown) =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body }) as Response;

const send = () =>
  sendWhatsAppTemplate({
    to: "+919876543210",
    template: "admin_invite",
    body: ["Harit Patel", "Youth Convention 2026"],
    buttonUrl: "tok_123",
    usage: { endpoint: "whatsapp:admin_invite", userId: "u1" },
  });

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("MSG91_AUTH_KEY", "key_abc");
  vi.stubEnv("MSG91_WHATSAPP_NUMBER", "+91 99999 00000");
  vi.stubEnv("MSG91_WHATSAPP_NAMESPACE", "");
  vi.stubEnv("MSG91_WHATSAPP_LANGUAGE", "");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("isWhatsAppConfigured", () => {
  it("is false while the key is the .env.example placeholder", () => {
    vi.stubEnv("MSG91_AUTH_KEY", "replace-me");
    expect(isWhatsAppConfigured()).toBe(false);
  });

  it("is false without a sending number", () => {
    vi.stubEnv("MSG91_WHATSAPP_NUMBER", "");
    expect(isWhatsAppConfigured()).toBe(false);
  });
});

describe("sendWhatsAppTemplate", () => {
  it("refuses before any request when not configured", async () => {
    vi.stubEnv("MSG91_AUTH_KEY", "replace-me");
    await expect(send()).rejects.toBeInstanceOf(WhatsAppUnavailableError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends the template in MSG91's shape", async () => {
    fetchMock.mockResolvedValue(reply(200, { status: "success", hasError: false }));
    await send();

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.msg91.com/api/v5/whatsapp/whatsapp-outbound-message/bulk/");
    expect(init.headers.authkey).toBe("key_abc");
    expect(JSON.parse(init.body)).toEqual({
      integrated_number: "919999900000",
      content_type: "template",
      payload: {
        messaging_product: "whatsapp",
        type: "template",
        template: {
          name: "admin_invite",
          language: { code: "en", policy: "deterministic" },
          to_and_components: [
            {
              to: ["919876543210"],
              components: {
                body_1: { type: "text", value: "Harit Patel" },
                body_2: { type: "text", value: "Youth Convention 2026" },
                button_1: { subtype: "url", type: "text", value: "tok_123" },
              },
            },
          ],
        },
      },
    });
    expect(recordUsage).toHaveBeenCalledWith(
      expect.objectContaining({ endpoint: "whatsapp:admin_invite", userId: "u1" })
    );
  });

  it("includes the namespace only when one is set", async () => {
    vi.stubEnv("MSG91_WHATSAPP_NAMESPACE", "ns_1");
    fetchMock.mockResolvedValue(reply(200, { status: "success" }));
    await send();
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).payload.template.namespace).toBe("ns_1");
  });

  it("treats a 200 with hasError as a failure", async () => {
    fetchMock.mockResolvedValue(reply(200, { hasError: true, errors: "Template not approved" }));
    await expect(send()).rejects.toThrow("Template not approved");
    expect(recordUsage).not.toHaveBeenCalled();
  });

  it("treats an HTTP error with no JSON body as a failure", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 502,
      json: async () => {
        throw new SyntaxError("not json");
      },
    } as unknown as Response);
    await expect(send()).rejects.toThrow("HTTP 502");
  });
});
